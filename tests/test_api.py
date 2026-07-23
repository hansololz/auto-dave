import importlib
import time

import pytest
from fastapi.testclient import TestClient

from conftest import make_version


@pytest.fixture()
def client(home):
    from autowright import api
    from autowright.storage import store

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
    from autowright.drafting import CONTRACT_PREAMBLE, DEFAULT_INSTRUCTIONS

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
    from autowright.drafting import DEFAULT_INSTRUCTIONS
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


def test_create_draft_grants_all_agents_by_default(client, monkeypatch):
    # §19: no enabledAgents + no stored automation → every configured agent is granted
    from autowright import api
    from autowright.storage import store

    store.agents.append({"id": "second", "harness": "Claude Code", "mode": "default",
                         "model": None, "default": False})
    captured = {}

    def fake_start(mode, agent, user_text, current, grants):
        captured["grants"] = grants
        return "job-x"

    monkeypatch.setattr(api.draft_jobs, "start", fake_start)
    r = client.post("/drafts", json={"mode": "create", "text": "x", "agentId": "mock"})
    assert r.status_code == 200
    assert len(captured["grants"]["agents"]) == 2


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
    from autowright.storage import store

    # sync: the caller already holds the spec — the blocked payload carries none
    a = store.create_automation(make_version(), "Sync blocked", "mock")
    r = client.post("/drafts", json={"mode": "sync", "autoId": a["id"], "agentId": "mock",
                                     "spec": "# blocked-steps title\n\nBody."})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "blocked", j
    assert j["blockedAt"] == "steps"
    assert j["draft"] is None


def test_sync_uses_provided_spec(client):
    from autowright import paths
    from autowright.storage import store

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
    from autowright import paths
    from autowright.storage import store

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
    from autowright import paths
    from autowright.storage import store

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


def test_execution_and_execution_pages(client):
    from autowright.storage import store

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
    assert "logs" not in e  # §19: logs are lazy, never inline
    assert [s["status"] for s in e["steps"]] == ["succeeded", "succeeded"]
    assert all(len(s["attempts"]) == 1 for s in e["steps"])
    # §19 lazy log endpoint: per step attempt, and the execution log
    step_log = client.get(f"/executions/{exec_id}/logs", params={"step": 0, "attempt": 1}).json()
    assert any(l["k"] == "sys" for l in step_log["lines"])
    assert all({"t", "k", "seq", "text"} == set(l) for l in step_log["lines"])
    assert client.get(f"/executions/{exec_id}/logs").json()["lines"] == []
    assert client.get(f"/executions/{exec_id}/logs", params={"step": 9, "attempt": 1}).json()["lines"] == []
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
    from autowright import api

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


def _until_finished(events, exec_id, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        e = next((e for e in events if e["ev"] == "exec.finished" and e["execId"] == exec_id), None)
        if e:
            return e
        time.sleep(0.05)
    raise AssertionError(f"exec.finished never arrived (got {[e['ev'] for e in events]})")


def test_test_param_values_override(client, monkeypatch):
    # §19: paramValues override the defaults for this test only; the result is
    # an ordinary execution record's.
    events = _capture_events(monkeypatch)
    r = client.post("/tests", json={"draft": _echo_draft(), "paramValues": {"greeting": "bonjour"}})
    assert r.status_code == 200
    eid = r.json()["execId"]
    assert _until_finished(events, eid)["exec_json"]["status"] == "succeeded"
    full = client.get(f"/executions/{eid}").json()
    assert full["test"] is True and full["ver"] == "Test" and full["trigger"] == "Test"
    assert full["result"]["chip"] == "bonjour"
    logs = [e["line"]["text"] for e in events if e["ev"] == "exec.log"]
    assert any("greeting=bonjour" in t for t in logs)


def test_test_stored_values_and_flagged_record(client, monkeypatch):
    # §19: with autoId (edit mode) the stored values are the base; the record is
    # flagged test and never touches the automation's derived display state.
    from autowright.storage import store

    events = _capture_events(monkeypatch)
    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    client.patch(f"/automations/{auto['id']}", json={"paramValues": {"greeting": "stored-hi"}})
    events.clear()
    r = client.post("/tests", json={"draft": _echo_draft(), "autoId": auto["id"]})
    assert r.status_code == 200
    eid = r.json()["execId"]
    _until_finished(events, eid)
    logs = [e["line"]["text"] for e in events if e["ev"] == "exec.log"]
    assert any("greeting=stored-hi" in t for t in logs)
    assert store.execs[eid]["test"] is True
    aj = client.get(f"/automations/{auto['id']}").json()
    assert aj["lastStatus"] == "none" and aj["latest"] is None


def test_test_resolves_default_after_editor_roundtrip(client, monkeypatch):
    # §4.2 regression: the automation JSON's params keep `default` — edit mode
    # seeds the draft's defs from that shape, so a test with no stored value and
    # no paramValues must still resolve the definition's default.
    events = _capture_events(monkeypatch)
    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    aj = client.get(f"/automations/{auto['id']}").json()
    assert aj["params"][0]["default"] == "hello"
    events.clear()
    r = client.post("/tests", json={"draft": _echo_draft(params=aj["params"]),
                                    "autoId": auto["id"]})
    assert r.status_code == 200
    eid = r.json()["execId"]
    assert _until_finished(events, eid)["exec_json"]["status"] == "succeeded"
    logs = [e["line"]["text"] for e in events if e["ev"] == "exec.log"]
    assert any("greeting=hello" in t for t in logs)


def test_test_failure_analyzes_on_demand_only(client, monkeypatch):
    # §11: a failed test is never analyzed automatically — the §8 issue-analysis
    # call runs on POST /tests/{execId}/analyze and its blockers ride test.issue.
    events = _capture_events(monkeypatch)
    d = _echo_draft(steps=[{"file": "01-boom.py", "name": "Boom", "desc": "",
                            "code": "raise KeyError('missing')\n"}])
    r = client.post("/tests", json={"draft": d})
    assert r.status_code == 200
    eid = r.json()["execId"]
    assert _until_finished(events, eid)["exec_json"]["status"] == "failed"
    time.sleep(0.3)
    assert not any(e["ev"] == "test.issue" for e in events)  # nothing analyzed by itself

    assert client.post(f"/tests/{eid}/analyze",
                       json={"draft": d, "agentId": "mock"}).status_code == 200
    issue = _until(events, "test.issue")
    assert issue["execId"] == eid
    assert issue["blockers"][0]["reason"] == "The task needs access to physical mail."


def test_test_analyze_guards(client, monkeypatch):
    # §19: 404 for an unknown record, 409 unless the test failed.
    events = _capture_events(monkeypatch)
    assert client.post("/tests/nope/analyze", json={"draft": {}}).status_code == 404
    eid = client.post("/tests", json={"draft": _echo_draft()}).json()["execId"]
    _until_finished(events, eid)  # succeeded
    assert client.post(f"/tests/{eid}/analyze", json={"draft": _echo_draft()}).status_code == 409


def test_test_cancel(client, monkeypatch):
    # §19: cancel goes through the ordinary execution cancel.
    events = _capture_events(monkeypatch)
    d = _echo_draft(steps=[{"file": "01-slow.py", "name": "Slow", "desc": "",
                            "code": "import time\nlog('sleeping')\ntime.sleep(60)\n"}])
    eid = client.post("/tests", json={"draft": d}).json()["execId"]
    t0 = time.time()
    while time.time() - t0 < 10:  # wait until the step subprocess is live
        if any(e["ev"] == "exec.log" and e["line"]["text"] == "sleeping" for e in events):
            break
        time.sleep(0.05)
    assert client.post(f"/executions/{eid}/cancel").json()["ok"]
    assert _until_finished(events, eid)["exec_json"]["status"] == "cancelled"


def test_test_409_while_live(client, monkeypatch):
    # §19: one live test per draft container.
    events = _capture_events(monkeypatch)
    d = _echo_draft(steps=[{"file": "01-slow.py", "name": "Slow", "desc": "",
                            "code": "import time\nlog('sleeping')\ntime.sleep(60)\n"}])
    eid = client.post("/tests", json={"draft": d}).json()["execId"]
    assert client.post("/tests", json={"draft": d}).status_code == 409
    client.post(f"/executions/{eid}/cancel")
    _until_finished(events, eid)


def test_patch_automation_triggers_and_grants(client):
    from autowright.storage import store

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


def test_app_started_fires_enabled_app_start_triggers(client, monkeypatch):
    # §6 app-start firing: POST /app-started executes every automation with an
    # enabled app_start trigger; off ones stay quiet.
    from autowright.storage import store

    events = _capture_events(monkeypatch)
    a = store.create_automation(make_version(), "On start", "mock")
    b = store.create_automation(make_version(), "On start (off)", "mock")
    assert client.patch(f"/automations/{a['id']}",
                        json={"triggers": [{"kind": "app_start", "off": False}]}).status_code == 200
    assert client.patch(f"/automations/{b['id']}",
                        json={"triggers": [{"kind": "app_start", "off": True}]}).status_code == 200
    # a second app_start in one list → 422 (§4.3)
    r = client.patch(f"/automations/{a['id']}", json={
        "triggers": [{"kind": "app_start", "off": False}, {"kind": "app_start", "off": False}]})
    assert r.status_code == 422

    assert client.post("/app-started").json() == {"fired": 1}
    _until(events, "exec.finished")
    execs = client.get("/executions").json()
    assert [e["trigger"] for e in execs if e["autoId"] == a["id"]] == ["App start"]
    assert [e for e in execs if e["autoId"] == b["id"]] == []
    # §4.3 derived display: app_start contributes no nextAt
    j = client.get(f"/automations/{a['id']}").json()
    assert j["nextAt"] is None
    assert j["triggers"][0]["label"] == "On app start"
    assert j["triggerChip"] == "App start"


def test_patch_automation_triggers_422(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Strict", "mock")
    # message kinds are reserved (§4.3), bad cron and past one-shots are refused
    for bad in ([{"kind": "discord"}],
                [{"kind": "cron", "expr": "not cron"}],
                [{"kind": "time", "at": "2020-01-01T00:00"}]):
        r = client.patch(f"/automations/{a['id']}", json={"triggers": bad})
        assert r.status_code == 422
    assert store.autos[a["id"]]["triggers"] == []  # nothing stored


def test_save_version_and_restore(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Versioner", "mock")
    r = client.post(f"/automations/{a['id']}/versions",
                    json={"draft": make_version(desc="second", note="Change")})
    assert r.json()["version"] == 2
    r = client.post(f"/automations/{a['id']}/restore", json={"v": 1})
    assert r.json()["version"] == 3
    j = client.get(f"/automations/{a['id']}").json()
    assert [v["v"] for v in j["versions"]] == [2, 1]


def test_save_version_applies_draft_triggers(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Scheduled", "mock",
                                triggers=[{"id": "t1", "kind": "cron", "expr": "0 8 * * *", "off": True},
                                          {"id": "t2", "kind": "time", "at": "2999-01-01T00:00", "off": False}])
    # §4.3 cron-subset replace: sent list (the editor's merge) replaces whole;
    # sent ids survive, new entries get one assigned
    r = client.post(f"/automations/{a['id']}/versions", json={"draft": {
        **make_version(desc="second"),
        "triggers": [{"id": "t1", "kind": "cron", "expr": "0 8 * * *", "off": True},
                     {"kind": "cron", "expr": "30 9 * * 1", "off": False},
                     {"id": "t2", "kind": "time", "at": "2999-01-01T00:00", "off": False}],
    }})
    assert r.status_code == 200
    trigs = r.json()["auto"]["triggers"]
    assert [t.get("id") for t in trigs][0] == "t1" and trigs[0]["off"] is True
    assert trigs[1]["expr"] == "30 9 * * 1" and trigs[1]["id"]
    assert trigs[2]["id"] == "t2"

    # invalid trigger → 422 and no version minted
    r = client.post(f"/automations/{a['id']}/versions", json={"draft": {
        **make_version(), "triggers": [{"kind": "cron", "expr": "junk"}],
    }})
    assert r.status_code == 422
    assert store.autos[a["id"]]["current_version"] == 2

    # no triggers key → the stored list is untouched
    r = client.post(f"/automations/{a['id']}/versions", json={"draft": make_version()})
    assert r.status_code == 200
    assert [t["id"] for t in r.json()["auto"]["triggers"]] == ["t1", trigs[1]["id"], "t2"]


def test_edit_draft_snapshot_carries_triggers(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Drafted", "mock")
    r = client.put(f"/automations/{a['id']}/draft", json={"draft": {
        **make_version(), "triggers": [{"kind": "cron", "expr": "15 7 * * *", "off": False}],
    }})
    assert r.status_code == 200
    d = client.get(f"/automations/{a['id']}").json()["draft"]
    assert d["triggers"] == [{"kind": "cron", "expr": "15 7 * * *", "off": False}]
    # the automation's live triggers stay untouched until the draft is saved
    assert store.autos[a["id"]]["triggers"] == []


def test_delete_agent_reassigns_default(client):
    from autowright.storage import store

    r = client.post("/agents", json={"harness": "OpenCode", "mode": "ollama",
                                     "model": "qwen3:8b", "name": "Local"})
    new_id = r.json()["id"]
    client.patch(f"/agents/{new_id}", json={"default": True})
    r = client.delete(f"/agents/{new_id}")
    assert r.status_code == 200
    agents = client.get("/agents").json()
    assert any(g.get("default") for g in agents)


def test_seed_then_state(client, home):
    from autowright.storage import store
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

    # §5 logs/ layout: per-step-attempt files, lines {ts, t, k, seq, text}
    step1 = store.read_log(tabled["id"], 0, 1)
    assert step1 and all(set(l) == {"ts", "t", "k", "seq", "text"} for l in step1)
    assert step1[0]["text"].startswith("▸ Step 1")
    step2 = store.read_log(tabled["id"], 1, 1)
    assert any(l["text"].startswith("▸ Step 2") for l in step2)
    # a line before any step marker is execution-level → execution.ndjson
    shots_int = next(e for e in r["execs"] if e["status"] == "interrupted")
    int_logs = store.read_log(shots_int["id"])
    assert int_logs and "went to sleep" in int_logs[0]["text"]
    # §16: the retried report execution's failing step carries two attempts
    retried = next(f for f in (client.get(f"/executions/{e['id']}").json()
                               for e in r["execs"] if e["trigger"] == "Manual"
                               and e["autoName"] == "Weekly report email")
                   if any(len(s["attempts"]) == 2 for s in f["steps"]))
    send = next(s for s in retried["steps"] if s["name"] == "Send the email")
    assert [x["n"] for x in send["attempts"]] == [1, 2]


def test_settings_devmode_gates_request_logging(client):
    import logging

    from autowright.main import _DevModeFilter

    # §4.9: default off; PATCH persists it
    assert client.get("/settings").json()["devMode"] is False
    flt = _DevModeFilter()
    info = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                             "GET /state", None, None)
    warn = logging.LogRecord("autowright.api", logging.WARNING, __file__, 1,
                             "boom", None, None)
    # §5: off → warnings only
    assert not flt.filter(info)
    assert flt.filter(warn)
    assert client.patch("/settings", json={"devMode": True}).json()["devMode"] is True
    # §5: the filter reads the live setting — no restart needed
    assert flt.filter(info)


def test_packages_outdated_and_update(client, monkeypatch):
    from autowright import packages as pkglib

    # §6.2: the installed distribution is the comparison baseline for `latest`.
    monkeypatch.setattr(pkglib, "_installed_versions",
                        lambda: {"pandas": "2.2.3", "numpy": "2.0.0"})
    monkeypatch.setattr(pkglib, "_latest_compatible",
                        lambda name: {"pandas": "2.2.4", "numpy": "2.0.0"}.get(name))
    r = client.post("/packages/outdated", json={"packages": [
        {"pip": "pandas", "import": "pandas"},     # newer exists
        {"pip": "numpy", "import": "numpy"},       # already at latest
        {"pip": "left_pad", "import": "left_pad"},  # not installed → no badge
    ]}).json()["packages"]
    assert r[0]["latest"] == "2.2.4"
    assert "latest" not in r[1] and "latest" not in r[2]

    # §19 update: pip install --upgrade, no manifest writes.
    monkeypatch.setattr(pkglib, "upgrade",
                        lambda entries: [{**e, "status": "installed", "version": "2.2.4"}
                                         for e in entries])
    r = client.post("/packages/update", json={"packages": [
        {"pip": "pandas", "import": "pandas"}]}).json()
    assert r["packages"][0] == {"pip": "pandas", "import": "pandas",
                                "status": "installed", "version": "2.2.4"}

    # a version specifier is malformed now → 422
    assert client.post("/packages/update",
                       json={"packages": [{"pip": "pandas==2.2.4", "import": "pandas"}]}).status_code == 422


def test_memory_snapshot_endpoints(client):
    # §6.3/§19: manual snapshot, rename, restore, delete; pre-clear rides clear.
    from autowright.storage import store

    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    a = store.autos[auto["id"]]
    base = f"/automations/{auto['id']}/memory/snapshots"

    # empty memory → 422; unknown automation → 404
    assert client.post(base, json={"name": "x"}).status_code == 422
    assert client.post("/automations/nope/memory/snapshots", json={}).status_code == 404

    (store.auto_dir(a) / "memory" / "seen.yaml").write_text("v: old\n")
    r = client.post(base, json={"name": "  before edit  "})
    assert r.status_code == 200
    snap = r.json()["snapshot"]
    assert snap["name"] == "before edit" and snap["reason"] == "manual"

    # full automation JSON carries the newest-first list (§4.1)
    j = client.get(f"/automations/{auto['id']}").json()
    assert [s["id"] for s in j["snapshots"]] == [snap["id"]]

    # rename (empty clears), unknown sid → 404
    assert client.patch(f"{base}/{snap['id']}", json={"name": "pinned"}).json()["snapshot"]["name"] == "pinned"
    assert client.patch(f"{base}/{snap['id']}", json={"name": ""}).json()["snapshot"]["name"] is None
    assert client.patch(f"{base}/{'0' * 36}", json={"name": "x"}).status_code == 404

    # clear takes a pre-clear snapshot first (§6.3), then empties memory
    assert client.post(f"/automations/{auto['id']}/memory/clear").status_code == 200
    assert not (store.auto_dir(a) / "memory" / "seen.yaml").exists()
    reasons = [s["reason"] for s in store.list_snapshots(a)]
    assert "pre-clear" in reasons

    # restore brings the snapshot's copy back (memory now empty → no pre-restore)
    assert client.post(f"{base}/{snap['id']}/restore").status_code == 200
    assert (store.auto_dir(a) / "memory" / "seen.yaml").read_text() == "v: old\n"
    assert client.post(f"{base}/{'0' * 36}/restore").status_code == 404

    # delete
    assert client.delete(f"{base}/{snap['id']}").status_code == 200
    assert client.delete(f"{base}/{snap['id']}").status_code == 404


def test_patch_snapshot_settings_and_gated_clear(client):
    # §19 PATCH snapshotSettings: partial merge; §6.3 pre-clear off → clear leaves no snapshot.
    from autowright.storage import store

    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    a = store.autos[auto["id"]]
    assert auto["snapshotSettings"] == {"preVersion": True, "preClear": True, "preRestore": True}

    r = client.patch(f"/automations/{auto['id']}", json={"snapshotSettings": {"preClear": False}})
    assert r.status_code == 200
    assert r.json()["snapshotSettings"] == {"preVersion": True, "preClear": False, "preRestore": True}

    (store.auto_dir(a) / "memory" / "seen.yaml").write_text("v: old\n")
    assert client.post(f"/automations/{auto['id']}/memory/clear").status_code == 200
    assert not (store.auto_dir(a) / "memory" / "seen.yaml").exists()
    assert store.list_snapshots(a) == []


def test_memory_snapshot_409_while_live(client):
    # §6.3: manual snapshot and restore are blocked while an execution is live.
    from autowright.storage import store

    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    a = store.autos[auto["id"]]
    (store.auto_dir(a) / "memory" / "seen.yaml").write_text("v: 1\n")
    base = f"/automations/{auto['id']}/memory/snapshots"
    snap = client.post(base, json={}).json()["snapshot"]

    a["_live"] = "fake-exec-id"
    try:
        assert client.post(base, json={}).status_code == 409
        assert client.post(f"{base}/{snap['id']}/restore").status_code == 409
    finally:
        a["_live"] = None


def test_check_harness_endpoint(client, monkeypatch):
    # §19: the §4.7 readiness check before an agent record exists (§10 cards).
    from autowright import harness

    monkeypatch.setattr(harness, "check_ready",
                        lambda name, model=None, mode="default": name == "Codex")
    assert client.post("/agents/check-harness",
                       json={"harness": "Codex"}).json() == {"status": "ready"}
    assert client.post("/agents/check-harness",
                       json={"harness": "Gemini CLI"}).json() == {"status": "needs-setup"}
    assert client.post("/agents/check-harness", json={"harness": "GPT-5"}).status_code == 422


def test_signin_and_login_endpoints(client, monkeypatch):
    # §19 sign-in help: only for an installed, signed-out, account-backed provider.
    from autowright import harness, installer

    monkeypatch.setattr(harness, "signin_state",
                        lambda pid: {"installed": pid != "gemini", "signedIn": pid == "claude"})
    assert client.get("/agents/signin/codex").json() == {"installed": True, "signedIn": False}
    assert client.get("/agents/signin/nope").status_code == 422

    assert client.post("/agents/login", json={"id": "ollama"}).status_code == 409  # no account
    assert client.post("/agents/login", json={"id": "gemini"}).status_code == 409  # not installed
    assert client.post("/agents/login", json={"id": "claude"}).status_code == 409  # already signed in
    monkeypatch.setattr(installer, "login", lambda pid: "browser")
    assert client.post("/agents/login", json={"id": "codex"}).json() == {"ok": True, "method": "browser"}


def test_install_endpoints(client, monkeypatch):
    # §19: install runs in the backend; the status snapshot reattaches a remounted UI.
    from autowright import installer

    assert client.post("/agents/install", json={"id": "nope"}).status_code == 422
    assert client.get("/agents/install/claude").json() == {"state": "idle"}

    started = {}
    monkeypatch.setattr(installer, "start", lambda pid, publish: started.setdefault(pid, True))
    assert client.post("/agents/install", json={"id": "codex"}).json() == {"ok": True}
    monkeypatch.setattr(installer, "start", lambda pid, publish: False)  # already running
    assert client.post("/agents/install", json={"id": "codex"}).status_code == 409
