"""Execution engine (§6, §7): executes an automation's steps as subprocesses,
streams status/logs, enforces policies, persists everything file-first."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from . import keychain, notify, packages as pkglib
from .events import hub
from .executor import CTRL
from .storage import SECRET_REF_RE, Store, resolve_param_value

STEP_TIMEOUT = 15 * 60  # per-step hard cap (seconds); override via AUTODAVE_STEP_TIMEOUT


def _step_timeout() -> float:
    try:
        return float(os.environ.get("AUTODAVE_STEP_TIMEOUT", "") or STEP_TIMEOUT)
    except ValueError:
        return STEP_TIMEOUT


# §7 failure diagnostics: exception types that read as "the network failed".
_NET_TYPES = {
    "ConnectionError", "ConnectionRefusedError", "ConnectionResetError",
    "ConnectError", "ConnectTimeout", "ReadTimeout", "Timeout", "TimeoutError",
    "timeout", "gaierror", "URLError", "NewConnectionError", "MaxRetryError",
    "SSLError", "ProxyError", "ChunkedEncodingError", "RemoteDisconnected",
}


def failure_reason(rc: int, err: dict | None) -> str | None:
    """Classify a failed step into a plain-word possible reason (§7) —
    deterministic, from exit code + the executor's structured error event;
    None when the failure fits no known category."""
    if rc == 4:
        return "The step imports a package outside the allowed list."
    if rc == 3:
        return "The script references a secret that doesn't exist."
    t = (err or {}).get("type") or ""
    m = (err or {}).get("message") or ""
    if t == "AgentCallError":
        return "The step's agent call failed — the agent may be unreachable or misconfigured."
    if t in ("HTTPError", "HTTPStatusError") or "Client Error" in m or "Server Error" in m:
        code = re.search(r"\b([45]\d\d)\b", m)
        return (f"The site answered with an error (HTTP {code.group(1)})." if code
                else "The site answered with an error.")
    if t in _NET_TYPES or "couldn't fetch" in m or "robots.txt disallows" in m:
        return "A network request failed — the site may be down, blocking, or unreachable."
    if t in ("KeyError", "IndexError", "AttributeError"):
        return "The data didn't have the expected shape — a page or file layout may have changed."
    return None


def run_step_process(script: Path, ctx: dict, state: dict, log, result: dict,
                     holder: dict) -> int:
    """One step as a §6.1 executor subprocess — shared by real executions and
    §11 tests. Streams control lines: `log(k, text)` gets every log line,
    `result` collects §4.5 result ops, `holder` gets error/notify/result_touched.
    `state['proc']` holds the live Popen so a caller can cancel."""
    proc = subprocess.Popen(
        [sys.executable, "-m", "autodave.executor", str(script)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    state["proc"] = proc
    try:
        proc.stdin.write(json.dumps(ctx))
        proc.stdin.close()
    except BrokenPipeError:
        pass
    # Watchdog enforces the per-step timeout even when the step produces no
    # output at all (a bare read loop would block forever on a silent hang).
    timeout_s = _step_timeout()
    timed_out = threading.Event()

    def _on_timeout() -> None:
        timed_out.set()
        if proc.poll() is None:
            proc.kill()

    watchdog = threading.Timer(timeout_s, _on_timeout)
    watchdog.daemon = True
    watchdog.start()
    for raw in proc.stdout:  # type: ignore[union-attr]
        if timed_out.is_set():
            break
        line = raw.rstrip("\n")
        if line.startswith(CTRL):
            try:
                msg = json.loads(line[len(CTRL):])
            except ValueError:
                continue
            op = msg.get("op")
            if op == "log":
                log(msg.get("k", "out"), msg.get("text", ""))
            elif op == "result":
                holder["result_touched"] = True
                f, v = msg.get("field"), msg.get("value")
                if f == "status":
                    result["status"] = v
                elif f == "chip":
                    result["chip"] = v
                elif f == "chips":
                    result["chips"] = v
                elif f == "value":
                    result["values"].append(v)
            elif op == "notify":
                holder["text"] = msg.get("text")
            elif op == "error":
                # §7 failure diagnostics — the executor's structured report
                # of the exception that failed the step.
                holder["error"] = {"type": msg.get("type"),
                                   "message": msg.get("message")}
            elif op == "agent_audit":
                # §6: the FULL redacted prompt/response go to logs for audit
                # (the 200k prompt/reply size caps already apply upstream).
                log("sys", f"agent prompt: {msg.get('prompt', '')}")
                log("sys", f"agent reply: {msg.get('reply', '')}")
        elif line.strip():
            log("out", line)
    proc.wait()
    watchdog.cancel()
    state["proc"] = None
    if timed_out.is_set() and proc.returncode != 0:
        msg = f"step timed out after {int(timeout_s)}s"
        log("err", msg)
        holder["error"] = {"type": "StepTimeout", "message": msg,
                           "reason": f"The step hit its {int(timeout_s)} s time limit."}
        return proc.returncode or 1
    return proc.returncode or 0


class Engine:
    def __init__(self, store: Store):
        self.store = store
        self._live: dict[str, dict] = {}  # exec_id → {proc, cancel, thread}
        self._lock = threading.Lock()
        self.on_finished = None  # set by the scheduler (retry-once hook)

    # ---------- public ----------
    def start(self, auto: dict, trigger: str, version_label: str | None = None) -> dict:
        """Create the execution record and execute it on a worker thread (§7)."""
        if auto.get("_live"):
            raise RuntimeError("already executing")
        ver_label = version_label or f"v{auto['current_version']}"
        if ver_label.lower() == "draft":  # §19 accepts "draft"; canonical label is "Draft"
            ver_label = "Draft"
        ver = self._resolve_version(auto, ver_label)
        if ver is None:
            raise RuntimeError(f"version {ver_label} not found")
        # §6.3 pre-version snapshot: first execution of a real version with no recorded
        # execution yet — memory as the previous version left it, restorable after rollback.
        if ver_label != "Draft" and not any(
                x["auto_id"] == auto["id"] and x["ver"] == ver_label
                for x in self.store.execs.values()):
            self.store.snapshot_memory(auto, "pre-version", version=ver_label)
        steps = [{"name": s["name"], "file": s.get("file"), "agent": bool(s.get("agent")),
                  "status": "queued", "dur_ms": None, "attempts": []} for s in ver["steps"]]
        # §7: snapshot the resolved param values — the execution page shows them as used by this execution.
        h = self.store.create_execution(auto, ver_label, trigger, steps,
                                        params=self.store.merged_params(auto, ver))
        return self._launch(auto, ver, h)

    def retry(self, auto: dict, h: dict) -> dict:
        """§7 in-place retry: the same execution record re-executes from the
        failed step as a new attempt; succeeded/skipped steps are untouched."""
        if auto.get("_live"):
            raise RuntimeError("already executing")
        if h["status"] != "failed":
            raise RuntimeError("only failed executions can be retried")
        ver = self._resolve_version(auto, h["ver"])
        if ver is None:
            raise RuntimeError(f"version {h['ver']} not found")
        full = self.store.exec_full(h["id"])
        if full is None:
            raise RuntimeError("execution not found")
        h = full
        self.store.execs[h["id"]] = h  # the live in-memory record is the full one
        for s in h["steps"]:
            if s["status"] == "failed":
                s["status"] = "queued"
        h["status"] = "executing"
        h["finished_at"] = None
        h["error"] = None
        h["chip"] = None
        h["chip_status"] = None
        idx = next((i for i, s in enumerate(h["steps"]) if s["status"] == "queued"), None)
        if idx is not None:
            n = len(h["steps"][idx].get("attempts", [])) + 1
            self._log(h, "sys", f"retrying from step {idx + 1} — attempt {n}", {})
        self.store.update_execution(h)
        return self._launch(auto, ver, h)

    def _launch(self, auto: dict, ver: dict, h: dict) -> dict:
        state = {"proc": None, "cancel": False}
        t = threading.Thread(target=self._execute, args=(auto, ver, h, state), daemon=True)
        state["thread"] = t
        with self._lock:
            self._live[h["id"]] = state
        hub.publish("exec.started", exec_=None, execId=h["id"], autoId=auto["id"],
                    exec_json=self.store.exec_json(h))
        t.start()
        return h

    def cancel(self, exec_id: str) -> bool:
        with self._lock:
            state = self._live.get(exec_id)
        if not state:
            return False
        state["cancel"] = True
        proc = state.get("proc")
        if proc and proc.poll() is None:
            proc.terminate()
        return True

    def skip_step(self, exec_id: str, index: int) -> bool:
        """§7 skip: kill the currently executing step and continue with the
        next one. False unless `index` is the step executing right now."""
        with self._lock:
            state = self._live.get(exec_id)
            if not state:
                return False
            h = self.store.execs.get(exec_id)
            cur = (h or {}).get("_cur")
            if not cur or cur["i"] != index:
                return False
            state["skip"] = index
            proc = state.get("proc")
        if proc and proc.poll() is None:
            proc.terminate()
        return True

    def is_live(self, exec_id: str) -> bool:
        with self._lock:
            return exec_id in self._live

    # ---------- internals ----------
    def _resolve_version(self, auto: dict, label: str) -> dict | None:
        if label.lower() == "draft":  # §19: accept "draft"/"Draft" case-insensitively
            return auto.get("draft")
        try:
            return auto["versions"].get(int(label.lstrip("v")))
        except ValueError:
            return None

    def _version_dir(self, auto: dict, label: str) -> Path:
        base = self.store.auto_dir(auto)
        return base / "draft" / "automation" if label.lower() == "draft" else base / "versions" / label

    def _memory_dir(self, auto: dict, label: str) -> Path:
        """§4.4: Draft executions get the draft's own memory — the live dir is
        never handed to a draft step."""
        base = self.store.auto_dir(auto)
        return base / "draft" / "memory" if label.lower() == "draft" else base / "memory"

    def _redact(self, h: dict, text: str, redactions: dict[str, str]) -> str:
        for val, name in redactions.items():
            if val and val in text:
                text = text.replace(val, "•••")
                if name not in h["redacted"]:
                    h["redacted"].append(name)
        return text

    def _log(self, h: dict, k: str, text: str, redactions: dict[str, str]) -> None:
        text = self._redact(h, text, redactions)
        cur = h.get("_cur")
        name = cur["log"] if cur else self.store.EXEC_LOG
        # Per-file monotonic seq (§5) — resumed by counting existing lines, so a
        # retried execution's execution.ndjson keeps a gapless sequence.
        seqs = h.setdefault("_log_seq", {})
        if name not in seqs:
            p = self.store.log_file(h["id"], name)
            seqs[name] = sum(1 for _ in p.open(encoding="utf-8")) if p.exists() else 0
        seqs[name] += 1
        # On-disk shape (§5): {ts, t, k, seq, text} — the owning step/attempt is
        # implicit in the filename. API/UI shape is {t, k, seq, text}.
        line = {"ts": datetime.now().isoformat(timespec="seconds"),
                "t": datetime.now().strftime("%H:%M:%S"),
                "k": k, "seq": seqs[name], "text": text}
        self.store.append_log_line(h["id"], name, line)
        hub.publish("exec.log", execId=h["id"], autoId=h["auto_id"],
                    stepIndex=cur["i"] if cur else None,
                    attempt=cur["n"] if cur else None,
                    line={"t": line["t"], "k": k, "seq": line["seq"], "text": text})

    def _step_event(self, h: dict, i: int) -> None:
        self.store.update_execution(h)
        s = h["steps"][i]
        from .timefmt import dur_label

        hub.publish("exec.step", execId=h["id"], autoId=h["auto_id"], index=i,
                    step={"name": s["name"], "status": s["status"],
                          "dur": dur_label(s["dur_ms"]) if s.get("dur_ms") else "",
                          "attempts": self.store.step_attempts_json(s)})

    def _execute(self, auto: dict, ver: dict, h: dict, state: dict) -> None:
        # §4.4: a draft carries its own grant selections — a Draft execution
        # honors them instead of the automation's live grants. Shadow copy only;
        # the stored automation is never touched.
        if ver.get("step_agents") is not None or ver.get("allowed_secrets") is not None:
            auto = {**auto,
                    "enabled_agents": ver["step_agents"] if ver.get("step_agents") is not None
                    else auto["enabled_agents"],
                    "allowed_secrets": ver["allowed_secrets"] if ver.get("allowed_secrets") is not None
                    else auto["allowed_secrets"]}
        state["pass_start"] = time.time()  # §7: dur_ms accumulates across retry passes
        result: dict[str, Any] = {"status": "ok", "chip": None, "chips": [], "values": []}
        result_touched = False
        notify_text: str | None = None
        caffeinate = None
        try:
            caffeinate = subprocess.Popen(["caffeinate", "-i"],
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:  # noqa: BLE001
            pass
        redactions: dict[str, str] = {}
        failed = False
        try:
            # §6: a missing secret stops the execution before any step.
            needed: set[str] = set()
            for s in ver["steps"]:
                needed |= set(SECRET_REF_RE.findall(s.get("code", "")))
            secret_values: dict[str, str] = {}
            for name in sorted(needed):
                if name not in auto["allowed_secrets"]:
                    msg = f"secret {name} isn't allowed for this automation — the execution can't start"
                    self._log(h, "err", msg, {})
                    if not h.get("error"):
                        h["error"] = {"step": None, "message": msg,
                                      "reason": "A step references a secret this automation isn't allowed to use."}
                    failed = True
                else:
                    v = keychain.get_secret(name)
                    if v is None:
                        msg = f"secret {name} isn't in your Keychain — the execution can't start"
                        self._log(h, "err", msg, {})
                        if not h.get("error"):
                            h["error"] = {"step": None, "message": msg,
                                          "reason": "A step references a secret that isn't in your Keychain."}
                        failed = True
                    else:
                        secret_values[name] = v
            # Log lines are redacted one at a time, so a multi-line value can
            # never match whole — redact each of its lines individually too.
            redactions = {v: k for k, v in secret_values.items()}
            for name, v in secret_values.items():
                if "\n" in v:
                    for part in v.splitlines():
                        if part.strip():
                            redactions.setdefault(part, name)

            # §7: ensure the version's declared packages (§6.2) before step 1 —
            # the fast check costs milliseconds when everything is present;
            # self-heals after an app update or a cleared site-packages dir.
            declared = ver.get("packages") or []
            if declared and not failed:
                missing = [p for p in pkglib.check(declared) if p["status"] != "installed"]
                if missing:
                    self._log(h, "sys", "installing packages: "
                              + ", ".join(p["pip"] for p in missing), redactions)
                    bad = [p for p in pkglib.ensure(declared) if p["status"] != "installed"]
                    if bad:
                        msg = "; ".join(f"{p['pip']}: {p.get('error') or 'install failed'}"
                                        for p in bad)
                        self._log(h, "err", f"package install failed — {msg}", redactions)
                        h["error"] = {"step": None, "message": self._redact(h, msg, redactions),
                                      "reason": "A required package couldn't be installed — check "
                                                "your connection, then execute again or retry from "
                                                "the edit page."}
                        failed = True

            params = {p["name"]: resolve_param_value(p, auto["param_values"])
                      for p in ver.get("params", [])}
            warns: list[str] = []
            for p in ver.get("params", []):
                resolve_param_value(p, auto["param_values"], warns)
            for w in warns:
                self._log(h, "wrn", w, redactions)

            # §4.4: first Draft execution seeds draft/memory as a copy of the
            # live memory; later Draft executions (and draft re-saves) reuse it.
            if h["ver"] == "Draft" and not failed:
                dmem = self._memory_dir(auto, "Draft")
                if not dmem.exists():
                    live_mem = self.store.auto_dir(auto) / "memory"
                    if live_mem.exists() and any(live_mem.iterdir()):
                        shutil.copytree(live_mem, dmem)
                        self._log(h, "sys", "draft memory created — copied from the automation's memory", redactions)
                    else:
                        dmem.mkdir(parents=True, exist_ok=True)

            vdir = self._version_dir(auto, h["ver"])
            for i, s in enumerate(ver["steps"]):
                step = h["steps"][i]
                if step["status"] in ("succeeded", "skipped"):
                    continue  # §7 retry: terminal steps from an earlier pass never re-execute
                if failed or state["cancel"]:
                    step["status"] = "cancelled" if state["cancel"] else "queued"
                    self._step_event(h, i)
                    continue
                n = len(step["attempts"]) + 1
                attempt = {"n": n, "status": "executing",
                           "started_at": datetime.now().isoformat(timespec="seconds"),
                           "dur_ms": None}
                step["attempts"].append(attempt)
                step["status"] = "executing"
                step["dur_ms"] = None
                h["_cur_step"] = s["name"]  # engine-error fallback for §4.5 error.step
                h["_cur"] = {"i": i, "n": n,
                             "log": self.store.log_name(step.get("file"), i, n)}
                self._step_event(h, i)
                self._log(h, "sys", f"▸ Step {i + 1} — {s['name']}", redactions)
                t0 = time.time()
                agent_cfg = None
                rc = 1
                notify_holder: dict = {}
                if s.get("agent"):
                    agent_cfg = self._agent_for_step(auto, s)
                    if agent_cfg is None:
                        msg = f"Step {i + 1} needs an agent, but none is enabled — the execution fails here."
                        self._log(h, "err", msg, redactions)
                        notify_holder["error"] = {
                            "message": msg,
                            "reason": "No enabled agent can serve this step — enable one for this automation."}
                if not (s.get("agent") and agent_cfg is None):
                    rc = self._execute_step(auto, ver, h, s, i + 1, vdir, params, secret_values,
                                            agent_cfg, state, redactions, result, notify_holder)
                if notify_holder.get("text"):
                    notify_text = notify_holder["text"]
                if notify_holder.get("result_touched"):
                    result_touched = True
                dur = int((time.time() - t0) * 1000)
                step["dur_ms"] = dur
                attempt["dur_ms"] = dur
                skip = state.pop("skip", None)
                if state["cancel"]:
                    status = "cancelled"
                    self._log(h, "sys", "execution cancelled by you — nothing else will happen", redactions)
                elif rc == 0:
                    status = "succeeded"
                    if skip == i:
                        self._log(h, "sys", "skip arrived after the step finished", redactions)
                elif skip == i:
                    status = "skipped"
                    self._log(h, "sys", "step skipped by you — continuing with the next step", redactions)
                else:
                    status = "failed"
                    failed = True
                    # §7 failure diagnostics: the executor's structured error
                    # event (or the engine's own, e.g. a timeout) becomes the
                    # execution's error — message redacted like any log line.
                    err = notify_holder.get("error")
                    message = self._redact(h, (err or {}).get("message")
                                           or f"step failed (exit code {rc})", redactions)
                    reason = (err or {}).get("reason") or failure_reason(rc, err)
                    attempt["error"] = {"message": message, "reason": reason}
                    h["error"] = {"step": s["name"], "message": message, "reason": reason}
                step["status"] = status
                attempt["status"] = status
                self._step_event(h, i)
                h["_cur_step"] = None
                h["_cur"] = None
            # ---- finalize ----
            h["_cur_step"] = None
            h["_cur"] = None
            h["dur_ms"] = (h["dur_ms"] or 0) + int((time.time() - state["pass_start"]) * 1000)
            if state["cancel"]:
                h["status"] = "cancelled"
            elif failed:
                h["status"] = "failed"
                self._log(h, "sys", f"execution failed — see the step above", redactions)
            else:
                h["status"] = "succeeded"
            h["finished_at"] = datetime.now().isoformat(timespec="seconds")
            if result_touched and not state["cancel"]:
                # The chip is optional (§4.5): it lives on the execution header,
                # tinted by the execution's result status; result.yaml keeps chips/values.
                h["chip"] = result["chip"]
                h["chip_status"] = result["status"] if result["chip"] else None
                body = {k: v for k, v in result.items() if k in ("chips", "values") and v}
                if body:
                    self.store.write_result(h["id"], body)
            self.store.update_execution(h)
            self._notify_end(auto, h, result if result_touched else None, notify_text)
        except Exception as e:  # noqa: BLE001
            h["status"] = "failed"
            h["finished_at"] = datetime.now().isoformat(timespec="seconds")
            self._log(h, "err", f"engine error: {e}", redactions)
            if not h.get("error"):
                h["error"] = {"step": h.get("_cur_step"),
                              "message": self._redact(h, f"engine error: {e}", redactions),
                              "reason": None}
            self.store.update_execution(h)
        finally:
            if caffeinate:
                caffeinate.terminate()
            with self._lock:
                self._live.pop(h["id"], None)
            hub.publish("exec.finished", execId=h["id"], autoId=h["auto_id"],
                        exec_json=self.store.exec_json(h),
                        auto_json=self.store.auto_json(self.store.autos.get(h["auto_id"], {}), full=False)
                        if h["auto_id"] in self.store.autos else None)
            if self.on_finished:
                try:
                    self.on_finished(h)
                except Exception:  # noqa: BLE001
                    pass

    def _agent_for_step(self, auto: dict, s: dict) -> dict | None:
        agents = {a["id"]: a for a in self.store.agents}
        cand = s.get("agent_id") or s.get("agentId")
        if cand and cand in agents and cand in auto["enabled_agents"]:
            return agents[cand]
        for aid in auto["enabled_agents"]:
            if aid in agents:
                return agents[aid]
        return None

    def _execute_step(self, auto: dict, ver: dict, h: dict, s: dict, step_index: int, vdir: Path,
                  params: dict, secret_values: dict, agent_cfg: dict | None,
                  state: dict, redactions: dict, result: dict, notify_holder: dict) -> int:
        script = vdir / (s.get("file") or "")
        if not script.exists():
            msg = f"step script {s.get('file')} is missing"
            self._log(h, "err", msg, redactions)
            notify_holder["error"] = {"type": "MissingScript", "message": msg}
            return 1
        # §6 secret scoping: a step only receives the secrets its own source
        # references. The full value map stays engine-side for log redaction;
        # reading an uninjected secret raises in the executor and fails the execution.
        step_refs = set(SECRET_REF_RE.findall(s.get("code", "")))
        step_secrets = {k: v for k, v in secret_values.items() if k in step_refs}
        ctx = {
            "params": params,
            "secrets": step_secrets,
            "allowed_secrets": auto["allowed_secrets"],
            "site_packages": str(pkglib.site_packages_dir()),
            "package_imports": [p["import"] for p in ver.get("packages") or []],
            "memory_dir": str(self._memory_dir(auto, h["ver"])),
            "workspace": str(self.store.exec_dir(h["id"]) / "workspace"),
            "result_dir": str(self.store.exec_dir(h["id"]) / "result"),
            "agent": agent_cfg,
            "is_agent_step": bool(s.get("agent")),
            "agent_timeout": 120,
            "execution": {
                "automation_id": auto["id"],
                "automation_name": auto["name"],
                "id": h["id"],
                "step_index": step_index,
                "step_name": s["name"],
                "trigger": h["trigger"],
            },
        }
        return run_step_process(script, ctx, state,
                                lambda k, text: self._log(h, k, text, redactions),
                                result, notify_holder)

    def _notify_end(self, auto: dict, h: dict, result: dict | None, notify_text: str | None) -> None:
        """§6: at most one notification, at the end, per the §4.9 setting."""
        setting = self.store.settings.get("notif", "attention")
        status = h["status"]
        interesting = (
            status in ("failed", "interrupted")
            or (result or {}).get("status") in ("changes", "attention")
        )
        if setting == "all" or interesting:
            body = notify_text or (result or {}).get("chip") or \
                ("Execution failed" if status == "failed" else "Execution finished")
            title_param = None
            ver = self._resolve_version(auto, h["ver"]) or {}
            for p in ver.get("params", []):
                if p["name"] == "notification_title":
                    title_param = resolve_param_value(p, auto["param_values"]) or None
            notify.post(title_param or auto["name"], body)
