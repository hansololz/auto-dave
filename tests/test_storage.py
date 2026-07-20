from conftest import make_version


def test_create_and_reload_roundtrip(store, home):
    from autodave.storage import Store

    trig = {"id": "t-1", "kind": "cron", "off": False, "expr": "30 7 * * *"}
    a = store.create_automation(make_version(), "My Test Job", "agent-1", triggers=[trig])
    assert (home / "automations" / a["id"] / "versions" / "v1" / "01-say.py").exists()
    assert (home / "automations" / a["id"] / "versions" / "v1" / "spec.md").exists()

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
    assert (store.auto_dir(a) / "draft" / "automation" / "automation.yaml").exists()
    # §4.4: draft/memory survives a re-save of the working copy…
    dmem = store.auto_dir(a) / "draft" / "memory"
    dmem.mkdir()
    (dmem / "seen.yaml").write_text("x: 1")
    store.save_draft(a, make_version(desc="draft desc 2"))
    assert (dmem / "seen.yaml").exists()
    # …and dies with the draft.
    store.delete_draft(a)
    assert a["draft"] is None
    assert not (store.auto_dir(a) / "draft").exists()


def test_rename_keeps_directory(store):
    a = store.create_automation(make_version(), "Old Name", None)
    old_dir = store.auto_dir(a)
    store.patch_automation(a, {"name": "Brand New Name"})
    # §5: directories are named by id — a rename never moves them
    assert store.auto_dir(a) == old_dir and old_dir.exists()
    assert store.auto_dir(a).name == a["id"]
    assert store.autos[a["id"]]["name"] == "Brand New Name"


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


def test_packages_persist_as_bare_names(store):
    from autodave.storage import Store

    # §6.2: manifests carry bare distribution names — no version anywhere.
    pkgs = [{"pip": "pandas", "import": "pandas"}]
    a = store.create_automation(make_version(packages=pkgs), "Uses Pandas", None)
    s2 = Store()
    s2.load_all()
    assert s2.autos[a["id"]]["versions"][1]["packages"] == pkgs


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
    d = home / "automations" / a["id"] / "memory-snapshots" / m["id"]
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


def test_snapshot_toggles_gate_automatic_reasons(store):
    from autodave.storage import Store

    a = store.create_automation(make_version(), "Toggler", None)
    # defaults: every automatic reason on
    assert a["memory_snapshots"] == {"pre_version": True, "pre_clear": True, "pre_restore": True}
    _write_memory(store, a)

    # off → the automatic reason skips silently; manual is never gated
    store.patch_automation(a, {"snapshotSettings": {"preClear": False}})
    assert store.snapshot_memory(a, "pre-clear") is None
    m = store.snapshot_memory(a, "manual")
    assert m is not None

    # pre-restore off → restore replaces memory without the undo copy
    store.patch_automation(a, {"snapshotSettings": {"preRestore": False}})
    _write_memory(store, a, text="v: new\n")
    assert store.restore_snapshot(a, m["id"]) is not None
    assert [s["reason"] for s in store.list_snapshots(a)] == ["manual"]

    # partial merge touched only the sent keys; persisted and reloaded as-is
    assert a["memory_snapshots"] == {"pre_version": True, "pre_clear": False, "pre_restore": False}
    s2 = Store()
    s2.load_all()
    b = s2.autos[a["id"]]
    assert b["memory_snapshots"] == {"pre_version": True, "pre_clear": False, "pre_restore": False}
    assert s2.auto_json(b)["snapshotSettings"] == {
        "preVersion": True, "preClear": False, "preRestore": False}


def test_snapshot_toggles_absent_keys_default_on(store):
    from autodave.storage import Store
    from autodave.yamlio import load_yaml, save_yaml

    a = store.create_automation(make_version(), "Legacyless", None)
    # hand-edited automation.yaml without the memory_snapshots key → all on
    top = store.auto_dir(a) / "automation.yaml"
    data = load_yaml(top)
    del data["memory_snapshots"]
    save_yaml(top, data)
    s2 = Store()
    s2.load_all()
    b = s2.autos[a["id"]]
    assert b["memory_snapshots"] == {"pre_version": True, "pre_clear": True, "pre_restore": True}


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


def test_pending_draft_slot_roundtrip(store):
    """§4.4 pending create-mode slot: save → load/json → delete."""
    from autodave import paths
    from conftest import make_version

    assert store.pending_draft_json() == {"draft": None, "agentId": None}
    ver = make_version()
    ver["step_agents"] = ["ag1"]
    ver["allowed_secrets"] = ["TOKEN"]
    store.save_pending_draft(ver, name="Pending One", agent_id="ag1",
                             triggers=[{"kind": "cron", "expr": "0 9 * * *"}])
    assert (paths.pending_draft_dir() / "automation" / "automation.yaml").exists()

    j = store.pending_draft_json()
    assert j["agentId"] == "ag1"
    d = j["draft"]
    assert d["name"] == "Pending One"
    assert d["stepAgents"] == ["ag1"] and d["allowedSecrets"] == ["TOKEN"]
    assert d["triggers"] == [{"kind": "cron", "expr": "0 9 * * *"}]
    assert [s["name"] for s in d["steps"]] == [s["name"] for s in ver["steps"]]
    assert d["steps"][0]["code"] == ver["steps"][0]["code"]

    # re-keep preserves created_at, bumps updated_at metadata on disk
    store.save_pending_draft(ver, name="Pending Two", agent_id=None, triggers=[])
    assert store.pending_draft_json()["draft"]["name"] == "Pending Two"

    store.delete_pending_draft()
    assert store.pending_draft_json() == {"draft": None, "agentId": None}
    assert not paths.pending_draft_dir().exists()


def test_open_pending_draft_makes_container(store):
    """§4.4: opening the create flow makes the slot's container dirs exist,
    without touching contents already there."""
    from autodave import paths
    from conftest import make_version

    store.open_pending_draft()
    for sub in ("memory", "workspace", "result"):
        assert (paths.pending_draft_dir() / sub).is_dir()
    assert store.pending_draft_json() == {"draft": None, "agentId": None}

    # re-open never clobbers a kept draft or scratch contents
    store.save_pending_draft(make_version(), name="Kept", agent_id=None, triggers=[])
    marker = paths.pending_draft_dir() / "workspace" / "notes.txt"
    marker.write_text("kept", encoding="utf-8")
    store.open_pending_draft()
    assert marker.read_text(encoding="utf-8") == "kept"
    assert store.pending_draft_json()["draft"]["name"] == "Kept"


def test_pending_draft_summary(store):
    """§19 /state pendingDraft: None while the slot holds no draft (even with
    the container dirs present), the identity summary once one is kept."""
    from conftest import make_version

    assert store.pending_draft_summary() is None
    store.open_pending_draft()
    assert store.pending_draft_summary() is None

    store.save_pending_draft(make_version(), name="Kept One", agent_id=None, triggers=[])
    s = store.pending_draft_summary()
    assert s["name"] == "Kept One" and s["updatedAt"]

    store.delete_pending_draft()
    assert store.pending_draft_summary() is None
