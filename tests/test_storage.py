from conftest import make_version


def test_create_and_reload_roundtrip(store, home):
    from autodave.storage import Store

    trig = {"id": "t-1", "kind": "cron", "off": False, "expr": "30 7 * * *"}
    a = store.create_automation(make_version(), "My Test Job", "agent-1", triggers=[trig])
    assert (home / "automations" / "my-test-job" / "versions" / "v1" / "01-say.py").exists()
    assert (home / "automations" / "my-test-job" / "versions" / "v1" / "spec.md").exists()

    s2 = Store()
    s2.load_all()
    b = s2.autos[a["id"]]
    assert b["name"] == "My Test Job"
    assert b["triggers"] == [trig]
    assert s2.auto_json(b)["triggerChip"] == "Daily 7:30"
    ver = b["versions"][1]
    assert ver["steps"][0]["name"] == "Say hello"
    assert "params['greeting']" in ver["steps"][0]["code"]
    assert ver["spec"][0] == {"k": "h1", "text": "Test automation"}


def test_no_triggers_roundtrip(store, home):
    from autodave.storage import Store

    # No triggers given -> manual / menu bar only.
    a = store.create_automation(make_version(), "No Trigger Job", "agent-1")
    assert a["triggers"] == []

    s2 = Store()
    s2.load_all()
    b = s2.autos[a["id"]]
    assert b["triggers"] == []
    j = s2.auto_json(b)
    assert j["triggerChip"] == "No triggers"
    assert j["triggersOff"] is False
    assert j["nextAt"] is None


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


def test_update_package_pin_rewrites_every_declarer(store):
    from autodave.storage import Store

    pkgs = [{"pip": "pandas==2.2.3", "import": "pandas"}]
    a = store.create_automation(make_version(packages=pkgs), "Uses Pandas", None)
    b = store.create_automation(
        make_version(packages=[{"pip": "Pandas==2.1.0", "import": "pandas"},
                               {"pip": "numpy==2.0.0", "import": "numpy"}]),
        "Also Pandas", None)
    c = store.create_automation(make_version(), "No Packages", None)
    store.save_draft(b, make_version(packages=[{"pip": "pandas==2.0.0", "import": "pandas"}]))
    # older version keeps its pin (§6.2): bump a to v2 first
    store.save_new_version(a, make_version(packages=pkgs, note="Second"))

    affected = store.update_package_pin("pandas==2.2.4")
    assert sorted(affected) == ["Also Pandas", "Uses Pandas"]

    s2 = Store()
    s2.load_all()
    a2, b2, c2 = s2.autos[a["id"]], s2.autos[b["id"]], s2.autos[c["id"]]
    # current versions + draft rewritten (name matching is PEP 503-normalized)
    assert a2["versions"][2]["packages"][0]["pip"] == "pandas==2.2.4"
    assert b2["versions"][1]["packages"][0]["pip"] == "pandas==2.2.4"
    assert b2["versions"][1]["packages"][1]["pip"] == "numpy==2.0.0"
    assert b2["draft"]["packages"][0]["pip"] == "pandas==2.2.4"
    # older version untouched; undeclaring automation untouched
    assert a2["versions"][1]["packages"][0]["pip"] == "pandas==2.2.3"
    assert c2["versions"][1].get("packages") == []


def test_update_package_pin_noop_when_already_pinned(store):
    store.create_automation(
        make_version(packages=[{"pip": "pandas==2.2.4", "import": "pandas"}]), "Current", None)
    assert store.update_package_pin("pandas==2.2.4") == []


# ---------- §6.3 memory snapshots ----------

def _write_memory(store, a, name="seen.yaml", text="items: [1]\n"):
    d = store.auto_dir(a) / "memory"
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(text)


def test_snapshot_create_layout_and_list(store, home):
    a = store.create_automation(make_version(), "Snappy", None)
    # empty memory is never snapshotted (§6.3)
    assert store.snapshot_memory(a, "pre-clear") is None
    assert store.list_snapshots(a) == []

    _write_memory(store, a)
    m = store.snapshot_memory(a, "manual", name="first")
    d = home / "automations" / "snappy" / "memory-snapshots" / m["id"]
    assert (d / "snapshot.yaml").exists()
    assert (d / "memory" / "seen.yaml").read_text() == "items: [1]\n"
    assert m["reason"] == "manual" and m["name"] == "first"
    assert m["version"] == "v1" and m["files"] == 1 and m["size"] > 0

    snaps = store.list_snapshots(a)
    assert [s["id"] for s in snaps] == [m["id"]]
    j = store.auto_json(a)["snapshots"][0]
    assert j["id"] == m["id"] and j["name"] == "first" and j["files"] == 1
    assert j["version"] == "v1" and j["reason"] == "manual"


def test_snapshot_restore_takes_pre_restore_copy(store):
    a = store.create_automation(make_version(), "Restorer", None)
    _write_memory(store, a, text="v: old\n")
    m = store.snapshot_memory(a, "manual")
    _write_memory(store, a, text="v: new\n")

    assert store.restore_snapshot(a, m["id"]) is not None
    mem = store.auto_dir(a) / "memory"
    assert (mem / "seen.yaml").read_text() == "v: old\n"
    reasons = [s["reason"] for s in store.list_snapshots(a)]
    # restored snapshot stays; current memory was saved as pre-restore first
    assert sorted(reasons) == ["manual", "pre-restore"]
    pre = next(s for s in store.list_snapshots(a) if s["reason"] == "pre-restore")
    pre_dir = store.snapshots_dir(a) / pre["id"] / "memory"
    assert (pre_dir / "seen.yaml").read_text() == "v: new\n"


def test_snapshot_rename_and_delete(store):
    a = store.create_automation(make_version(), "Renamer", None)
    _write_memory(store, a)
    m = store.snapshot_memory(a, "manual")
    assert store.rename_snapshot(a, m["id"], "  pinned  ")["name"] == "pinned"
    assert store.rename_snapshot(a, m["id"], "")["name"] is None
    assert store.rename_snapshot(a, "0" * 36, "x") is None
    # sid is validated before any path join — traversal shapes are rejected
    assert store.get_snapshot(a, "../../../etc/passwd") is None
    assert store.delete_snapshot(a, "../memory") is False
    assert store.delete_snapshot(a, m["id"]) is True
    assert store.list_snapshots(a) == []
    assert store.delete_snapshot(a, m["id"]) is False


def test_snapshot_retention_prunes_unnamed_keeps_named(store):
    a = store.create_automation(make_version(), "Pruner", None)
    _write_memory(store, a)
    named = store.snapshot_memory(a, "manual", name="keep me")
    for _ in range(8):
        store.snapshot_memory(a, "manual")
    snaps = store.list_snapshots(a)
    unnamed = [s for s in snaps if not s["name"]]
    assert len(unnamed) == 5  # §6.3: newest 5 unnamed survive
    assert any(s["id"] == named["id"] for s in snaps)  # named never auto-deleted


def test_snapshot_orphan_dirs_skipped_and_swept(store):
    a = store.create_automation(make_version(), "Orphan", None)
    _write_memory(store, a)
    orphan = store.snapshots_dir(a) / "deadbeef-dead-dead-dead-deadbeefdead"
    (orphan / "memory").mkdir(parents=True)
    assert store.list_snapshots(a) == []  # no snapshot.yaml → skipped
    store.snapshot_memory(a, "manual")
    assert not orphan.exists()  # swept at the next creation
    assert len(store.list_snapshots(a)) == 1
