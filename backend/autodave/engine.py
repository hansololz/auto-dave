"""Execution engine (§6, §7): runs an automation's steps as subprocesses,
streams status/logs, enforces policies, persists everything file-first."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from . import keychain, notify
from .events import hub
from .runner import CTRL
from .storage import SECRET_REF_RE, Store, resolve_param_value

STEP_TIMEOUT = 15 * 60  # per-step hard cap (seconds); override via AUTODAVE_STEP_TIMEOUT


def _step_timeout() -> float:
    try:
        return float(os.environ.get("AUTODAVE_STEP_TIMEOUT", "") or STEP_TIMEOUT)
    except ValueError:
        return STEP_TIMEOUT


class Engine:
    def __init__(self, store: Store):
        self.store = store
        self._live: dict[str, dict] = {}  # exec_id → {proc, cancel, thread}
        self._lock = threading.Lock()
        self.on_finished = None  # set by the scheduler (retry-once hook)

    # ---------- public ----------
    def start(self, auto: dict, trigger: str, version_label: str | None = None,
              reuse_from: dict | None = None) -> dict:
        """Create the execution record and run it on a worker thread (§7)."""
        if auto.get("_live"):
            raise RuntimeError("already running")
        ver_label = version_label or f"v{auto['current_version']}"
        if ver_label.lower() == "draft":  # §19 accepts "draft"; canonical label is "Draft"
            ver_label = "Draft"
        ver = self._resolve_version(auto, ver_label)
        if ver is None:
            raise RuntimeError(f"version {ver_label} not found")
        steps = [{"name": s["name"], "status": "queued", "dur_ms": None} for s in ver["steps"]]
        start_idx = 0
        if reuse_from:
            start_idx = reuse_from["index"]
            for i in range(start_idx):
                steps[i]["status"] = "reused"
        # §7: snapshot the resolved param values — the execution page shows them as used by this run.
        h = self.store.create_execution(auto, ver_label, trigger, steps,
                                        params=self.store.merged_params(auto, ver))
        if reuse_from:
            src_ws = self.store.exec_dir(reuse_from["exec_id"]) / "workspace"
            dst_ws = self.store.exec_dir(h["id"]) / "workspace"
            if src_ws.exists():
                import shutil

                shutil.rmtree(dst_ws, ignore_errors=True)
                shutil.copytree(src_ws, dst_ws)
        state = {"proc": None, "cancel": False}
        t = threading.Thread(target=self._run, args=(auto, ver, h, start_idx, state), daemon=True)
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

    def rerun_from_failed(self, auto: dict, old: dict, trigger: str = "Manual") -> dict:
        """§7: earlier steps get `reused`, only the failed step onward re-executes."""
        idx = next((i for i, s in enumerate(old["steps"]) if s["status"] == "failed"), 0)
        return self.start(auto, trigger, version_label=old["ver"],
                          reuse_from={"exec_id": old["id"], "index": idx})

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
        return base / "draft" if label.lower() == "draft" else base / "versions" / label

    def _log(self, h: dict, k: str, text: str, redactions: dict[str, str]) -> None:
        for val, name in redactions.items():
            if val and val in text:
                text = text.replace(val, "•••")
                if name not in h["redacted"]:
                    h["redacted"].append(name)
        # On-disk shape (§5): {ts, t, step, k, text} — step is the current step
        # name or null for run-level lines. API/UI shape stays {t, k, text}.
        line = {"ts": datetime.now().isoformat(timespec="seconds"),
                "t": datetime.now().strftime("%H:%M:%S"),
                "step": h.get("_cur_step"), "k": k, "text": text}
        self.store.append_log(h["id"], line)
        hub.publish("exec.log", execId=h["id"], autoId=h["auto_id"],
                    line={"t": line["t"], "k": k, "text": text})

    def _step_event(self, h: dict, i: int) -> None:
        self.store.update_execution(h)
        s = h["steps"][i]
        from .timefmt import dur_label

        hub.publish("exec.step", execId=h["id"], autoId=h["auto_id"], index=i,
                    step={"name": s["name"], "status": s["status"],
                          "dur": dur_label(s["dur_ms"]) if s.get("dur_ms") else ""})

    def _run(self, auto: dict, ver: dict, h: dict, start_idx: int, state: dict) -> None:
        result: dict[str, Any] = {"status": "ok", "chip": None, "chips": [], "body": [], "rows": None}
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
            # §6: a missing secret stops the run before any step.
            needed: set[str] = set()
            for s in ver["steps"]:
                needed |= set(SECRET_REF_RE.findall(s.get("code", "")))
            secret_values: dict[str, str] = {}
            for name in sorted(needed):
                if name not in auto["allowed_secrets"]:
                    self._log(h, "err", f"secret {name} isn't allowed for this automation — the run can't start", {})
                    failed = True
                else:
                    v = keychain.get_secret(name)
                    if v is None:
                        self._log(h, "err", f"secret {name} isn't in your Keychain — the run can't start", {})
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

            params = {p["name"]: resolve_param_value(p, auto["param_values"])
                      for p in ver.get("params", [])}
            warns: list[str] = []
            for p in ver.get("params", []):
                resolve_param_value(p, auto["param_values"], warns)
            for w in warns:
                self._log(h, "wrn", w, redactions)

            vdir = self._version_dir(auto, h["ver"])
            for i, s in enumerate(ver["steps"]):
                if i < start_idx:
                    continue
                if failed or state["cancel"]:
                    h["steps"][i]["status"] = "cancelled" if state["cancel"] else "queued"
                    self._step_event(h, i)
                    continue
                h["steps"][i]["status"] = "running"
                h["_cur_step"] = s["name"]  # stamped onto every log line of this step
                self._step_event(h, i)
                self._log(h, "sys", f"▸ Step {i + 1} — {s['name']}", redactions)
                t0 = time.time()
                agent_cfg = None
                if s.get("agent"):
                    agent_cfg = self._agent_for_step(auto, s)
                    if agent_cfg is None:
                        self._log(h, "err", f"Step {i + 1} needs an agent, but none is enabled — the run fails here.", redactions)
                        h["steps"][i]["status"] = "failed"
                        h["steps"][i]["dur_ms"] = int((time.time() - t0) * 1000)
                        self._step_event(h, i)
                        failed = True
                        continue
                rc = self._run_step(auto, ver, h, s, vdir, params, secret_values, agent_cfg,
                                    state, redactions, result, notify_holder := {})
                if notify_holder.get("text"):
                    notify_text = notify_holder["text"]
                if notify_holder.get("result_touched"):
                    result_touched = True
                dur = int((time.time() - t0) * 1000)
                h["steps"][i]["dur_ms"] = dur
                if state["cancel"]:
                    h["steps"][i]["status"] = "cancelled"
                    self._log(h, "sys", "run cancelled by you — nothing else will happen", redactions)
                elif rc == 0:
                    h["steps"][i]["status"] = "succeeded"
                else:
                    h["steps"][i]["status"] = "failed"
                    failed = True
                self._step_event(h, i)
                h["_cur_step"] = None
            # ---- finalize ----
            h["_cur_step"] = None
            started = datetime.fromisoformat(h["started_at"])
            h["dur_ms"] = int((datetime.now() - started).total_seconds() * 1000)
            if state["cancel"]:
                h["status"] = "cancelled"
            elif failed:
                h["status"] = "failed"
                self._log(h, "sys", f"run failed — see the step above", redactions)
            else:
                h["status"] = "succeeded"
            h["finished_at"] = datetime.now().isoformat(timespec="seconds")
            if result_touched and not state["cancel"]:
                if not result["chip"]:
                    result["chip"] = {"changes": "Changes", "ok": "All good", "attention": "Needs attention"}[result["status"]]
                self.store.write_result(h["id"], {k: v for k, v in result.items() if v not in (None, [], {})})
            self.store.update_execution(h)
            self._notify_end(auto, h, result if result_touched else None, notify_text)
        except Exception as e:  # noqa: BLE001
            h["status"] = "failed"
            h["finished_at"] = datetime.now().isoformat(timespec="seconds")
            self._log(h, "err", f"engine error: {e}", redactions)
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

    def _run_step(self, auto: dict, ver: dict, h: dict, s: dict, vdir: Path,
                  params: dict, secret_values: dict, agent_cfg: dict | None,
                  state: dict, redactions: dict, result: dict, notify_holder: dict) -> int:
        script = vdir / (s.get("file") or "")
        if not script.exists():
            self._log(h, "err", f"step script {s.get('file')} is missing", redactions)
            return 1
        # §6 secret scoping: a step only receives the secrets its own source
        # references. The full value map stays engine-side for log redaction;
        # reading an uninjected secret raises in the runner and fails the run.
        step_refs = set(SECRET_REF_RE.findall(s.get("code", "")))
        step_secrets = {k: v for k, v in secret_values.items() if k in step_refs}
        ctx = {
            "params": params,
            "secrets": step_secrets,
            "allowed_secrets": auto["allowed_secrets"],
            "memory_dir": str(self.store.auto_dir(auto) / "memory"),
            "workspace": str(self.store.exec_dir(h["id"]) / "workspace"),
            "agent": agent_cfg,
            "is_agent_step": bool(s.get("agent")),
            "agent_timeout": 120,
        }
        proc = subprocess.Popen(
            [sys.executable, "-m", "autodave.runner", str(script)],
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
                    self._log(h, msg.get("k", "out"), msg.get("text", ""), redactions)
                elif op == "result":
                    notify_holder["result_touched"] = True
                    f, v = msg.get("field"), msg.get("value")
                    if f == "status":
                        result["status"] = v
                    elif f == "chip":
                        result["chip"] = v
                    elif f == "chips":
                        result["chips"] = v
                    elif f == "body":
                        result["body"].append(v)
                    elif f == "rows":
                        result["rows"] = v.get("rows")
                        if v.get("columns"):
                            result["columns"] = v["columns"]
                    elif f == "attach":
                        self._attach_artifact(h, v, redactions)
                elif op == "notify":
                    notify_holder["text"] = msg.get("text")
                elif op == "agent_audit":
                    # §6: the FULL redacted prompt/response go to logs for audit
                    # (the 200k prompt/reply size caps already apply upstream).
                    self._log(h, "sys", f"agent prompt: {msg.get('prompt', '')}", redactions)
                    self._log(h, "sys", f"agent reply: {msg.get('reply', '')}", redactions)
            elif line.strip():
                self._log(h, "out", line, redactions)
        proc.wait()
        watchdog.cancel()
        state["proc"] = None
        if timed_out.is_set() and proc.returncode != 0:
            self._log(h, "err", f"step timed out after {int(timeout_s)}s", redactions)
            return proc.returncode or 1
        return proc.returncode or 0

    def _attach_artifact(self, h: dict, path: str, redactions: dict) -> None:
        import shutil

        src = Path(self.store.exec_dir(h["id"])) / "workspace" / path
        if not src.exists():
            src = Path(path)
        if src.exists() and src.is_file():
            dst = self.store.exec_dir(h["id"]) / "result" / src.name
            shutil.copy2(src, dst)
            self._log(h, "sys", f"attached {src.name} to the result", redactions)
        else:
            self._log(h, "wrn", f"couldn't attach {path} — file not found", redactions)

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
                ("Run failed" if status == "failed" else "Run finished")
            title_param = None
            ver = self._resolve_version(auto, h["ver"]) or {}
            for p in ver.get("params", []):
                if p["name"] == "notification_title":
                    title_param = resolve_param_value(p, auto["param_values"]) or None
            notify.post(title_param or auto["name"], body)
