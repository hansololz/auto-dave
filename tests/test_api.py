import importlib
import time

import pytest
from fastapi.testclient import TestClient

from conftest import make_version


@pytest.fixture()
def client(home):
    from autodave import api
    from autodave.storage import store

    store.load_all()
    store.autos.clear()
    store.execs.clear()
    store.agents = [{"id": "mock", "harness": "Claude Code", "mode": "default",
                     "model": None, "default": True}]
    c = TestClient(api.app)
    c.headers["Authorization"] = f"Bearer {api.AUTH_TOKEN}"
    return c


def test_auth_required(client):
    r = client.get("/state", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401
    assert client.get("/health").status_code == 200  # health is open


def test_state_shape(client):
    r = client.get("/state").json()
    assert set(r) >= {"autos", "execs", "agents", "secrets", "settings", "version"}


def test_instructions_endpoint(client):
    from autodave.drafting import CONTRACT_PREAMBLE, DEFAULT_INSTRUCTIONS

    # §11/§19: both instruction files travel to the page verbatim
    r = client.get("/instructions").json()
    assert r["framework"] == CONTRACT_PREAMBLE
    assert r["defaultBuild"] == DEFAULT_INSTRUCTIONS


def test_secret_crud_and_usedby(client):
    assert client.put("/secrets/bad-name", json={"value": "x"}).status_code == 422
    assert client.put("/secrets/MY_TOKEN", json={"value": "abc"}).status_code == 200
    names = [s["name"] for s in client.get("/secrets").json()]
    assert "MY_TOKEN" in names
    assert client.delete("/secrets/MY_TOKEN").status_code == 200


def test_draft_job_and_create_flow(client):
    r = client.post("/drafts", json={"mode": "create", "text": "Watch a product price", "agentId": "mock"})
    job_id = r.json()["jobId"]
    for _ in range(100):
        j = client.get(f"/drafts/{job_id}").json()
        if j["status"] in ("done", "failed"):
            break
        time.sleep(0.1)
    assert j["status"] == "done", j
    draft = j["draft"]
    assert draft["steps"] and draft["spec"]
    # §8: create drafts carry the seeded default build instructions back to Review
    from autodave.drafting import DEFAULT_INSTRUCTIONS
    assert draft["instr"] == DEFAULT_INSTRUCTIONS
    r = client.post("/automations", json={"draft": draft, "agentId": "mock"})
    assert r.status_code == 200
    auto = r.json()
    assert auto["version"] == 1 and auto["lastStatus"] == "none"
    # §11 create toast state: nothing has executed yet
    assert auto["lastExecLabel"] == ""


def _wait_job(client, job_id):
    for _ in range(100):
        j = client.get(f"/drafts/{job_id}").json()
        if j["status"] in ("done", "failed", "blocked"):
            return j
        time.sleep(0.1)
    return j


def test_draft_job_blocked_at_steps_carries_spec(client):
    # §8: a valid blocker envelope ends the job `blocked` (not failed), with the
    # blocker list; in create mode call 1's spec rides along so the §11 Blocker
    # panel can amend it and rebuild.
    r = client.post("/drafts", json={"mode": "create", "text": "blocked-steps mail watcher",
                                     "agentId": "mock"})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "blocked", j
    assert j["blockedAt"] == "steps"
    assert j["error"] is None
    assert j["blockers"] and j["blockers"][0]["reason"] and j["blockers"][0]["fix"]
    assert j["draft"]["spec"]


def test_draft_job_blocked_at_spec(client):
    r = client.post("/drafts", json={"mode": "create", "text": "blocked-spec mail watcher",
                                     "agentId": "mock"})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "blocked", j
    assert j["blockedAt"] == "spec"
    assert j["draft"] is None  # no spec exists yet to amend


def test_sync_blocked_has_no_draft(client):
    from autodave.storage import store

    # sync: the caller already holds the spec — the blocked payload carries none
    a = store.create_automation(make_version(), "Sync blocked", "mock")
    r = client.post("/drafts", json={"mode": "sync", "autoId": a["id"], "agentId": "mock",
                                     "spec": "# blocked-steps title\n\nBody."})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "blocked", j
    assert j["blockedAt"] == "steps"
    assert j["draft"] is None


def test_sync_uses_provided_spec(client):
    from autodave import paths
    from autodave.storage import store

    a = store.create_automation(make_version(), "Sync target", "mock")
    marker = "The provided spec wins over the stored one."
    r = client.post("/drafts", json={"mode": "sync", "autoId": a["id"], "agentId": "mock",
                                     "spec": f"# Synced title\n\n{marker}"})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "done", j
    assert j["draft"]["spec"] is None  # sync returns no spec.md
    logged = paths.app_log().read_text(encoding="utf-8")
    assert marker in logged            # the prompt embedded the PROVIDED spec…
    assert "It tests." not in logged   # …not the stored version's spec


def test_sync_current_still_supported(client):
    from autodave import paths
    from autodave.storage import store

    a = store.create_automation(make_version(), "Sync current", "mock")
    cur = make_version(spec=[{"k": "h1", "text": "Edited"},
                             {"k": "h2", "text": "Change (draft)"},
                             {"k": "p", "text": "In-editor draft spec text."}])
    r = client.post("/drafts", json={"mode": "sync", "autoId": a["id"], "agentId": "mock",
                                     "current": cur})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "done", j
    logged = paths.app_log().read_text(encoding="utf-8")
    assert "In-editor draft spec text." in logged


def test_draft_edit_honors_in_editor_grants(client):
    from autodave import paths
    from autodave.storage import store

    # saved grants: no agents enabled, no secrets allowed
    a = store.create_automation(make_version(), "Ask target", "mock", enabled_agents=[])
    r = client.post("/drafts", json={
        "mode": "edit", "autoId": a["id"], "agentId": "mock",
        "text": "Also check on weekends",
        "enabledAgents": ["mock"], "allowedSecrets": ["MY_SECRET"],  # in-editor grants win
    })
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "done", j
    # §8: edit is the spec call only — the payload is just {spec}, steps untouched
    assert j["draft"]["spec"] is not None
    assert "steps" not in j["draft"]
    logged = paths.app_log().read_text(encoding="utf-8")
    assert "the automation should use) ===\n- name: Claude Code" in logged
    assert ("which secrets the automation should use) ===\n- name: MY_SECRET" in logged)
    assert "Also check on weekends" in logged      # the USER REQUEST reached the prompt
    assert "Build the automation that implements" not in logged  # no steps call on edit


def test_checks_honor_in_editor_grants(client, monkeypatch):
    from autodave import api
    from autodave.storage import store

    ver = make_version(steps=[
        {"file": "01-use.py", "name": "Use secret", "desc": "",
         "code": "x = secrets.MY_SECRET\n"},
        {"file": "02-ask.py", "name": "Ask", "desc": "", "agent": True, "why": "judgment",
         "code": 'agent.ask("q", {})\n'},
    ])
    # saved grants: no secret allowed, only a nonexistent agent enabled
    a = store.create_automation(ver, "Checks Demo", "mock", enabled_agents=["ghost"])
    client.put("/secrets/MY_SECRET", json={"value": "v"})
    client.patch(f"/automations/{a['id']}", json={"paramValues": {"count": 0}})

    events = []
    monkeypatch.setattr(api.hub, "publish", lambda ev, **kw: events.append({"ev": ev, **kw}))

    def checks(body):
        events.clear()
        client.post(f"/automations/{a['id']}/checks", json=body)
        for _ in range(100):
            if any(e["ev"] == "checks.done" for e in events):
                return [e for e in events if e["ev"] == "checks.line"]
            time.sleep(0.05)
        raise AssertionError(f"checks never finished: {events}")

    lines = checks({})  # saved grants
    assert any("MY_SECRET isn't allowed" in e["text"] for e in lines)
    assert any("no agent is enabled" in e["text"] for e in lines)
    # number param below its min is advisory-amber
    bad_num = next(e for e in lines if e["text"].startswith("Count:"))
    assert bad_num["kind"] == "warn" and "needs attention" in bad_num["text"]

    lines = checks({"allowedSecrets": ["MY_SECRET"], "enabledAgents": ["mock"]})  # in-editor grants
    assert any("MY_SECRET is in your Keychain and allowed" in e["text"] for e in lines)
    assert any("an enabled agent is ready" in e["text"] for e in lines)

    lines = checks({"allowedSecrets": [], "enabledAgents": []})  # explicit empty overrides
    assert any("MY_SECRET isn't allowed" in e["text"] for e in lines)
    assert any("no agent is enabled" in e["text"] for e in lines)


def test_run_and_execution_pages(client):
    from autodave.storage import store

    a = store.create_automation(make_version(), "API Exec", "mock")
    r = client.post(f"/automations/{a['id']}/execute", json={})
    assert r.status_code == 200
    exec_id = r.json()["execId"]
    # §7: starting while live → 409
    r2 = client.post(f"/automations/{a['id']}/execute", json={})
    assert r2.status_code == 409
    for _ in range(100):
        e = client.get(f"/executions/{exec_id}").json()
        if e["status"] != "executing":
            break
        time.sleep(0.1)
    assert e["status"] == "succeeded"
    assert e["result"]["chip"] == "All good"
    assert e["result"]["chipStatus"] == "ok"  # served from the execution header
    assert any(l["k"] == "sys" for l in e["logs"])
    autos = client.get("/automations").json()
    me = next(x for x in autos if x["id"] == a["id"])
    assert me["lastStatus"] == "succeeded"
    assert me["resultChip"] == "All good"
    assert me["resultStatus"] == "ok"  # §4: tints the list-row chip like the detail page


# ---------- §11 Test — §19 POST /tests ----------

def _echo_draft(**over):
    d = {
        "name": "Param echo",
        "spec": [{"k": "h1", "text": "Param echo"}],
        "params": [
            {"name": "greeting", "kind": "text", "label": "Greeting", "help": "", "default": "hello"},
        ],
        "steps": [{"file": "01-echo.py", "name": "Echo", "desc": "",
                   "code": "log(f\"greeting={params['greeting']}\")\n"
                           "result.status('ok')\nresult.chip(params['greeting'])\n"}],
        "triggers": [],
    }
    d.update(over)
    return d


def _capture_events(monkeypatch):
    from autodave import api

    events: list[dict] = []
    monkeypatch.setattr(api.hub, "publish", lambda ev, **kw: events.append({"ev": ev, **kw}))
    return events


def _until(events, ev, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if any(e["ev"] == ev for e in events):
            return next(e for e in events if e["ev"] == ev)
        time.sleep(0.05)
    raise AssertionError(f"{ev} never arrived (got {[e['ev'] for e in events]})")


def test_test_run_param_values_override(client, monkeypatch):
    # §19: paramValues override the defaults for this test only.
    events = _capture_events(monkeypatch)
    r = client.post("/tests", json={"draft": _echo_draft(), "paramValues": {"greeting": "bonjour"}})
    assert r.status_code == 200
    done = _until(events, "test.done")
    assert done["status"] == "succeeded"
    assert done["result"]["chip"] == "bonjour"
    logs = [e["line"]["text"] for e in events if e["ev"] == "test.log"]
    assert any("greeting=bonjour" in t for t in logs)


def test_test_run_stored_values_and_no_record(client, monkeypatch):
    # §19: with autoId (edit mode) the stored values are the base; a test writes
    # no execution record.
    from autodave.storage import store

    events = _capture_events(monkeypatch)
    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    client.patch(f"/automations/{auto['id']}", json={"paramValues": {"greeting": "stored-hi"}})
    events.clear()
    assert client.post("/tests", json={"draft": _echo_draft(), "autoId": auto["id"]}).status_code == 200
    _until(events, "test.done")
    logs = [e["line"]["text"] for e in events if e["ev"] == "test.log"]
    assert any("greeting=stored-hi" in t for t in logs)
    assert store.execs == {}


def test_test_run_failure_emits_issue(client, monkeypatch):
    # §11: a failed step → test.done failed → §8 issue-analysis blockers in test.issue.
    events = _capture_events(monkeypatch)
    d = _echo_draft(steps=[{"file": "01-boom.py", "name": "Boom", "desc": "",
                            "code": "raise KeyError('missing')\n"}])
    assert client.post("/tests", json={"draft": d, "agentId": "mock"}).status_code == 200
    assert _until(events, "test.done")["status"] == "failed"
    issue = _until(events, "test.issue")
    assert issue["blockers"][0]["reason"] == "The task needs access to physical mail."


def test_test_cancel(client, monkeypatch):
    events = _capture_events(monkeypatch)
    d = _echo_draft(steps=[{"file": "01-slow.py", "name": "Slow", "desc": "",
                            "code": "import time\nlog('sleeping')\ntime.sleep(60)\n"}])
    tid = client.post("/tests", json={"draft": d}).json()["testId"]
    t0 = time.time()
    while time.time() - t0 < 10:  # wait until the step subprocess is live
        if any(e["ev"] == "test.log" and e["line"]["text"] == "sleeping" for e in events):
            break
        time.sleep(0.05)
    assert client.delete(f"/tests/{tid}").json()["ok"]
    assert _until(events, "test.done")["status"] == "cancelled"


def test_patch_automation_triggers_and_grants(client):
    from autodave.storage import store

    a = store.create_automation(make_version(), "Patchable", "mock")
    r = client.patch(f"/automations/{a['id']}", json={
        "triggers": [{"kind": "cron", "expr": "15 6 * * 3", "off": True}],
        "allowedSecrets": ["X_TOKEN"], "paramValues": {"greeting": "yo"},
    })
    j = r.json()
    assert [t["label"] for t in j["triggers"]] == ["Wednesdays at 6:15"]
    assert j["triggers"][0]["id"]  # backend assigned an id
    assert j["triggerChip"] == "Wed 6:15"
    assert j["triggersOff"] is True
    assert j["allowedSecrets"] == ["X_TOKEN"]
    assert next(p for p in j["params"] if p["name"] == "greeting")["value"] == "yo"

    # whole-list replace: ids survive, additions get fresh ids
    tid = j["triggers"][0]["id"]
    r = client.patch(f"/automations/{a['id']}", json={
        "triggers": [{**j["triggers"][0], "off": False}, {"kind": "cron", "expr": "0 2 * * *", "off": False}],
    })
    j = r.json()
    assert j["triggers"][0]["id"] == tid
    assert j["triggerChip"] == "2 triggers"
    assert j["triggersOff"] is False


def test_patch_automation_triggers_422(client):
    from autodave.storage import store

    a = store.create_automation(make_version(), "Strict", "mock")
    # message kinds are reserved (§4.3), bad cron and past one-shots are refused
    for bad in ([{"kind": "discord"}],
                [{"kind": "cron", "expr": "not cron"}],
                [{"kind": "time", "at": "2020-01-01T00:00"}]):
        r = client.patch(f"/automations/{a['id']}", json={"triggers": bad})
        assert r.status_code == 422
    assert store.autos[a["id"]]["triggers"] == []  # nothing stored


def test_save_version_and_restore(client):
    from autodave.storage import store

    a = store.create_automation(make_version(), "Versioner", "mock")
    r = client.post(f"/automations/{a['id']}/versions",
                    json={"draft": make_version(desc="second", note="Change")})
    assert r.json()["version"] == 2
    r = client.post(f"/automations/{a['id']}/restore", json={"v": 1})
    assert r.json()["version"] == 3
    j = client.get(f"/automations/{a['id']}").json()
    assert [v["v"] for v in j["versions"]] == [2, 1]


def test_delete_agent_reassigns_default(client):
    from autodave.storage import store

    r = client.post("/agents", json={"harness": "Ollama", "mode": "ollama",
                                     "model": "qwen3:8b", "name": "Local"})
    new_id = r.json()["id"]
    client.patch(f"/agents/{new_id}", json={"default": True})
    r = client.delete(f"/agents/{new_id}")
    assert r.status_code == 200
    agents = client.get("/agents").json()
    assert any(g.get("default") for g in agents)


def test_seed_then_state(client, home):
    from autodave.storage import store
    from seed_data import seed

    seed(store)
    r = client.get("/state").json()
    names = {a["name"] for a in r["autos"]}
    assert names == {"Track manga chapters", "Nightly folder backup",
                     "Weekly report email", "Clean screenshots folder"}
    assert len(r["execs"]) >= 10
    statuses = {e["status"] for e in r["execs"]}
    assert {"succeeded", "failed", "cancelled", "interrupted"} <= statuses
    manga = next(a for a in r["autos"] if a["name"] == "Track manga chapters")
    assert manga["version"] == 3
    assert manga["latest"]["chip"] == "2 new chapters"
    assert manga["triggerChip"] == "Daily 8:00"
    assert len(manga["versions"]) == 2  # v2, v1 in history
    secrets = {s["name"] for s in r["secrets"]}
    assert secrets == {"SMTP_PASSWORD", "VAULT_DRIVE_KEY"}
    report = next(a for a in r["autos"] if a["name"] == "Weekly report email")
    assert "SMTP_PASSWORD" in report["allowedSecrets"]

    # terminal seeded executions carry finished_at (started + duration)
    for h in store.execs.values():
        if h["status"] in ("succeeded", "failed", "cancelled", "interrupted"):
            assert h.get("finished_at"), h["id"]

    # §4.5 manga result: Summary values in result.yaml, the table as a result.md
    # markdown file, files listing = the dir listing, path for Show in Finder
    manga_execs = [e for e in r["execs"] if e["autoName"] == "Track manga chapters"]
    fulls = [client.get(f"/executions/{e['id']}").json() for e in manga_execs]
    tabled = next(f for f in fulls if f.get("result") and f["result"].get("chip") == "2 new chapters")
    assert any(v["name"] == "New chapters" and isinstance(v["value"], list)
               for v in tabled["result"]["values"])
    assert [f["name"] for f in tabled["result"]["files"]] == ["result.md", "result.yaml"]
    assert tabled["result"]["path"].endswith("result")
    md = client.get(f"/executions/{tabled['id']}/result/result.md")
    assert md.status_code == 200 and "| Manga |" in md.text
    assert client.get(f"/executions/{tabled['id']}/result/nope.md").status_code == 404

    # logs.ndjson lines are {ts, t, step, k, text}; step markers carry their step's name
    raw = store.read_logs(tabled["id"])
    assert raw and all(set(l) == {"ts", "t", "step", "k", "text"} for l in raw)
    first = raw[0]
    assert first["text"].startswith("▸ Step 1") and first["step"] == "Read your manga list"
    step2 = next(l for l in raw if l["text"].startswith("▸ Step 2"))
    assert step2["step"] == "Check each site for new chapters"
    # a line before any step marker is execution-level (step: null)
    shots_int = next(e for e in r["execs"] if e["status"] == "interrupted")
    int_logs = store.read_logs(shots_int["id"])
    assert int_logs and int_logs[0]["step"] is None


def test_settings_devmode_gates_request_logging(client):
    import logging

    from autodave.main import _DevModeFilter

    # §4.9: default off; PATCH persists it
    assert client.get("/settings").json()["devMode"] is False
    flt = _DevModeFilter()
    info = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                             "GET /state", None, None)
    warn = logging.LogRecord("autodave.api", logging.WARNING, __file__, 1,
                             "boom", None, None)
    # §5: off → warnings only
    assert not flt.filter(info)
    assert flt.filter(warn)
    assert client.patch("/settings", json={"devMode": True}).json()["devMode"] is True
    # §5: the filter reads the live setting — no restart needed
    assert flt.filter(info)


def test_packages_outdated_and_update(client, monkeypatch):
    from autodave import packages as pkglib
    from autodave.storage import store

    monkeypatch.setattr(pkglib, "_latest_compatible",
                        lambda name: {"pandas": "2.2.4", "numpy": "2.0.0"}.get(name))
    r = client.post("/packages/outdated", json={"packages": [
        {"pip": "pandas==2.2.3", "import": "pandas"},   # newer exists
        {"pip": "numpy==2.0.0", "import": "numpy"},     # already at latest
        {"pip": "left_pad==1.0", "import": "left_pad"},  # no lookup result
    ]}).json()["packages"]
    assert r[0]["latest"] == "2.2.4"
    assert "latest" not in r[1] and "latest" not in r[2]

    a = store.create_automation(
        make_version(packages=[{"pip": "pandas==2.2.3", "import": "pandas"}]), "Pin Me", None)
    monkeypatch.setattr(pkglib, "ensure",
                        lambda entries, on_progress=None:
                        [{**e, "status": "installed"} for e in entries])
    r = client.post("/packages/update", json={"packages": [
        {"pip": "pandas==2.2.4", "import": "pandas"}]}).json()
    assert r["updated"] == ["Pin Me"]
    assert r["packages"][0] == {"pip": "pandas==2.2.4", "import": "pandas", "status": "installed"}
    assert store.autos[a["id"]]["versions"][1]["packages"][0]["pip"] == "pandas==2.2.4"

    # malformed pin → 422, nothing rewritten
    assert client.post("/packages/update",
                       json={"packages": [{"pip": "pandas>=2.0", "import": "pandas"}]}).status_code == 422
