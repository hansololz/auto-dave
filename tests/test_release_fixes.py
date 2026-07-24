"""Regression tests for the pre-release bug sweep (2026-07)."""
import io
import zipfile

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


def _write_memory(store, a, content="items: [1]\n"):
    d = store.auto_dir(a) / "memory"
    d.mkdir(parents=True, exist_ok=True)
    (d / "seen.yaml").write_text(content)


def test_restore_survives_unnamed_prune(store):
    """Restoring the oldest of 5 unnamed snapshots must not prune the restore
    source mid-restore: the pre-restore snapshot taken inside restore is the
    6th unnamed, so the §6.3 prune targets exactly the snapshot being restored
    (it used to rmtree the target, then crash after wiping live memory)."""
    a = store.create_automation(make_version(), "Pruney", None)
    _write_memory(store, a, "items: [0]\n")
    oldest = store.snapshot_memory(a, "manual")  # unnamed
    for i in range(1, 5):
        _write_memory(store, a, f"items: [{i}]\n")
        store.snapshot_memory(a, "manual")
    _write_memory(store, a, "items: [99]\n")

    meta = store.restore_snapshot(a, oldest["id"])
    assert meta is not None and meta["id"] == oldest["id"]
    mem = store.auto_dir(a) / "memory" / "seen.yaml"
    assert mem.read_text() == "items: [0]\n"
    # §6.3: restore is repeatable — the source snapshot still exists
    assert store.get_snapshot(a, oldest["id"]) is not None
    assert store.restore_snapshot(a, oldest["id"]) is not None


def test_time_trigger_rejects_utc_offset(client):
    r = client.post("/automations", json={
        "draft": make_version(triggers=[{"kind": "time", "at": "2030-01-01T10:00+02:00"}]),
        "name": "Aware", "agentId": "mock",
    })
    assert r.status_code == 422  # used to 500 with a TypeError


def test_offset_aware_trigger_on_disk_does_not_brick_load(store, home):
    from autowright.storage import Store
    from autowright.yamlio import load_yaml, save_yaml

    a = store.create_automation(make_version(), "Diskey", None)
    y = home / "automations" / a["id"] / "automation.yaml"
    data = load_yaml(y)
    data["triggers"] = [{"id": "t-1", "kind": "time", "at": "2030-01-01T10:00+02:00"}]
    save_yaml(y, data)

    s2 = Store()
    s2.load_all()  # used to raise TypeError out of validate_trigger
    assert s2.autos[a["id"]]["triggers"] == []


def test_step_without_file_does_not_brick_load(store, home):
    from autowright.storage import Store
    from autowright.yamlio import load_yaml, save_yaml

    a = store.create_automation(make_version(), "NoFile", None)
    y = home / "automations" / a["id"] / "versions" / "v1" / "automation.yaml"
    data = load_yaml(y)
    del data["steps"][0]["file"]
    save_yaml(y, data)

    s2 = Store()
    s2.load_all()  # used to raise IsADirectoryError
    steps = s2.autos[a["id"]]["versions"][1]["steps"]
    assert steps[0]["code"] == "" and steps[1]["code"]


def test_cron_trailing_slash_rejected():
    """Backend and renderer cron parsers must agree: "5/" is invalid, not step 1."""
    import pytest as _pytest

    from autowright import schedule

    with _pytest.raises(schedule.CronError):
        schedule.parse_cron("5/ * * * *")
    schedule.parse_cron("*/5 * * * *")  # real steps still parse


def test_settings_days_validation(client):
    assert client.patch("/settings", json={"days": "ninety"}).status_code == 422
    assert client.patch("/settings", json={"notif": "sometimes"}).status_code == 422
    r = client.patch("/settings", json={"days": "14"})
    assert r.status_code == 200
    from autowright.storage import store as live_store
    assert live_store.settings["days"] == 14  # coerced to int, retention-safe


def test_import_rejects_oversized_member(client):
    from autowright import transfer

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.yaml", "\0" * (transfer._MAX_MEMBER_BYTES + 1))
    r = client.post("/automations/import", content=buf.getvalue())
    assert r.status_code == 422
    assert "large" in r.json()["detail"]


def test_draft_endpoints_409_while_draft_execution_live(client):
    from autowright.storage import store as live_store

    r = client.post("/automations", json={"draft": make_version(), "name": "Busy",
                                          "agentId": "mock"})
    auto_id = r.json()["id"]
    a = live_store.autos[auto_id]
    live_store.save_draft(a, make_version())
    h = live_store.create_execution(a, "Draft", "Manual",
                                    [{"name": "s", "file": "01-say.py", "agent": False,
                                      "status": "executing", "dur_ms": None, "attempts": []}])
    a["_live"] = h["id"]
    try:
        assert client.put(f"/automations/{auto_id}/draft",
                          json={"draft": make_version()}).status_code == 409
        assert client.delete(f"/automations/{auto_id}/draft").status_code == 409
    finally:
        a["_live"] = None
    assert client.put(f"/automations/{auto_id}/draft",
                      json={"draft": make_version()}).status_code == 200
