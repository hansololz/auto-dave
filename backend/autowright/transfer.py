"""Transfer archives (§5.1): export an automation to a `.autowright` zip and
import one on any machine.

References plus safe metadata travel; credentials, grants, uuids, and local
state never do. Import validates the whole archive first (`TransferError` →
§19 422) and writes nothing on failure.
"""
from __future__ import annotations

import io
import re
import zipfile
from datetime import datetime

import yaml

from . import __version__, harness, schedule
from .specmd import blocks_to_md, md_to_blocks
from .storage import SECRET_REF_RE, Store, new_id

FORMAT_VERSION = 1
SECRET_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
PARAM_KINDS = ("text", "number", "toggle", "list", "kv")
MODES = ("default", "ollama", "custom")


class TransferError(Exception):
    """Archive rejected — the message is the §19 422 detail."""


def safe_filename(name: str) -> str:
    """§19: the automation name sanitized for a filesystem filename."""
    cleaned = re.sub(r'[/\\:*?"<>|\x00-\x1f]+', " ", name).strip().strip(".")
    return cleaned or "automation"


# ---------- export ----------
def _referenced_secrets(ver: dict) -> list[str]:
    names: set[str] = set()
    for s in ver.get("steps", []):
        names |= set(s.get("secrets") or [])
        names |= set(SECRET_REF_RE.findall(s.get("code", "")))
    return sorted(names)


def _referenced_agents(store: Store, a: dict, ver: dict) -> list[dict]:
    """The drafting agent + every step-grant name, resolved like the engine
    (§6 grant names) — deduped by record id, archive order stable."""
    by_id: dict[str, dict] = {}
    drafting = next((g for g in store.agents if g["id"] == a["agent_id"]), None)
    if drafting:
        by_id[drafting["id"]] = drafting
    by_grant = {harness.grant_name(g): g for g in reversed(store.agents)}
    for s in ver.get("steps", []):
        for n in s.get("agents") or []:
            g = by_grant.get(n)
            if g:
                by_id.setdefault(g["id"], g)
    return [{"name": harness.grant_name(g), "desc": g.get("desc") or "",
             "harness": g.get("harness"), "mode": g.get("mode", "default"),
             "model": g.get("model")} for g in by_id.values()]


def export_automation(store: Store, a: dict, include_values: bool = True) -> bytes:
    """The §5.1 archive for an automation's current version, as zip bytes."""
    with store.lock:
        ver = a["versions"][a["current_version"]]
        manifest: dict = {
            "format_version": FORMAT_VERSION,
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            "app_version": __version__,
            "name": a["name"],
        }
        drafting = next((g for g in store.agents if g["id"] == a["agent_id"]), None)
        if drafting:
            manifest["agent"] = harness.grant_name(drafting)
        # §5.1: cron and app_start only — one-shot `time` triggers are moments
        # in time; no ids, no off state.
        triggers = []
        for t in a["triggers"]:
            if t["kind"] == "cron":
                triggers.append({"kind": "cron", "expr": t["expr"],
                                 **({"tz": t["tz"]} if t.get("tz") else {})})
            elif t["kind"] == "app_start":
                triggers.append({"kind": "app_start"})
        manifest["triggers"] = triggers
        if include_values:
            manifest["param_values"] = {
                k: v for k, v in a["param_values"].items()
                if any(p.get("name") == k for p in ver.get("params", []))}
        meta: dict = {"desc": ver.get("desc", ""), "params": ver.get("params", [])}
        pkgs = [{"pip": p.get("pip"), "import": p.get("import")}
                for p in ver.get("packages", []) or []]
        if pkgs:
            meta["packages"] = pkgs
        steps = []
        for s in ver["steps"]:
            entry = {"file": s["file"], "name": s.get("name", ""), "desc": s.get("desc", "")}
            if s.get("agent"):
                entry["agent"] = True
                entry["why"] = s.get("why", "")
                if s.get("agents"):
                    entry["agents"] = list(s["agents"])
            if s.get("secrets"):
                entry["secrets"] = list(s["secrets"])
            steps.append(entry)
        meta["steps"] = steps
        agents = _referenced_agents(store, a, ver)
        secret_desc = {s["name"]: s.get("desc") or "" for s in store.secrets}
        secrets = [{"name": n, "desc": secret_desc.get(n, "")}
                   for n in _referenced_secrets(ver)]
        files: list[tuple[str, str]] = [
            ("manifest.yaml", yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True)),
            ("automation/automation.yaml", yaml.safe_dump(meta, sort_keys=False, allow_unicode=True)),
            ("automation/spec.md", blocks_to_md(ver.get("spec", []))),
        ]
        if ver.get("instr"):
            files.append(("automation/instructions.md", ver["instr"].strip() + "\n"))
        for s in ver["steps"]:
            files.append((f"automation/{s['file']}", s.get("code", "")))
        files.append(("agents.yaml", yaml.safe_dump({"agents": agents}, sort_keys=False, allow_unicode=True)))
        files.append(("secrets.yaml", yaml.safe_dump({"secrets": secrets}, sort_keys=False, allow_unicode=True)))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path, text in files:
            z.writestr(path, text)
    return buf.getvalue()


# ---------- import ----------
# Imported archives are untrusted input (§5.1) — cap the decompressed sizes so
# a crafted member can't balloon into memory. zipfile bounds each read by the
# declared file_size, so checking the directory up front is sufficient.
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024        # the upload itself
_MAX_MEMBER_BYTES = 32 * 1024 * 1024        # one member, decompressed
_MAX_TOTAL_BYTES = 256 * 1024 * 1024        # whole archive, decompressed


def _check_sizes(z: zipfile.ZipFile) -> None:
    total = 0
    for info in z.infolist():
        if info.file_size > _MAX_MEMBER_BYTES:
            raise TransferError(f"{info.filename} in the archive is unreasonably large")
        total += info.file_size
    if total > _MAX_TOTAL_BYTES:
        raise TransferError("the archive decompresses far beyond any real automation")


def _yaml_or_reject(z: zipfile.ZipFile, path: str, required: bool = True) -> dict:
    try:
        raw = z.read(path)
    except KeyError:
        if required:
            raise TransferError(f"the archive is missing {path}") from None
        return {}
    try:
        data = yaml.safe_load(raw.decode("utf-8"))
    except (yaml.YAMLError, UnicodeDecodeError) as e:
        raise TransferError(f"{path} isn't valid YAML: {e}") from None
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise TransferError(f"{path} must hold a YAML mapping")
    return data


def _text(z: zipfile.ZipFile, path: str, required: bool = True) -> str | None:
    try:
        return z.read(path).decode("utf-8")
    except KeyError:
        if required:
            raise TransferError(f"the archive is missing {path}") from None
        return None
    except UnicodeDecodeError:
        raise TransferError(f"{path} isn't valid UTF-8") from None


def _validate(z: zipfile.ZipFile) -> dict:
    """Parse + validate everything up front; returns the parsed archive."""
    _check_sizes(z)
    manifest = _yaml_or_reject(z, "manifest.yaml")
    if manifest.get("format_version") != FORMAT_VERSION:
        raise TransferError(f"unsupported archive format {manifest.get('format_version')!r} — "
                            f"this app reads format {FORMAT_VERSION}")
    name = manifest.get("name")
    if not isinstance(name, str) or not name.strip():
        raise TransferError("the manifest has no automation name")
    triggers_in = manifest.get("triggers") or []
    if not isinstance(triggers_in, list):
        raise TransferError("manifest triggers must be a list")
    triggers = []
    for t in triggers_in:
        if not isinstance(t, dict) or t.get("kind") not in ("cron", "app_start"):
            raise TransferError(f"unsupported trigger in the archive: {t!r} — "
                                "only cron and app_start travel")
        if t["kind"] == "app_start" and any(x["kind"] == "app_start" for x in triggers):
            raise TransferError("the archive holds more than one app_start trigger")
        probe = {"kind": t["kind"], "expr": t.get("expr"), "tz": t.get("tz")}
        if err := schedule.validate_trigger(probe):
            raise TransferError(f"invalid trigger in the archive: {err}")
        triggers.append({"kind": t["kind"],
                         **({"expr": t["expr"]} if t["kind"] == "cron" else {}),
                         **({"tz": t["tz"]} if t.get("tz") and t["kind"] == "cron" else {})})
    values = manifest.get("param_values") or {}
    if not isinstance(values, dict):
        raise TransferError("manifest param_values must be a mapping")

    meta = _yaml_or_reject(z, "automation/automation.yaml")
    params = meta.get("params") or []
    if not isinstance(params, list):
        raise TransferError("param definitions must be a list")
    for p in params:
        if not isinstance(p, dict) or not p.get("name") or p.get("kind") not in PARAM_KINDS:
            raise TransferError(f"invalid parameter definition: {p!r}")
    packages = meta.get("packages") or []
    if not isinstance(packages, list) or any(
            not isinstance(p, dict) or not p.get("pip") or not p.get("import")
            for p in packages):
        raise TransferError("invalid packages declaration")
    steps_meta = meta.get("steps") or []
    if not isinstance(steps_meta, list) or not steps_meta:
        raise TransferError("the archive holds no steps")
    steps = []
    for s in steps_meta:
        if not isinstance(s, dict) or not s.get("file") or not s.get("name"):
            raise TransferError(f"invalid step manifest entry: {s!r}")
        if "/" in s["file"] or "\\" in s["file"] or s["file"].startswith("."):
            raise TransferError(f"invalid step filename: {s['file']!r}")
        code = _text(z, f"automation/{s['file']}")
        entry = {"file": s["file"], "name": s["name"], "desc": s.get("desc", ""),
                 "code": code}
        if s.get("agent"):
            entry["agent"] = True
            entry["why"] = s.get("why", "")
            entry["agents"] = list(s.get("agents") or [])
        if s.get("secrets"):
            entry["secrets"] = list(s["secrets"])
        steps.append(entry)

    agents = _yaml_or_reject(z, "agents.yaml", required=False).get("agents") or []
    for g in agents:
        if not isinstance(g, dict) or not g.get("name") or g.get("harness") not in harness.HARNESS_ID:
            raise TransferError(f"invalid agent in the archive: {g!r}")
        mode = g.get("mode", "default")
        if mode not in MODES:
            raise TransferError(f"invalid agent mode {mode!r}")
        if mode == "ollama" and g["harness"] != "OpenCode":
            raise TransferError("a local-model agent needs the OpenCode harness")
        if mode != "default" and not g.get("model"):
            raise TransferError(f"agent {g['name']!r} needs a model for mode {mode!r}")
    secrets = _yaml_or_reject(z, "secrets.yaml", required=False).get("secrets") or []
    for s in secrets:
        if not isinstance(s, dict) or not SECRET_NAME_RE.match(s.get("name") or ""):
            raise TransferError(f"invalid secret in the archive: {s!r}")

    spec_md = _text(z, "automation/spec.md")
    instr = _text(z, "automation/instructions.md", required=False)
    return {"name": name.strip(), "agent": manifest.get("agent"),
            "triggers": triggers, "param_values": values,
            "desc": meta.get("desc", ""), "params": params, "packages": packages,
            "steps": steps, "spec": md_to_blocks(spec_md), "instr": (instr or "").strip() or None,
            "agents": agents, "secrets": secrets}


def import_automation(store: Store, data: bytes) -> tuple[dict, dict]:
    """Validate and land a §5.1 archive; returns (automation, summary)."""
    if len(data) > MAX_ARCHIVE_BYTES:
        raise TransferError("the archive is larger than the 64 MB import limit")
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise TransferError("not a valid .autowright archive") from None
    with z:
        arch = _validate(z)
    with store.lock:
        # Secrets: a missing referenced name becomes a §4.8 placeholder;
        # an existing name is the same secret by definition — untouched.
        created_secrets, existing_secrets = [], []
        for s in arch["secrets"]:
            if any(x["name"] == s["name"] for x in store.secrets):
                existing_secrets.append(s["name"])
            else:
                store.secrets.append({"name": s["name"], "desc": s.get("desc") or "",
                                      "set": False})
                created_secrets.append(s["name"])
        if created_secrets:
            store.save_secrets()
        # Agents: exact config match (name + harness + mode + model) reuses the
        # local record; anything else is created — same name allowed (§5.1).
        created_agents, reused_agents = [], []
        created_ids: list[str] = []
        matched: dict[str, dict] = {}   # archive name → local record
        for g in arch["agents"]:
            model = g.get("model") if g.get("mode", "default") != "default" else None
            local = next((x for x in store.agents
                          if harness.grant_name(x) == g["name"]
                          and x.get("harness") == g["harness"]
                          and x.get("mode", "default") == g.get("mode", "default")
                          and x.get("model") == model), None)
            if local:
                matched[g["name"]] = local
                reused_agents.append(g["name"])
            else:
                rec = {"id": new_id(), "name": g["name"], "desc": g.get("desc") or "",
                       "harness": g["harness"], "mode": g.get("mode", "default"),
                       "model": model, "default": not store.agents}
                store.agents.append(rec)
                matched[g["name"]] = rec
                created_agents.append(g["name"])
                created_ids.append(rec["id"])
        if created_agents:
            store.save_agents()
        # The drafting agent_id maps by name; no archive agents → local default.
        drafting = matched.get(arch["agent"]) if arch.get("agent") else None
        if drafting is None:
            drafting = next((x for x in store.agents if x.get("default")), None)
        ver = {"desc": arch["desc"], "note": "Imported", "params": arch["params"],
               "packages": arch["packages"], "steps": arch["steps"],
               "spec": arch["spec"], "instr": arch["instr"]}
        triggers = [{"id": new_id(), "off": True, **t} for t in arch["triggers"]]
        a = store.create_automation(ver, name=arch["name"],
                                    agent_id=drafting["id"] if drafting else None,
                                    triggers=triggers)
        # §5.1 grants: only what this import created — create_automation's
        # drafting-agent fallback must not survive for pre-existing records.
        store.patch_automation(a, {"stepAgents": created_ids,
                                   "allowedSecrets": list(created_secrets),
                                   "paramValues": arch["param_values"]})
    summary = {"secretsCreated": created_secrets, "secretsExisting": existing_secrets,
               "agentsCreated": created_agents, "agentsReused": reused_agents,
               "packages": arch["packages"]}
    return a, summary
