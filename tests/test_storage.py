from conftest import make_version


def test_create_and_reload_roundtrip(store, home):
    from autodave.storage import Store

    a = store.create_automation(make_version(), "My Test Job", "agent-1", hour=7, minute=30)
    assert (home / "automations" / "my-test-job" / "versions" / "v1" / "01-say.py").exists()
    assert (home / "automations" / "my-test-job" / "versions" / "v1" / "spec.md").exists()

    s2 = Store()
    s2.load_all()
    b = s2.autos[a["id"]]
    assert b["name"] == "My Test Job"
    assert b["hour"] == 7 and b["min"] == 30
    ver = b["versions"][1]
    assert ver["steps"][0]["name"] == "Say hello"
    assert "params['greeting']" in ver["steps"][0]["code"]
    assert ver["spec"][0] == {"k": "h1", "text": "Test automation"}


def test_no_schedule_roundtrip(store, home):
    from autodave.storage import Store

    # No hour given -> no schedule (manual / menu bar only).
    a = store.create_automation(make_version(), "No Sched Job", "agent-1")
    assert a["hour"] is None

    s2 = Store()
    s2.load_all()
    b = s2.autos[a["id"]]
    assert b["hour"] is None
    assert s2.auto_json(b)["schedule"] == "No schedule"
    assert s2.auto_json(b)["scheduleShort"] == "No schedule"


def test_versioning_and_restore(store):
    a = store.create_automation(make_version(), "Versioned", None)
    n = store.save_new_version(a, make_version(desc="v2 desc", note="Second"))
    assert n == 2 and a["current_version"] == 2
    # restore v1 → becomes v3; v1/v2 untouched
    n = store.restore_version(a, 1)
    assert n == 3 and a["current_version"] == 3
    assert a["versions"][3]["note"] == "Restored from v1"
    assert set(a["versions"]) == {1, 2, 3}


def test_draft_save_and_discard(store):
    a = store.create_automation(make_version(), "Drafty", None)
    store.save_draft(a, make_version(desc="draft desc"))
    assert a["draft"]["desc"] == "draft desc"
    assert (store.auto_dir(a) / "draft" / "automation.yaml").exists()
    store.delete_draft(a)
    assert a["draft"] is None
    assert not (store.auto_dir(a) / "draft").exists()


def test_rename_moves_directory(store):
    a = store.create_automation(make_version(), "Old Name", None)
    old_dir = store.auto_dir(a)
    store.patch_automation(a, {"name": "Brand New Name"})
    assert not old_dir.exists()
    assert store.auto_dir(a).name == "brand-new-name"
    # id unchanged; cross-references by id survive renames (§5)
    assert store.autos[a["id"]]["name"] == "Brand New Name"


def test_slug_collision_gets_id_suffix(store):
    a1 = store.create_automation(make_version(), "Same Name", None)
    a2 = store.create_automation(make_version(), "Same Name", None)
    assert a1["slug"] == "same-name"
    assert a2["slug"].startswith("same-name-") and len(a2["slug"]) > len("same-name-")


def test_param_value_resolution(store):
    from autodave.storage import resolve_param_value

    d = {"name": "count", "kind": "number", "min": 1, "default": 3}
    assert resolve_param_value(d, {}) == 3
    assert resolve_param_value(d, {"count": 9}) == 9
    warns = []
    assert resolve_param_value(d, {"count": "nine"}, warns) == 3  # kind mismatch → default + warning
    assert warns


def test_permissions_never_versioned(store):
    """§5: enabled_agents / allowed_secrets live only in the top-level file."""
    a = store.create_automation(make_version(), "Perms", None)
    store.patch_automation(a, {"allowedSecrets": ["TOKEN_A"]})
    store.save_new_version(a, make_version(note="v2"))
    import yaml

    vy = yaml.safe_load((store.auto_dir(a) / "versions" / "v2" / "automation.yaml").read_text())
    assert "allowed_secrets" not in vy and "enabled_agents" not in vy
    top = yaml.safe_load((store.auto_dir(a) / "automation.yaml").read_text())
    assert top["allowed_secrets"] == ["TOKEN_A"]


def test_retention_cleanup(store):
    from datetime import datetime, timedelta

    a = store.create_automation(make_version(), "Retained", None)
    h_old = store.create_execution(a, "v1", "Manual", [], status="succeeded")
    h_old["started_at"] = (datetime.now() - timedelta(days=120)).isoformat(timespec="seconds")
    store.update_execution(h_old)
    h_new = store.create_execution(a, "v1", "Manual", [], status="succeeded")
    store.update_execution(h_new)
    store.settings["days"] = 90
    assert store.retention_cleanup() == 1
    assert h_old["id"] not in store.execs and h_new["id"] in store.execs
    store.settings["keepForever"] = True
    assert store.retention_cleanup() == 0
