"""Transfer archives (§5.1): export/import round-trips, grant rules, rejection."""
import io
import zipfile

import pytest
import yaml

from autowright import transfer
from autowright.storage import Store, new_id


def _agent(name, harness="Claude Code", mode="default", model=None, default=False):
    return {"id": new_id(), "name": name, "desc": "", "harness": harness,
            "mode": mode, "model": model, "default": default}


def _build(store: Store):
    """An automation exercising every archive surface: params + values, cron +
    app_start + time triggers, an agent step, declared + code-referenced secrets."""
    store.agents = [_agent("Researcher", default=True),
                    _agent("Coder", harness="OpenCode", mode="custom", model="anthropic/x")]
    store.save_agents()
    store.secrets = [{"name": "API_KEY", "desc": "service key", "set": True},
                     {"name": "MAIL_PASS", "desc": "mail", "set": True}]
    store.save_secrets()
    ver = {
        "desc": "Watches things",
        "params": [{"name": "count", "kind": "number", "label": "Count", "help": "", "default": 3}],
        "packages": [{"pip": "pandas", "import": "pandas"}],
        "steps": [
            {"name": "Fetch", "desc": "", "code": "x = secrets.API_KEY\n",
             "secrets": ["MAIL_PASS"]},
            {"name": "Summarize", "desc": "", "code": "print('hi')\n",
             "agent": True, "why": "judgment", "agents": ["Coder"]},
        ],
        "spec": [{"k": "h1", "text": "Watch"}, {"k": "p", "text": "Body."}],
        "instr": "Keep it short.",
    }
    a = store.create_automation(
        ver, name="Watcher", agent_id=store.agents[0]["id"],
        triggers=[{"id": new_id(), "kind": "cron", "off": False, "expr": "0 8 * * *", "tz": "America/New_York"},
                  {"id": new_id(), "kind": "app_start", "off": False},
                  {"id": new_id(), "kind": "time", "off": False, "at": "2999-01-01T09:00"}],
        enabled_agents=[g["id"] for g in store.agents],
        allowed_secrets=["API_KEY", "MAIL_PASS"])
    store.patch_automation(a, {"paramValues": {"count": 7}})
    return a


def _fresh_home(monkeypatch, tmp_path_factory):
    home2 = tmp_path_factory.mktemp("home2")
    monkeypatch.setenv("AUTOWRIGHT_HOME", str(home2))
    from autowright import paths

    paths.ensure_dirs()
    s2 = Store()
    s2.load_all()
    return s2


def test_export_layout_and_sanitization(store):
    a = _build(store)
    data = transfer.export_automation(store, a)
    z = zipfile.ZipFile(io.BytesIO(data))
    names = set(z.namelist())
    assert {"manifest.yaml", "automation/automation.yaml", "automation/spec.md",
            "automation/instructions.md", "agents.yaml", "secrets.yaml"} <= names
    manifest = yaml.safe_load(z.read("manifest.yaml"))
    assert manifest["format_version"] == 1
    assert manifest["name"] == "Watcher"
    assert manifest["agent"] == "Researcher"
    # cron + app_start only, no ids/off; the one-shot time trigger never travels
    assert manifest["triggers"] == [{"kind": "cron", "expr": "0 8 * * *", "tz": "America/New_York"},
                                    {"kind": "app_start"}]
    assert manifest["param_values"] == {"count": 7}
    meta = yaml.safe_load(z.read("automation/automation.yaml"))
    assert "when" not in meta and "note" not in meta
    assert meta["packages"] == [{"pip": "pandas", "import": "pandas"}]
    # both referenced agents travel, without ids or credentials
    agents = yaml.safe_load(z.read("agents.yaml"))["agents"]
    assert {g["name"] for g in agents} == {"Researcher", "Coder"}
    assert all("id" not in g for g in agents)
    # declared + code-referenced secrets, names and descs only
    secrets = yaml.safe_load(z.read("secrets.yaml"))["secrets"]
    assert secrets == [{"name": "API_KEY", "desc": "service key"},
                       {"name": "MAIL_PASS", "desc": "mail"}]
    raw = data.decode("latin-1")
    assert "mail-app" not in raw  # no values anywhere


def test_export_without_values(store):
    a = _build(store)
    z = zipfile.ZipFile(io.BytesIO(transfer.export_automation(store, a, include_values=False)))
    assert "param_values" not in yaml.safe_load(z.read("manifest.yaml"))


def test_import_on_fresh_machine(store, monkeypatch, tmp_path_factory):
    a = _build(store)
    data = transfer.export_automation(store, a)
    s2 = _fresh_home(monkeypatch, tmp_path_factory)
    b, summary = transfer.import_automation(s2, data)
    assert b["id"] != a["id"]
    assert b["current_version"] == 1
    assert b["versions"][1]["note"] == "Imported"
    # everything the exporter wrote survives verbatim
    assert b["versions"][1]["spec"] == a["versions"][1]["spec"]
    assert [s["code"] for s in b["versions"][1]["steps"]] == \
        [s["code"] for s in a["versions"][1]["steps"]]
    assert b["versions"][1]["instr"] == "Keep it short."
    assert b["param_values"] == {"count": 7}
    # every trigger lands off, with fresh ids
    assert all(t["off"] for t in b["triggers"])
    assert {t["kind"] for t in b["triggers"]} == {"cron", "app_start"}
    # secrets became placeholders, agents were created — and only those granted
    assert summary["secretsCreated"] == ["API_KEY", "MAIL_PASS"]
    assert summary["secretsExisting"] == []
    assert sorted(summary["agentsCreated"]) == ["Coder", "Researcher"]
    assert all(not s["set"] for s in s2.secrets)
    assert sorted(b["allowed_secrets"]) == ["API_KEY", "MAIL_PASS"]
    assert set(b["enabled_agents"]) == {g["id"] for g in s2.agents}
    # drafting agent mapped by name
    drafting = next(g for g in s2.agents if g["name"] == "Researcher")
    assert b["agent_id"] == drafting["id"]
    # a fresh Store sees the same state after a reload (§5 disk-first)
    s3 = Store()
    s3.load_all()
    assert b["id"] in s3.autos


def test_import_on_same_machine_grants_nothing_preexisting(store):
    a = _build(store)
    data = transfer.export_automation(store, a)
    b, summary = transfer.import_automation(store, data)
    # same names exist → nothing created, nothing granted
    assert summary["secretsCreated"] == []
    assert summary["secretsExisting"] == ["API_KEY", "MAIL_PASS"]
    assert sorted(summary["agentsReused"]) == ["Coder", "Researcher"]
    assert summary["agentsCreated"] == []
    assert b["allowed_secrets"] == []
    assert b["enabled_agents"] == []
    # exact-config match reuses the record — the drafting agent maps to it
    assert b["agent_id"] == a["agent_id"]
    assert len(store.agents) == 2
    # existing secrets untouched
    assert all(s["set"] for s in store.secrets)


def test_import_agent_name_collision_creates_second_record(store):
    a = _build(store)
    data = transfer.export_automation(store, a)
    # same name, different config → a second record with the same name (§5.1)
    coder = next(g for g in store.agents if g["name"] == "Coder")
    coder["mode"], coder["model"] = "default", None
    store.save_agents()
    b, summary = transfer.import_automation(store, data)
    assert summary["agentsCreated"] == ["Coder"]
    assert summary["agentsReused"] == ["Researcher"]
    coders = [g for g in store.agents if g["name"] == "Coder"]
    assert len(coders) == 2
    created = next(g for g in coders if g["mode"] == "custom")
    assert b["enabled_agents"] == [created["id"]]


def test_import_rejects_and_writes_nothing(store):
    a = _build(store)
    data = transfer.export_automation(store, a)
    before = (len(store.autos), len(store.secrets), len(store.agents))

    with pytest.raises(transfer.TransferError, match="not a valid"):
        transfer.import_automation(store, b"garbage")

    def rezip(edit):
        src = zipfile.ZipFile(io.BytesIO(data))
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as out:
            for n in src.namelist():
                out.writestr(n, edit(n, src.read(n)) or src.read(n))
        return buf.getvalue()

    bad_version = rezip(lambda n, b: yaml.safe_dump(
        {**yaml.safe_load(b), "format_version": 99}).encode() if n == "manifest.yaml" else None)
    with pytest.raises(transfer.TransferError, match="unsupported archive format"):
        transfer.import_automation(store, bad_version)

    # a manifest step whose script file is missing from the zip
    src = zipfile.ZipFile(io.BytesIO(data))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        for n in src.namelist():
            if not n.endswith(".py"):
                out.writestr(n, src.read(n))
    with pytest.raises(transfer.TransferError, match="missing automation/"):
        transfer.import_automation(store, buf.getvalue())

    bad_agent = rezip(lambda n, b: yaml.safe_dump(
        {"agents": [{"name": "X", "harness": "Nope"}]}).encode() if n == "agents.yaml" else None)
    with pytest.raises(transfer.TransferError, match="invalid agent"):
        transfer.import_automation(store, bad_agent)

    assert (len(store.autos), len(store.secrets), len(store.agents)) == before


# ---------- appended coverage: caps, traversal, manifest rejects ----------

def _rezip(data, edit):
    """Rebuild the archive, letting `edit(name, bytes)` replace member content."""
    src = zipfile.ZipFile(io.BytesIO(data))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        for nm in src.namelist():
            out.writestr(nm, edit(nm, src.read(nm)) or src.read(nm))
    return buf.getvalue()


def test_total_decompressed_size_cap(store):
    """Members individually under _MAX_MEMBER_BYTES whose sum crosses
    _MAX_TOTAL_BYTES → rejected up front, nothing written."""
    before = (len(store.autos), len(store.secrets), len(store.agents))
    member = bytes(30 * 1024 * 1024)                 # zeros — deflates tiny
    assert len(member) < transfer._MAX_MEMBER_BYTES
    n = transfer._MAX_TOTAL_BYTES // len(member) + 1  # sum > total cap
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i in range(n):
            z.writestr(f"pad{i}.bin", member)
    data = buf.getvalue()
    assert len(data) < transfer.MAX_ARCHIVE_BYTES     # the archive itself stays small
    with pytest.raises(transfer.TransferError, match="decompresses far beyond"):
        transfer.import_automation(store, data)
    assert (len(store.autos), len(store.secrets), len(store.agents)) == before


def test_step_filename_traversal_rejected(store):
    a = _build(store)
    data = transfer.export_automation(store, a)
    before = len(store.autos)

    def evil(nm, b):
        if nm == "automation/automation.yaml":
            meta = yaml.safe_load(b)
            meta["steps"][0]["file"] = "../evil.py"
            return yaml.safe_dump(meta).encode()
        return None

    with pytest.raises(transfer.TransferError, match="invalid step filename"):
        transfer.import_automation(store, _rezip(data, evil))
    assert len(store.autos) == before


def test_format_version_and_duplicate_app_start_rejected(store):
    a = _build(store)
    data = transfer.export_automation(store, a)
    before = len(store.autos)

    def bump(nm, b):
        if nm == "manifest.yaml":
            return yaml.safe_dump({**yaml.safe_load(b), "format_version": 2}).encode()
        return None

    with pytest.raises(transfer.TransferError, match="unsupported archive format"):
        transfer.import_automation(store, _rezip(data, bump))

    def dupe(nm, b):
        if nm == "manifest.yaml":
            m = yaml.safe_load(b)
            m["triggers"] = [{"kind": "app_start"}, {"kind": "app_start"}]
            return yaml.safe_dump(m).encode()
        return None

    with pytest.raises(transfer.TransferError, match="more than one app_start"):
        transfer.import_automation(store, _rezip(data, dupe))
    assert len(store.autos) == before
