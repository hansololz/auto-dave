"""§11 Test (§19 POST /tests): executes the sent draft's real steps ephemerally —
the same step-subprocess path as a real execution, with scratch memory (copied
from the automation's when editing), a throwaway workspace, and no execution
record. Progress streams over the test.* WS events; a failed step triggers the
§8 issue-analysis call and its blockers ride test.issue."""
from __future__ import annotations

import shutil
import tempfile
import threading
import uuid
from datetime import datetime
from pathlib import Path

from . import harness, notify, keychain, packages as pkglib
from .drafting import CONTRACT_PREAMBLE, parse_blockers, spec_as_md
from .engine import run_step_process
from .events import hub
from .storage import SECRET_REF_RE, resolve_param_value, store

LOG_TAIL = 40  # lines per step handed to the issue-analysis call

# §8 issue-analysis TASK — same ===BLOCKED=== envelope as the drafting calls,
# so one parser and one §11 panel serve build-time refusals and test failures.
ISSUE_TASK = """=== TASK ===
A test execution of this automation failed at the step above. Analyze the failure (the cause is often in an earlier step's output) and respond with exactly one blocker envelope — no file blocks, `reason` holding what happened:

===BLOCKED===
blockers:
  - reason: One plain sentence naming what happened.
    fix: The suggested resolution, in plain words.
    details: Optional longer explanation.
===END==="""


class TestRuns:
    def __init__(self) -> None:
        self._runs: dict[str, dict] = {}  # test_id → {proc, cancel, _hproc}
        self._lock = threading.Lock()

    # ---------- public ----------
    def start(self, draft: dict, auto: dict | None, agent: dict | None,
              enabled_agents: list, allowed_secrets: list, param_values: dict) -> str:
        test_id = str(uuid.uuid4())
        state = {"proc": None, "cancel": False, "_hproc": {}}
        with self._lock:
            self._runs[test_id] = state
        t = threading.Thread(
            target=self._run,
            args=(test_id, state, draft, auto, agent, enabled_agents, allowed_secrets,
                  param_values),
            daemon=True)
        t.start()
        return test_id

    def cancel(self, test_id: str) -> bool:
        with self._lock:
            state = self._runs.get(test_id)
        if not state:
            return False
        state["cancel"] = True
        # Kill whichever is live: the step subprocess or the analysis harness.
        for p in (state.get("proc"), state["_hproc"].get("proc")):
            if p and p.poll() is None:
                p.terminate()
        return True

    # ---------- internals ----------
    def _run(self, test_id: str, state: dict, draft: dict, auto: dict | None,
             agent: dict | None, enabled_agents: list, allowed_secrets: list,
             param_values: dict) -> None:
        root = Path(tempfile.mkdtemp(prefix="autodave-test-"))
        redactions: dict[str, str] = {}
        step_logs: list[list[str]] = [[] for _ in draft.get("steps", [])]
        cur = {"i": None}

        def log(k: str, text: str) -> None:
            for val, _name in redactions.items():
                if val and val in text:
                    text = text.replace(val, "•••")
            if cur["i"] is not None:
                step_logs[cur["i"]].append(text)
            hub.publish("test.log", testId=test_id,
                        line={"t": datetime.now().strftime("%H:%M:%S"), "k": k, "text": text})

        def step_ev(i: int, status: str) -> None:
            hub.publish("test.step", testId=test_id, i=i,
                        name=draft["steps"][i].get("name", ""), status=status)

        try:
            steps = draft.get("steps", [])
            for i in range(len(steps)):
                step_ev(i, "queued")

            # Scratch dirs — memory copies the automation's when editing (§11).
            mem_dir = root / "memory"
            if auto is not None:
                src = store.auto_dir(auto) / "memory"
                if src.exists():
                    shutil.copytree(src, mem_dir)
            mem_dir.mkdir(parents=True, exist_ok=True)
            steps_dir = root / "steps"
            steps_dir.mkdir(parents=True, exist_ok=True)
            for s in steps:
                (steps_dir / (s.get("file") or "step.py")).write_text(
                    s.get("code", ""), encoding="utf-8")

            # §6: a missing secret stops the test before any step.
            needed: set[str] = set()
            for s in steps:
                needed |= set(SECRET_REF_RE.findall(s.get("code", "")))
            secret_values: dict[str, str] = {}
            for name in sorted(needed):
                if name not in allowed_secrets:
                    msg = f"secret {name} isn't allowed for this automation — the test can't start"
                    fix = "Allow the secret in the Secrets card, or drop the reference from the step."
                    self._prestep_fail(test_id, state, log, msg, fix)
                    return
                v = keychain.get_secret(name)
                if v is None:
                    msg = f"secret {name} isn't in your Keychain — the test can't start"
                    fix = "Add the secret on the Secrets page, then test again."
                    self._prestep_fail(test_id, state, log, msg, fix)
                    return
                secret_values[name] = v
            redactions = {v: k for k, v in secret_values.items()}
            for name, v in secret_values.items():
                if "\n" in v:
                    for part in v.splitlines():
                        if part.strip():
                            redactions.setdefault(part, name)

            # §6.2/§7: a test executes the same engine path — ensure the draft's
            # declared packages before step 1, exactly like a real execution.
            declared = draft.get("packages") or []
            if declared:
                missing = [p for p in pkglib.check(declared) if p["status"] != "installed"]
                if missing:
                    log("sys", "installing packages: " + ", ".join(p["pip"] for p in missing))
                    bad = [p for p in pkglib.ensure(declared) if p["status"] != "installed"]
                    if bad:
                        msg = ("package install failed — "
                               + "; ".join(f"{p['pip']}: {p.get('error') or 'install failed'}"
                                           for p in bad))
                        fix = "Check your connection, then retry from the Packages card or test again."
                        self._prestep_fail(test_id, state, log, msg, fix)
                        return

            # §19: stored values (edit) under the test-only paramValues overrides.
            values = {**(auto["param_values"] if auto else {}), **(param_values or {})}
            warns: list[str] = []
            params = {p["name"]: resolve_param_value(p, values, warns)
                      for p in draft.get("params", [])}
            for w in warns:
                log("wrn", w)

            result: dict = {"status": "ok", "chip": None, "chips": [], "values": []}
            result_touched = False
            notify_text: str | None = None
            failed_at: int | None = None
            error: dict | None = None
            agents = {g["id"]: g for g in store.agents}
            for i, s in enumerate(steps):
                if state["cancel"]:
                    break
                cur["i"] = i
                step_ev(i, "executing")
                log("sys", f"▸ Step {i + 1} — {s.get('name', '')}")
                agent_cfg = None
                if s.get("agent"):
                    cand = s.get("agentId") or s.get("agent_id")
                    if cand and cand in agents and cand in enabled_agents:
                        agent_cfg = agents[cand]
                    else:
                        agent_cfg = next((agents[a] for a in enabled_agents if a in agents), None)
                    if agent_cfg is None:
                        msg = f"Step {i + 1} needs an agent, but none is enabled — the test fails here."
                        log("err", msg)
                        step_ev(i, "failed")
                        failed_at, error = i, {"message": msg}
                        break
                step_refs = set(SECRET_REF_RE.findall(s.get("code", "")))
                ctx = {
                    "params": params,
                    "secrets": {k: v for k, v in secret_values.items() if k in step_refs},
                    "allowed_secrets": list(allowed_secrets),
                    "site_packages": str(pkglib.site_packages_dir()),
                    "package_imports": [p["import"] for p in draft.get("packages") or []],
                    "memory_dir": str(mem_dir),
                    "workspace": str(root / "workspace"),
                    "result_dir": str(root / "result"),
                    "agent": agent_cfg,
                    "is_agent_step": bool(s.get("agent")),
                    "agent_timeout": 120,
                    "execution": {
                        "automation_id": auto["id"] if auto else None,
                        "automation_name": auto["name"] if auto else draft.get("name"),
                        "id": test_id,
                        "step_index": i + 1,
                        "step_name": s.get("name", ""),
                        "trigger": "Test",
                    },
                }
                holder: dict = {}
                rc = run_step_process(steps_dir / (s.get("file") or "step.py"), ctx, state,
                                      log, result, holder)
                if holder.get("result_touched"):
                    result_touched = True
                if holder.get("text"):
                    notify_text = holder["text"]
                if state["cancel"]:
                    step_ev(i, "cancelled")
                    break
                if rc == 0:
                    step_ev(i, "succeeded")
                else:
                    step_ev(i, "failed")
                    failed_at = i
                    error = holder.get("error") or {"message": f"step failed (exit code {rc})"}
                    break
            cur["i"] = None

            if state["cancel"]:
                hub.publish("test.done", testId=test_id, status="cancelled")
                return
            if failed_at is None:
                log("sys", "test finished — the memory copy was discarded")
                res = None
                if result_touched:
                    res = {"chip": result["chip"],
                           "chipStatus": result["status"] if result["chip"] else None,
                           "chips": result["chips"], "values": result["values"]}
                hub.publish("test.done", testId=test_id, status="succeeded", result=res)
                self._notify_end(draft, auto, params, "succeeded",
                                 result if result_touched else None, notify_text)
                return

            hub.publish("test.done", testId=test_id, status="failed")
            self._notify_end(draft, auto, params, "failed",
                             result if result_touched else None, notify_text)
            raw_msg = (error or {}).get("message") or "the step failed"
            blockers = self._analyze(state, draft, steps[failed_at], failed_at,
                                     raw_msg, step_logs, agent)
            if state["cancel"]:
                return
            if blockers is None:
                # §8: analysis dropped — the panel opens with the raw error instead.
                blockers = [{"reason": raw_msg, "fix": "", "details": ""}]
            hub.publish("test.issue", testId=test_id, blockers=blockers)
        except Exception as e:  # noqa: BLE001
            if not state["cancel"]:
                log("err", f"test error: {e}")
                hub.publish("test.done", testId=test_id, status="failed")
                hub.publish("test.issue", testId=test_id,
                            blockers=[{"reason": f"test error: {e}", "fix": "", "details": ""}])
        finally:
            with self._lock:
                self._runs.pop(test_id, None)
            shutil.rmtree(root, ignore_errors=True)

    def _prestep_fail(self, test_id: str, state: dict, log, msg: str, fix: str) -> None:
        """A failure before any step executes — no step to analyze, so the issue
        is synthesized deterministically."""
        log("err", msg)
        hub.publish("test.done", testId=test_id, status="failed")
        if not state["cancel"]:
            hub.publish("test.issue", testId=test_id,
                        blockers=[{"reason": msg, "fix": fix, "details": ""}])

    def _analyze(self, state: dict, draft: dict, step: dict, idx: int, err_msg: str,
                 step_logs: list[list[str]], agent: dict | None) -> list[dict] | None:
        """§8 issue-analysis call: framework instructions + spec + failing step
        code + error + log tails → blocker envelope, one repair round. None when
        the analysis can't be had (no agent, invalid twice, harness error)."""
        if agent is None:
            return None
        parts = [
            "=== FRAMEWORK INSTRUCTIONS ===\n" + CONTRACT_PREAMBLE,
            "=== SPEC (spec.md) ===\n" + spec_as_md(draft),
            f"=== FAILING STEP ({step.get('file')} — {step.get('name')}) ===\n"
            + step.get("code", ""),
            "=== ERROR ===\n" + err_msg,
        ]
        for j in range(idx):
            tail = step_logs[j][-LOG_TAIL:]
            if tail:
                parts.append(f"=== LOG TAIL (step {j + 1}) ===\n" + "\n".join(tail))
        parts.append("=== LOG TAIL (failing step) ===\n"
                     + "\n".join(step_logs[idx][-LOG_TAIL:]))
        parts.append(ISSUE_TASK)
        prompt = "\n\n".join(parts)
        try:
            for attempt in range(2):
                raw = harness.invoke(agent, prompt, timeout=300, proc_holder=state["_hproc"])
                if state["cancel"]:
                    return None
                try:
                    blockers = parse_blockers(raw)
                    if blockers is not None:
                        return blockers
                    errs = ["the response must be a ===BLOCKED=== envelope — no file blocks"]
                except ValueError as e:
                    errs = [str(e)]
                if attempt == 0:
                    prompt = (prompt + "\n\n=== YOUR PREVIOUS RESPONSE ===\n" + raw
                              + "\n\n=== VALIDATION ERRORS — fix these and resend the envelope ===\n- "
                              + "\n- ".join(errs))
        except harness.HarnessError:
            return None
        return None

    def _notify_end(self, draft: dict, auto: dict | None, params: dict, status: str,
                    result: dict | None, notify_text: str | None) -> None:
        """§11: side effects are real — notifications post per the §4.9 setting,
        same rules as a real execution's end."""
        setting = store.settings.get("notif", "attention")
        interesting = status == "failed" or (result or {}).get("status") in ("changes", "attention")
        if setting != "all" and not interesting:
            return
        body = notify_text or (result or {}).get("chip") or \
            ("Test failed" if status == "failed" else "Test finished")
        title = params.get("notification_title") or \
            (auto["name"] if auto else draft.get("name")) or "Auto Dave test"
        notify.post(str(title), body)


test_runs = TestRuns()
