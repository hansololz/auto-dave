import time

from conftest import make_version


def wait_done(engine, exec_id, timeout=30):
    t0 = time.time()
    while engine.is_live(exec_id):
        assert time.time() - t0 < timeout, "run didn't finish in time"
        time.sleep(0.1)


def test_run_lifecycle_success(store):
    from autodave.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "Runner", None)
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert [s["status"] for s in h["steps"]] == ["succeeded", "succeeded"]
    logs = store.read_logs(h["id"])
    assert any("hello x3" in l["text"] for l in logs)
    assert any(l["text"].startswith("▸ Step 1") for l in logs)
    result = store.read_result(h["id"])
    assert result["chip"] == "All good" and result["status"] == "ok"
    # automation display state updated
    assert a["_last_status"] == "succeeded" and a["_live"] is None


def test_failed_step_stops_run(store):
    from autodave.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'raise RuntimeError("boom")\n'
    a = store.create_automation(ver, "Failer", None)
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    assert h["steps"][0]["status"] == "failed"
    assert h["steps"][1]["status"] == "queued"  # never ran
    assert any("boom" in l["text"] for l in store.read_logs(h["id"]))


def test_missing_secret_stops_before_step_one(store):
    from autodave.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = "x = secrets.NOT_THERE\n"
    a = store.create_automation(ver, "Secretless", None)
    store.patch_automation(a, {"allowedSecrets": ["NOT_THERE"]})
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    logs = store.read_logs(h["id"])
    assert any("isn't in your Keychain" in l["text"] for l in logs)
    # no step ever started
    assert not any(l["text"].startswith("▸ Step") for l in logs)


def test_secret_redacted_from_logs(store):
    from autodave import keychain
    from autodave.engine import Engine

    keychain.set_secret("API_KEY", "super-secret-value-123")
    store.secret_names.append("API_KEY")
    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'k = secrets.API_KEY\nlog(f"using {k} now")\n'
    a = store.create_automation(ver, "Leaky", None)
    store.patch_automation(a, {"allowedSecrets": ["API_KEY"]})
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    logs = store.read_logs(h["id"])
    assert not any("super-secret-value-123" in l["text"] for l in logs)
    assert any("•••" in l["text"] for l in logs)
    assert "API_KEY" in h["redacted"]


def test_multiline_secret_lines_redacted_from_logs(store):
    from autodave import keychain
    from autodave.engine import Engine

    pem = "-----BEGIN KEY-----\nabc123line\n-----END KEY-----"
    keychain.set_secret("PEM_KEY", pem)
    store.secret_names.append("PEM_KEY")
    engine = Engine(store)
    ver = make_version()
    # Each log() call is a separate log line, so the whole value never
    # appears in one line — only its individual lines do.
    ver["steps"][0]["code"] = (
        "k = secrets.PEM_KEY\n"
        "for part in k.splitlines():\n"
        '    log(f"line: {part}")\n'
    )
    a = store.create_automation(ver, "PemLeaky", None)
    store.patch_automation(a, {"allowedSecrets": ["PEM_KEY"]})
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    logs = store.read_logs(h["id"])
    assert not any("abc123line" in l["text"] for l in logs)
    assert not any("BEGIN KEY" in l["text"] for l in logs)
    assert "PEM_KEY" in h["redacted"]


def test_rerun_from_failed_reuses_earlier_steps(store):
    from autodave.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-ok.py", "name": "OK step", "desc": "", "code": 'log("fine")\n'},
        {"file": "02-flaky.py", "name": "Flaky step", "desc": "",
         "code": 'import os\nassert os.environ.get("NEVER_SET"), "flaky"\n'},
    ]
    a = store.create_automation(ver, "Retry Me", None)
    h1 = engine.start(a, "Manual")
    wait_done(engine, h1["id"])
    assert h1["status"] == "failed" and h1["steps"][1]["status"] == "failed"
    h2 = engine.rerun_from_failed(a, h1)
    wait_done(engine, h2["id"])
    assert h2["steps"][0]["status"] == "reused"
    assert h2["steps"][1]["status"] == "failed"


def test_one_run_at_a_time(store):
    import pytest

    from autodave.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = "import time\ntime.sleep(3)\n"
    a = store.create_automation(ver, "Slowpoke", None)
    h = engine.start(a, "Manual")
    with pytest.raises(RuntimeError, match="already running"):
        engine.start(a, "Manual")
    engine.cancel(h["id"])
    wait_done(engine, h["id"])
    assert h["status"] == "cancelled"


def test_memory_persists_between_runs(store):
    from autodave.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-count.py", "name": "Count", "desc": "",
         "code": 'n = memory.load("n", 0) + 1\nmemory.save("n", n)\nlog(f"run number {n}")\n'
                 'result.status("ok")\nresult.chip(str(n))\n'},
    ]
    a = store.create_automation(ver, "Memoryful", None)
    for expect in ("1", "2"):
        h = engine.start(a, "Manual")
        wait_done(engine, h["id"])
        assert store.read_result(h["id"])["chip"] == expect


def test_workspace_shared_between_steps(store):
    """§6: all steps of an execution share one workspace (cwd)."""
    from autodave.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-write.py", "name": "Write", "desc": "",
         "code": 'import json\njson.dump({"x": 42}, open("data.json", "w"))\n'},
        {"file": "02-read.py", "name": "Read", "desc": "",
         "code": 'import json\nd = json.load(open("data.json"))\n'
                 'result.status("ok")\nresult.chip(str(d["x"]))\n'},
    ]
    a = store.create_automation(ver, "Workspacer", None)
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert store.read_result(h["id"])["chip"] == "42"
    assert (store.exec_dir(h["id"]) / "workspace" / "data.json").exists()


def test_agent_step_query_only(store):
    from autodave.engine import Engine

    store.agents = [{"id": "mock", "harness": "Claude Code", "model": "x", "default": True}]
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-ask.py", "name": "Ask", "desc": "", "agent": True, "why": "judgment",
         "code": 'ans = agent.ask("question: anything new?")\nlog(f"agent said: {ans}")\n'
                 'result.status("ok")\nresult.value("Answer", ans)\n'},
    ]
    a = store.create_automation(ver, "Asker", None, enabled_agents=["mock"])
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert any("Mock answer" in l["text"] for l in store.read_logs(h["id"]))


def test_step_timeout_applies_to_silent_hang(store, monkeypatch):
    """§6: the per-step timeout must fire even when the step prints nothing."""
    from autodave.engine import Engine

    monkeypatch.setenv("AUTODAVE_STEP_TIMEOUT", "1")
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-hang.py", "name": "Hang", "desc": "",
         "code": "import time\ntime.sleep(30)\n"},  # zero output
    ]
    a = store.create_automation(ver, "Hanger", None)
    t0 = time.time()
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"], timeout=15)
    assert time.time() - t0 < 15
    assert h["status"] == "failed"
    assert h["steps"][0]["status"] == "failed"
    logs = store.read_logs(h["id"])
    assert any(l["k"] == "err" and "timed out" in l["text"] for l in logs)


def test_run_draft_version_lowercase_label(store):
    """§19: POST /run accepts version 'draft' (lowercase) as well as 'Draft'."""
    from autodave.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "Drafty", None)
    dver = make_version()
    dver["steps"] = [
        {"file": "01-say.py", "name": "Draft step", "desc": "",
         "code": 'log("from the draft")\n'},
    ]
    store.save_draft(a, dver)
    h = engine.start(a, "Manual", version_label="draft")
    wait_done(engine, h["id"])
    assert h["ver"] == "Draft"  # canonical label
    assert h["status"] == "succeeded"
    assert any("from the draft" in l["text"] for l in store.read_logs(h["id"]))


def test_runtime_import_allowlist_revalidated(store):
    """§6.2: runner re-checks the curated allowlist before exec'ing a step."""
    from autodave.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = "import django\nlog('never runs')\n"
    a = store.create_automation(ver, "Importer", None)
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    logs = store.read_logs(h["id"])
    assert any(l["k"] == "err" and "django" in l["text"] and "isn't allowed" in l["text"] for l in logs)
    assert not any("never runs" in l["text"] for l in logs)


def test_agent_audit_logs_full_prompt(store):
    """§6: the FULL redacted prompt/reply are written to logs.ndjson (no 2k/10k cap)."""
    from autodave.engine import Engine

    store.agents = [{"id": "mock", "harness": "Claude Code", "model": "x", "default": True}]
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-ask.py", "name": "Ask", "desc": "", "agent": True, "why": "judgment",
         "code": 'ans = agent.ask("question: anything new?", data="x" * 6000)\n'
                 'result.status("ok")\nresult.value("Answer", ans)\n'},
    ]
    a = store.create_automation(ver, "Big Asker", None, enabled_agents=["mock"])
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    logs = store.read_logs(h["id"])
    prompt_lines = [l for l in logs if l["text"].startswith("agent prompt:")]
    assert prompt_lines and len(prompt_lines[0]["text"]) > 6000  # not truncated
    assert any(l["text"].startswith("agent reply:") for l in logs)


def test_secrets_scoped_per_step(store):
    """§6 scoping: a step only gets the secrets its own source references."""
    from autodave import keychain
    from autodave.engine import Engine

    keychain.set_secret("API_ONE", "value-one")
    keychain.set_secret("API_TWO", "value-two")
    store.secret_names += ["API_ONE", "API_TWO"]
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        # references only API_ONE in source; sneaks at API_TWO via getattr
        {"file": "01-sneak.py", "name": "Sneak", "desc": "",
         "code": 'ok = secrets.API_ONE\nlog("got one")\n'
                 'x = getattr(secrets, "API_TWO")\nlog("got two")\n'},
        # makes API_TWO a known reference so the engine pre-check fetches it
        {"file": "02-legit.py", "name": "Legit", "desc": "",
         "code": "y = secrets.API_TWO\n"},
    ]
    a = store.create_automation(ver, "Scoped", None)
    store.patch_automation(a, {"allowedSecrets": ["API_ONE", "API_TWO"]})
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    logs = store.read_logs(h["id"])
    assert any("got one" in l["text"] for l in logs)
    assert not any("got two" in l["text"] for l in logs)
    assert any("API_TWO" in l["text"] and "not in your Keychain" in l["text"] for l in logs)


def test_logs_ndjson_step_attribution(store):
    """§5 on-disk log shape: {ts, t, step, k, text}; API shape stays {t, k, text}."""
    from autodave.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "Attributed", None)
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    logs = store.read_logs(h["id"])
    for l in logs:
        assert set(l) == {"ts", "t", "step", "k", "text"}
    by_text = {l["text"]: l for l in logs}
    assert by_text["hello x3"]["step"] == "Say hello"
    assert by_text["▸ Step 1 — Say hello"]["step"] == "Say hello"
    assert by_text["▸ Step 2 — Finish"]["step"] == "Finish"
    # API/UI-served shape unchanged
    served = store.exec_json(h, full=True)["logs"]
    assert all(set(l) == {"t", "k", "text"} for l in served)


def test_run_level_log_lines_have_null_step(store):
    from autodave.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'raise RuntimeError("boom")\n'
    a = store.create_automation(ver, "Attributed Fail", None)
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    logs = store.read_logs(h["id"])
    final = [l for l in logs if l["text"].startswith("run failed")]
    assert final and final[0]["step"] is None


def test_finished_at_persisted_and_reloaded(store):
    import sqlite3
    from autodave.engine import Engine
    from autodave.storage import Store
    from datetime import datetime

    engine = Engine(store)
    a = store.create_automation(make_version(), "Finisher", None)
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    assert h["finished_at"]
    datetime.fromisoformat(h["finished_at"])  # ISO 8601, same format as started_at
    db = sqlite3.connect(store.executions_dir() / "executions.db")
    (finished_ms,) = db.execute("SELECT finished_at FROM executions WHERE id=?", (h["id"],)).fetchone()
    db.close()
    assert datetime.fromtimestamp(finished_ms / 1000).isoformat(timespec="seconds") == h["finished_at"]
    s2 = Store()
    s2.load_all()
    assert s2.execs[h["id"]]["finished_at"] == h["finished_at"]


def test_agent_step_without_enabled_agent_fails(store):
    from autodave.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-ask.py", "name": "Ask", "desc": "", "agent": True, "why": "judgment",
         "code": 'agent.ask("hi")\n'},
    ]
    a = store.create_automation(ver, "Agentless", None, enabled_agents=[])
    h = engine.start(a, "Manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    assert any("needs an agent" in l["text"] for l in store.read_logs(h["id"]))
