"""§11 Test (§19 POST /tests): executes the sent draft's steps as a §4.5 test
execution record (test: true, ver "Test", trigger "Test") through the exact
engine path a real execution takes — record, workspace/result/logs, and the
`exec.*` events all ordinary. Test-specific pieces live here: the sent draft's
scripts land in the record's steps/ dir, memory is a scratch copy discarded at
the end, one test record per draft container (409 while one is live, previous
record deleted at start), the last-test summary lands in the container's
test.yaml, and a failed test can be analyzed on demand (§19
POST /tests/{execId}/analyze — never automatically): the §8 issue-analysis
call's blockers ride the `test.issue` event."""
from __future__ import annotations

import shutil
import tempfile
import threading
from datetime import datetime
from pathlib import Path

from . import harness, paths
from .drafting import CONTRACT_PREAMBLE, parse_blockers, spec_as_md
from .engine import Engine, _step_sha
from .events import hub
from .storage import store
from .yamlio import save_yaml

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


def start(engine: Engine, draft: dict, auto: dict | None,
          enabled_agents: list, allowed_secrets: list, param_values: dict) -> str:
    """Create and launch the test execution record; returns its exec id.
    Raises RuntimeError while the container already has a live test (§19 409)."""
    container_id = auto["id"] if auto else ""
    with store.lock:
        if any(h.get("test") and h["auto_id"] == container_id
               and h["status"] == "executing" for h in store.execs.values()):
            raise RuntimeError("a test is already executing — cancel it or wait for it to finish")
        # §11 keep-latest: one test record per draft container.
        store.delete_test_execs(container_id)

        steps = [{**s, "file": s.get("file") or f"{i:02d}-step.py"}
                 for i, s in enumerate(draft.get("steps", []), 1)]
        ver = {"steps": steps, "params": draft.get("params", []) or [],
               "packages": draft.get("packages", []) or [],
               "spec": draft.get("spec") or []}
        # §11: in-editor grants and values, never the stored automation's — the
        # engine reads them off this shadow record; the real one is untouched.
        shadow = {
            "id": container_id,
            "name": (auto["name"] if auto else draft.get("name")) or "New automation",
            "enabled_agents": enabled_agents,
            "allowed_secrets": allowed_secrets,
            "param_values": {**(auto["param_values"] if auto else {}), **(param_values or {})},
        }
        rec_steps = [{"name": s.get("name", ""), "file": s["file"],
                      "agent": bool(s.get("agent")), "sha": _step_sha(s),
                      "status": "queued", "dur_ms": None, "attempts": []}
                     for s in steps]
        h = store.create_execution(shadow, "Test", "Test", rec_steps,
                                   params=store.merged_params(shadow, ver), test=True)
        # The sent draft's scripts, as executed (§5 steps/) — a real version
        # folder serves this role for ordinary executions.
        steps_dir = store.exec_dir(h["id"]) / "steps"
        steps_dir.mkdir(parents=True, exist_ok=True)
        for s in steps:
            (steps_dir / s["file"]).write_text(s.get("code", ""), encoding="utf-8")

    # §11 scratch memory: draft container's memory/ when present (edit mode
    # falls back to the automation's), create mode the pending slot's — copied
    # to a temp dir and discarded when the test ends.
    dbase = (store.auto_dir(auto) / "draft") if auto is not None else paths.pending_draft_dir()
    scratch = Path(tempfile.mkdtemp(prefix="autowright-test-"))
    mem_dir = scratch / "memory"
    src = dbase / "memory"
    if auto is not None and not src.exists():
        src = store.auto_dir(auto) / "memory"
    if src.exists():
        shutil.copytree(src, mem_dir)
    mem_dir.mkdir(parents=True, exist_ok=True)
    (dbase / "test.yaml").unlink(missing_ok=True)  # wiped at each test start (§5)

    h["_test"] = {"vdir": str(steps_dir), "mem": str(mem_dir)}
    state = {"proc": None, "cancel": False}
    with engine._lock:
        engine._live[h["id"]] = state
    hub.publish("exec.started", execId=h["id"], autoId=container_id,
                exec_json=store.exec_json(h))
    t = threading.Thread(target=_run, args=(engine, shadow, ver, h, state, dbase, scratch),
                         daemon=True)
    t.start()
    return h["id"]


def _run(engine: Engine, shadow: dict, ver: dict, h: dict, state: dict,
         dbase: Path, scratch: Path) -> None:
    try:
        engine._execute(shadow, ver, h, state)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)  # §11: the memory copy is discarded
    if h["status"] in ("succeeded", "failed"):
        # §5 test.yaml — the last-test summary a resumed draft's Test card
        # shows; deleted with the draft. A failed test is NOT analyzed here —
        # analysis runs only on demand (analyze_start).
        save_yaml(dbase / "test.yaml", {
            "status": h["status"],
            "when": datetime.now().isoformat(timespec="seconds"),
            "exec_id": h["id"],
        })


def analyze_start(exec_id: str, draft: dict, agent: dict | None) -> None:
    """§19 POST /tests/{execId}/analyze: start the §8 issue-analysis call for a
    failed test record. LookupError → 404, RuntimeError → 409."""
    with store.lock:
        h = store.execs.get(exec_id)
        if not h or not h.get("test"):
            raise LookupError("test execution not found")
        if h["status"] != "failed":
            raise RuntimeError("only a failed test can be analyzed")
        h = store.exec_full(exec_id)
    steps = [{**s, "file": s.get("file") or f"{i:02d}-step.py"}
             for i, s in enumerate(draft.get("steps", []), 1)]
    ver = {"steps": steps, "spec": draft.get("spec") or []}
    threading.Thread(target=_analyze_run, args=(ver, h, agent), daemon=True).start()


def _analyze_run(ver: dict, h: dict, agent: dict | None) -> None:
    failed_at = next((i for i, s in enumerate(h["steps"]) if s["status"] == "failed"), None)
    if failed_at is None or failed_at >= len(ver["steps"]):
        # A failure before any step (§11: secret/package preflight) — or a draft
        # that shrank since the test — no step to analyze; the §4.5 error
        # becomes the blocker deterministically.
        err = h.get("error") or {}
        blockers = [{"reason": err.get("message") or "the test failed",
                     "fix": err.get("reason") or "", "details": ""}]
    else:
        err_msg = (h.get("error") or {}).get("message") or "the step failed"
        blockers = _analyze(ver, h, failed_at, err_msg, agent)
        if blockers is None:
            # §8: analysis dropped — the block opens with the raw error instead.
            blockers = [{"reason": err_msg, "fix": "", "details": ""}]
    hub.publish("test.issue", execId=h["id"], blockers=blockers)


def _log_tail(h: dict, idx: int) -> list[str]:
    attempt = max(1, len(h["steps"][idx].get("attempts", [])))
    lines = store.read_log(h["id"], idx, attempt)
    return [l.get("text", "") for l in lines][-LOG_TAIL:]


def _analyze(ver: dict, h: dict, idx: int, err_msg: str, agent: dict | None) -> list[dict] | None:
    """§8 issue-analysis call: framework instructions + spec + failing step
    code + error + log tails (read from the record's log files) → blocker
    envelope, one repair round. None when the analysis can't be had (no agent,
    invalid twice, harness error)."""
    if agent is None:
        return None
    step = ver["steps"][idx]
    parts = [
        "=== FRAMEWORK INSTRUCTIONS ===\n" + CONTRACT_PREAMBLE,
        "=== SPEC (spec.md) ===\n" + spec_as_md(ver),
        f"=== FAILING STEP ({step.get('file')} — {step.get('name')}) ===\n"
        + step.get("code", ""),
        "=== ERROR ===\n" + err_msg,
    ]
    for j in range(idx):
        tail = _log_tail(h, j)
        if tail:
            parts.append(f"=== LOG TAIL (step {j + 1}) ===\n" + "\n".join(tail))
    parts.append("=== LOG TAIL (failing step) ===\n" + "\n".join(_log_tail(h, idx)))
    parts.append(ISSUE_TASK)
    prompt = "\n\n".join(parts)
    try:
        for attempt in range(2):
            raw = harness.invoke(agent, prompt, timeout=300)
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
