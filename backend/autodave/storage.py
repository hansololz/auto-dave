"""Storage (§5): YAML/markdown files everywhere; SQLite only as an index.

All derived state lives in memory (`Store`) and is rebuilt from disk at every
startup. Every write goes disk-first (atomic file / DB transaction), then
memory updates. Each execution's full record is `executions/<uuid>/executions.yaml`
(steps with attempts, params, error, notes); per-step-attempt logs live under
`executions/<uuid>/logs/`; `executions.db` (execdb.py) holds only the header
rows the list surfaces need.
"""
from __future__ import annotations

import logging
import re
import shutil
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from . import paths, schedule, timefmt
from .execdb import ExecDB
from .specmd import blocks_to_md, md_to_blocks
from .yamlio import atomic_write_text, load_yaml, save_yaml

SECRET_REF_RE = re.compile(r"\bsecrets\.([A-Z][A-Z0-9_]*)")

log = logging.getLogger("autodave.storage")

DEFAULT_SETTINGS: dict[str, Any] = {
    "login": True,
    "mbIcon": True,
    "notif": "attention",
    "days": 90,
    "keepForever": False,
    "dataPath": None,  # None → paths.default_data_path()
    "devMode": False,  # §4.9: request logging on/off, read live by the log filter
}


def new_id() -> str:
    return str(uuid.uuid4())


def size_label(n: int) -> str:
    """One humanized byte label for every surface (§4.1, §4.9)."""
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / 1024 / 1024:.1f} MB"
    return f"{n / 1024 / 1024 / 1024:.1f} GB"


def param_default(d: dict) -> Any:
    kind = d.get("kind")
    if "default" in d and d["default"] is not None:
        return d["default"]
    if kind == "toggle":
        return False
    if kind == "number":
        return d.get("min", 0)
    if kind == "list":
        return []
    if kind == "kv":
        return []
    return ""


def resolve_param_value(d: dict, values: dict, warn: list[str] | None = None) -> Any:
    """§5 matching rules: by name and kind; kind mismatch → default + warning."""
    name = d["name"]
    if name in values:
        v = values[name]
        kind = d.get("kind")
        ok = (
            (kind == "toggle" and isinstance(v, bool))
            or (kind == "number" and isinstance(v, (int, float)) and not isinstance(v, bool))
            or (kind == "list" and isinstance(v, list) and all(isinstance(x, str) for x in v))
            or (kind == "kv" and isinstance(v, list) and all(isinstance(x, dict) for x in v))
            or (kind == "text" and isinstance(v, str))
        )
        if ok:
            return v
        if warn is not None:
            warn.append(f'parameter "{name}": stored value doesn\'t match kind {kind} — using the default')
        return param_default(d)
    return param_default(d)


class Store:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.autos: dict[str, dict] = {}          # id → automation (internal shape)
        self.execs: dict[str, dict] = {}          # id → execution header
        self.execdb: ExecDB | None = None
        self.agents: list[dict] = []
        self.settings: dict = dict(DEFAULT_SETTINGS)
        self.secrets: list[dict] = []             # {name, desc} — values live in the Keychain

    # ---------- paths ----------
    def data_path(self) -> Path:
        p = self.settings.get("dataPath")
        return Path(p).expanduser() if p else paths.default_data_path()

    def executions_dir(self) -> Path:
        d = self.data_path()
        return d if d.name == "executions" else d / "executions"

    def auto_dir(self, a: dict) -> Path:
        return paths.automations_dir() / a["id"]

    def exec_dir(self, exec_id: str) -> Path:
        return self.executions_dir() / exec_id

    # ---------- startup walk (§5 load model) ----------
    def load_all(self) -> None:
        with self.lock:
            paths.ensure_dirs()
            self.settings = {**DEFAULT_SETTINGS, **(load_yaml(paths.settings_file(), {}) or {})}
            self.agents = (load_yaml(paths.agents_file(), {}) or {}).get("agents", [])
            self.secrets = [{"name": s["name"], "desc": s.get("desc") or ""}
                            for s in (load_yaml(paths.secrets_file(), {}) or {}).get("secrets", [])]
            self.autos = {}
            for d in sorted(paths.automations_dir().iterdir()) if paths.automations_dir().exists() else []:
                if not d.is_dir() or not (d / "automation.yaml").exists():
                    continue
                a = self._load_automation(d)
                if a:
                    self.autos[a["id"]] = a
            self.close_exec_db()
            self.execdb = ExecDB(self.executions_dir() / "executions.db")
            self.execs = self.execdb.load_all()
            self._reconcile_exec_index()
            self._refresh_exec_derived()

    def _reconcile_exec_index(self) -> None:
        """§5: `executions.yaml` is authoritative; the DB is only an index. An
        execution directory the index doesn't know (crash between the yaml write
        and the DB upsert, or a schema wipe) is restored from its yaml here, so
        startup truly rebuilds everything from disk."""
        d = self.executions_dir()
        if not d.exists():
            return
        for ed in d.iterdir():
            if not ed.is_dir() or ed.name in self.execs:
                continue
            y = self.read_exec_yaml(ed.name)
            if not y or y.get("id") != ed.name or not y.get("started_at"):
                continue
            h = {k: y[k] for k in ("id", "auto_id", "auto_name", "ver", "status", "trigger",
                                   "started_at", "finished_at", "dur_ms", "note",
                                   "chip", "chip_status", "error")}
            self.execdb.upsert(h)
            self.execs[h["id"]] = h
            log.warning("execution %s was missing from the index — restored from its executions.yaml", h["id"])

    def close_exec_db(self) -> None:
        with self.lock:
            if self.execdb:
                self.execdb.close()
                self.execdb = None

    def _load_automation(self, d: Path) -> dict | None:
        top = load_yaml(d / "automation.yaml")
        if not top or "id" not in top:
            return None
        if d.name != top["id"]:
            # §5: directory name IS the id — a mismatch means hand-edited disk.
            log.warning("automation dir %s doesn't match its id %r — skipping it at load", d, top["id"])
            return None
        a: dict = {
            "id": top["id"],
            "name": top.get("name", d.name),
            "current_version": int(top.get("current_version", 1)),
            "triggers": self._load_triggers(top.get("triggers", []) or []),
            "agent_id": top.get("agent_id"),
            "enabled_agents": top.get("enabled_agents", []) or [],
            "allowed_secrets": top.get("allowed_secrets", []) or [],
            "memory_snapshots": self._load_snapshot_settings(top.get("memory_snapshots")),
            "param_values": top.get("param_values", {}) or {},
            "created_at": top.get("created_at"),
            "updated_at": top.get("updated_at"),
            "versions": {},
            "draft": None,
        }
        vdir = d / "versions"
        if vdir.exists():
            for vd in vdir.iterdir():
                m = re.fullmatch(r"v(\d+)", vd.name)
                if m and (vd / "automation.yaml").exists():
                    a["versions"][int(m.group(1))] = self._load_version_folder(vd)
        if (d / "draft" / "automation" / "automation.yaml").exists():
            a["draft"] = self._load_version_folder(d / "draft" / "automation")
        if not a["versions"]:
            log.warning("automation %r at %s has no version folders — skipping it at load", a["name"], d)
            return None
        return a

    @staticmethod
    def _load_snapshot_settings(raw: dict | None) -> dict:
        """§6.3 automatic-snapshot toggles from automation.yaml — absent keys default on."""
        raw = raw or {}
        return {k: bool(raw.get(k, True)) for k in ("pre_version", "pre_clear", "pre_restore")}

    @staticmethod
    def _load_triggers(raw: list) -> list[dict]:
        """§4.3 stored shape from automation.yaml; malformed entries are dropped
        with a warning (disk is hand-editable)."""
        out = []
        for t in raw:
            if (isinstance(t, dict) and t.get("kind") == "app_start"
                    and any(x["kind"] == "app_start" for x in out)):
                log.warning("dropping duplicate app-start trigger %r", t)  # §4.3: at most one
            elif isinstance(t, dict) and schedule.validate_trigger(t) is None:
                out.append({"id": t.get("id") or new_id(), "kind": t["kind"],
                            "off": bool(t.get("off", False)),
                            **({"expr": t["expr"]} if t["kind"] == "cron" else
                               {"at": t["at"]} if t["kind"] == "time" else {}),
                            **({"tz": t["tz"]} if t.get("tz") and t["kind"] != "app_start" else {})})
            elif isinstance(t, dict) and t.get("kind") == "time":
                # A past one-shot found on disk was missed while the backend was
                # down — consumed (§4.3), never loaded.
                continue
            else:
                log.warning("dropping malformed trigger %r", t)
        return out

    def _load_version_folder(self, vd: Path) -> dict:
        meta = load_yaml(vd / "automation.yaml", {}) or {}
        steps = []
        for s in meta.get("steps", []) or []:
            code = ""
            f = vd / s.get("file", "")
            if f.exists():
                code = f.read_text(encoding="utf-8")
            steps.append({**s, "code": code})
        instr = None
        if (vd / "instructions.md").exists():
            instr = (vd / "instructions.md").read_text(encoding="utf-8").strip()
        spec_md = (vd / "spec.md").read_text(encoding="utf-8") if (vd / "spec.md").exists() else ""
        return {
            "when": meta.get("when"),
            "note": meta.get("note"),
            "desc": meta.get("desc", ""),
            "params": meta.get("params", []) or [],
            "packages": meta.get("packages", []) or [],
            "steps": steps,
            "spec": md_to_blocks(spec_md),
            "instr": instr,
            "step_agents": meta.get("step_agents"),
            "allowed_secrets": meta.get("allowed_secrets"),
            "triggers": meta.get("triggers"),
        }

    def _refresh_exec_derived(self) -> None:
        """Fill last_status / last_exec_at / live / latest-header per automation
        (§5 load model); the result chip rides on the execution header itself.
        `_latest` is kept current by create/update_execution so serialization
        never re-scans all executions per automation."""
        for a in self.autos.values():
            latest = self._latest_exec(a["id"])
            a["_latest"] = latest
            a["_last_status"] = latest["status"] if latest else "none"
            a["_last_exec_at"] = latest["started_at"] if latest else None
            a["_live"] = latest["id"] if latest and latest["status"] == "executing" else None

    def _latest_exec(self, auto_id: str) -> dict | None:
        # skipped records never executed — §4.1's lastStatus vocabulary excludes them,
        # so they must not shadow the real latest execution's status/chip.
        hs = [h for h in self.execs.values()
              if h["auto_id"] == auto_id and h["status"] != "skipped"]
        return max(hs, key=lambda h: h["started_at"] or "") if hs else None

    # ---------- automation writes ----------
    def _write_toplevel(self, a: dict) -> None:
        save_yaml(self.auto_dir(a) / "automation.yaml", {
            "id": a["id"],
            "name": a["name"],
            "current_version": a["current_version"],
            "triggers": a["triggers"],
            "agent_id": a["agent_id"],
            "enabled_agents": a["enabled_agents"],
            "allowed_secrets": a["allowed_secrets"],
            "memory_snapshots": a["memory_snapshots"],
            "param_values": a["param_values"],
            "created_at": a["created_at"],
            "updated_at": a["updated_at"],
        })

    def _write_version_folder(self, vd: Path, ver: dict, extra: dict | None = None) -> None:
        """`extra` merges additional keys into automation.yaml — used by the
        §4.4 pending create-mode slot for its identity fields.

        Crash-safe by write order (§5): step scripts and spec land first, the
        manifest (automation.yaml) last — it is the commit point (`_load_automation`
        ignores a folder without it), so a crash mid-write leaves either the old
        consistent folder or an ignorable partial, never a half-adopted version.
        Stale files from a previous draft save are pruned only after the new
        manifest is in place."""
        vd.mkdir(parents=True, exist_ok=True)
        keep = {"automation.yaml", "spec.md", "instructions.md"}
        manifest_steps = []
        for i, s in enumerate(ver["steps"], 1):
            fname = s.get("file") or f"{i:02d}-{re.sub(r'[^a-z0-9]+', '-', s['name'].lower()).strip('-')}.py"
            entry: dict[str, Any] = {"file": fname, "name": s["name"], "desc": s.get("desc", "")}
            if s.get("agent"):
                entry["agent"] = True
                entry["agent_id"] = s.get("agent_id")
                entry["why"] = s.get("why", "")
            manifest_steps.append(entry)
            keep.add(fname)
            atomic_write_text(vd / fname, s.get("code", ""))
        atomic_write_text(vd / "spec.md", blocks_to_md(ver.get("spec", [])))
        if ver.get("instr"):
            atomic_write_text(vd / "instructions.md", ver["instr"].strip() + "\n")
        elif (vd / "instructions.md").exists():
            (vd / "instructions.md").unlink()
        # §6.2: statuses are transient (draft payload / API only) — the stored
        # manifest keeps just the declaration; absent when none are declared.
        pkgs = [{"pip": p.get("pip"), "import": p.get("import")}
                for p in ver.get("packages", []) or []]
        save_yaml(vd / "automation.yaml", {
            "when": ver.get("when"),
            "note": ver.get("note"),
            "desc": ver.get("desc", ""),
            "params": ver.get("params", []),
            **({"packages": pkgs} if pkgs else {}),
            # §4.4 draft-only grant selections + trigger list — never present for real versions
            **({"step_agents": ver["step_agents"]} if ver.get("step_agents") is not None else {}),
            **({"allowed_secrets": ver["allowed_secrets"]} if ver.get("allowed_secrets") is not None else {}),
            **({"triggers": ver["triggers"]} if ver.get("triggers") is not None else {}),
            "steps": manifest_steps,
            **(extra or {}),
        })
        for f in vd.iterdir():
            if f.is_file() and f.name not in keep and not f.name.startswith(".ad-tmp-"):
                f.unlink()

    def create_automation(self, ver: dict, name: str, agent_id: str | None,
                          triggers: list[dict] | None = None,
                          enabled_agents: list[str] | None = None,
                          allowed_secrets: list[str] | None = None) -> dict:
        with self.lock:
            auto_id = new_id()
            now = datetime.now().isoformat(timespec="seconds")
            a = {
                "id": auto_id, "name": name, "current_version": 1,
                "triggers": triggers or [],
                "agent_id": agent_id,
                "enabled_agents": enabled_agents or ([agent_id] if agent_id else []),
                "allowed_secrets": allowed_secrets or [],
                "memory_snapshots": {"pre_version": True, "pre_clear": True, "pre_restore": True},
                "param_values": {}, "created_at": now, "updated_at": now,
                "versions": {}, "draft": None,
                "_last_status": "none", "_last_exec_at": None, "_live": None,
            }
            ver = {**ver, "when": now, "note": ver.get("note") or "Created"}
            self._write_version_folder(self.auto_dir(a) / "versions" / "v1", ver)
            (self.auto_dir(a) / "memory").mkdir(parents=True, exist_ok=True)
            a["versions"][1] = self._load_version_folder(self.auto_dir(a) / "versions" / "v1")
            self._write_toplevel(a)
            self.autos[auto_id] = a
            return a

    def save_new_version(self, a: dict, ver: dict) -> int:
        """§4.4/§5: write vN+1 folder, then flip the pointer atomically."""
        with self.lock:
            n = a["current_version"] + 1
            while n in a["versions"]:
                n += 1
            ver = {**ver, "when": datetime.now().isoformat(timespec="seconds")}
            vd = self.auto_dir(a) / "versions" / f"v{n}"
            self._write_version_folder(vd, ver)
            a["versions"][n] = self._load_version_folder(vd)
            a["current_version"] = n
            a["updated_at"] = datetime.now().isoformat(timespec="seconds")
            self._write_toplevel(a)
            return n

    def restore_version(self, a: dict, v: int) -> int:
        with self.lock:
            n = a["current_version"] + 1
            while n in a["versions"]:
                n += 1
            src = self.auto_dir(a) / "versions" / f"v{v}"
            dst = self.auto_dir(a) / "versions" / f"v{n}"
            shutil.copytree(src, dst)
            meta = load_yaml(dst / "automation.yaml", {}) or {}
            meta["when"] = datetime.now().isoformat(timespec="seconds")
            meta["note"] = f"Restored from v{v}"
            save_yaml(dst / "automation.yaml", meta)
            a["versions"][n] = self._load_version_folder(dst)
            a["current_version"] = n
            a["updated_at"] = datetime.now().isoformat(timespec="seconds")
            self._write_toplevel(a)
            return n

    def save_draft(self, a: dict, ver: dict) -> None:
        # §5: draft/ is a container — only the automation/ working copy is
        # rewritten; draft/memory/ (§4.4) survives re-saves from the editor.
        # No rmtree: _write_version_folder rewrites in place (manifest last,
        # stale files pruned after), so a crash never loses the previous draft.
        with self.lock:
            dd = self.auto_dir(a) / "draft" / "automation"
            self._write_version_folder(dd, ver)
            a["draft"] = self._load_version_folder(dd)

    # ---------- pending create-mode draft (§4.4: the <root>/draft/ slot) ----------
    def open_pending_draft(self) -> None:
        """§4.4: make the slot's container dirs exist — called when the create
        flow opens, before any drafting; never touches contents already there."""
        with self.lock:
            for sub in ("memory", "workspace", "result"):
                (paths.pending_draft_dir() / sub).mkdir(parents=True, exist_ok=True)

    def save_pending_draft(self, ver: dict, name: str | None, agent_id: str | None,
                           triggers: list | None) -> None:
        """Like save_draft, into the single `<root>/draft/` slot — only the
        automation/ working copy is rewritten; memory/workspace/result survive
        re-keeps. Identity fields ride automation.yaml (§5): no automation
        record exists yet to hold them."""
        with self.lock:
            dd = paths.pending_draft_dir() / "automation"
            prev = load_yaml(dd / "automation.yaml", {}) or {}
            now = datetime.now().isoformat(timespec="seconds")
            self._write_version_folder(dd, ver, extra={
                "name": name, "agent_id": agent_id, "triggers": triggers or [],
                "created_at": prev.get("created_at") or now, "updated_at": now,
            })

    def load_pending_draft(self) -> dict | None:
        """The slot's draft + identity keys; None when the slot is empty."""
        with self.lock:
            dd = paths.pending_draft_dir() / "automation"
            if not (dd / "automation.yaml").exists():
                return None
            meta = load_yaml(dd / "automation.yaml", {}) or {}
            return {**self._load_version_folder(dd),
                    "name": meta.get("name"), "agent_id": meta.get("agent_id"),
                    "triggers": meta.get("triggers", []) or []}

    def delete_pending_draft(self) -> None:
        """Settles the slot (Create consumed it, or Start over discarded it)."""
        with self.lock:
            shutil.rmtree(paths.pending_draft_dir(), ignore_errors=True)

    def pending_draft_summary(self) -> dict | None:
        """§19 GET /state `pendingDraft`: the slot's identity summary — backs
        the §9.1 Resume draft button; None when the slot holds no draft."""
        with self.lock:
            dd = paths.pending_draft_dir() / "automation"
            if not (dd / "automation.yaml").exists():
                return None
            meta = load_yaml(dd / "automation.yaml", {}) or {}
            return {"name": meta.get("name") or "New automation",
                    "updatedAt": meta.get("updated_at")}

    def pending_draft_json(self) -> dict:
        d = self.load_pending_draft()
        if d is None:
            return {"draft": None, "agentId": None}
        steps = [self.step_json(None, s) for s in d.get("steps", [])]
        return {"draft": {
            "name": d.get("name"), "desc": d.get("desc", ""), "note": d.get("note"),
            "params": d.get("params", []), "packages": d.get("packages", []),
            "steps": steps, "spec": d.get("spec", []), "instr": d.get("instr"),
            "triggers": d.get("triggers", []),
            **({"stepAgents": d["step_agents"]} if d.get("step_agents") is not None else {}),
            **({"allowedSecrets": d["allowed_secrets"]} if d.get("allowed_secrets") is not None else {}),
        }, "agentId": d.get("agent_id")}

    def delete_draft(self, a: dict) -> None:
        with self.lock:
            dd = self.auto_dir(a) / "draft"
            if dd.exists():
                shutil.rmtree(dd)
            a["draft"] = None

    def patch_automation(self, a: dict, patch: dict) -> None:
        """User-owned fields only (§19 PATCH)."""
        with self.lock:
            if "name" in patch and patch["name"] and patch["name"] != a["name"]:
                # §5: directories are named by id — a rename touches only the name field.
                a["name"] = patch["name"]
            for k_api, k_int in [("agentId", "agent_id"),
                                 ("stepAgents", "enabled_agents"), ("allowedSecrets", "allowed_secrets")]:
                if k_api in patch:
                    a[k_int] = patch[k_api]
            if "triggers" in patch:
                # Whole-list replace (§19) — the API validated + normalized it.
                a["triggers"] = patch["triggers"]
            if "paramValues" in patch:
                a["param_values"].update(patch["paramValues"])
            if "snapshotSettings" in patch:
                # §6.3 toggles — partial object, sent keys merged over the stored ones.
                sent = patch["snapshotSettings"] or {}
                for k_api, k_int in [("preVersion", "pre_version"), ("preClear", "pre_clear"),
                                     ("preRestore", "pre_restore")]:
                    if k_api in sent:
                        a["memory_snapshots"][k_int] = bool(sent[k_api])
            a["updated_at"] = datetime.now().isoformat(timespec="seconds")
            self._write_toplevel(a)

    def update_package_pin(self, new_spec: str) -> list[str]:
        """§6.2 pin update, manifest-first: rewrite the distribution's pip spec
        in the current version folder and draft of every automation declaring
        it — in place, no new version (a pin bump isn't a behavioral edit).
        Older versions keep their pins. Returns the affected automation names."""
        name = re.sub(r"[-_.]+", "-", new_spec.split("==", 1)[0]).lower()

        def rewrite(vd: Path, ver: dict) -> bool:
            hit = False
            for p in ver.get("packages", []) or []:
                spec = str(p.get("pip") or "")
                if re.sub(r"[-_.]+", "-", spec.split("==", 1)[0]).lower() == name and spec != new_spec:
                    p["pip"] = new_spec
                    hit = True
            if hit:
                meta = load_yaml(vd / "automation.yaml", {}) or {}
                meta["packages"] = [{"pip": p.get("pip"), "import": p.get("import")}
                                    for p in ver.get("packages", []) or []]
                save_yaml(vd / "automation.yaml", meta)
            return hit

        affected = []
        with self.lock:
            for a in self.autos.values():
                cur = a["versions"].get(a["current_version"], {})
                hit = rewrite(self.auto_dir(a) / "versions" / f"v{a['current_version']}", cur)
                if a["draft"]:
                    hit = rewrite(self.auto_dir(a) / "draft" / "automation", a["draft"]) or hit
                if hit:
                    a["updated_at"] = datetime.now().isoformat(timespec="seconds")
                    self._write_toplevel(a)
                    affected.append(a["name"])
        return affected

    def consume_trigger(self, a: dict, trigger_id: str) -> None:
        """§4.3 one-shot consumption: a fired or skipped `time` trigger leaves the list."""
        with self.lock:
            a["triggers"] = [t for t in a["triggers"] if t["id"] != trigger_id]
            self._write_toplevel(a)

    def trigger_json(self, t: dict) -> dict:
        label, short = schedule.trigger_display(t)
        return {**t, "label": label, "short": short}

    def delete_automation(self, a: dict) -> None:
        with self.lock:
            shutil.rmtree(self.auto_dir(a), ignore_errors=True)
            self.autos.pop(a["id"], None)

    # ---------- executions ----------
    def create_execution(self, auto: dict, ver_label: str, trigger: str,
                         steps: list[dict], note: str | None = None,
                         status: str = "executing", params: list[dict] | None = None) -> dict:
        with self.lock:
            h = {
                "id": new_id(), "auto_id": auto["id"], "auto_name": auto["name"],
                "ver": ver_label, "status": status, "trigger": trigger,
                "params": params or [],
                "started_at": datetime.now().isoformat(timespec="seconds"),
                "finished_at": None,
                "dur_ms": None, "note": note, "chip": None, "chip_status": None,
                "error": None, "redacted": [],
                "steps": [{"name": s["name"], "file": s.get("file"),
                           "agent": bool(s.get("agent")),
                           **({"sha": s["sha"]} if s.get("sha") else {}),
                           "status": s.get("status", "queued"),
                           "dur_ms": s.get("dur_ms"),
                           "attempts": s.get("attempts", [])} for s in steps],
            }
            d = self.exec_dir(h["id"])
            (d / "workspace").mkdir(parents=True, exist_ok=True)
            (d / "result").mkdir(parents=True, exist_ok=True)
            (d / "logs").mkdir(parents=True, exist_ok=True)
            self.write_exec_yaml(h)
            self.execdb.upsert(h)
            self.execs[h["id"]] = h
            if status == "executing":
                auto["_live"] = h["id"]
                auto["_latest"] = h
                auto["_last_status"] = "executing"
                auto["_last_exec_at"] = h["started_at"]
            return h

    def update_execution(self, h: dict) -> None:
        with self.lock:
            self.write_exec_yaml(h)
            self.execdb.upsert(h)
            a = self.autos.get(h["auto_id"])
            if h["status"] == "executing":
                # in-place retry flips a terminal record back to executing (§7)
                if a:
                    a["_live"] = h["id"]
                    a["_latest"] = h
                    a["_last_status"] = "executing"
                    a["_last_exec_at"] = h["started_at"]
            else:
                if a and a.get("_live") == h["id"]:
                    a["_live"] = None
                if a:
                    latest = self._latest_exec(a["id"])
                    a["_latest"] = latest
                    if latest:
                        a["_last_status"] = latest["status"]
                        a["_last_exec_at"] = latest["started_at"]

    # ---------- execution record yaml (§5 executions.yaml) ----------
    def exec_yaml_path(self, exec_id: str) -> Path:
        return self.exec_dir(exec_id) / "executions.yaml"

    def write_exec_yaml(self, h: dict) -> None:
        save_yaml(self.exec_yaml_path(h["id"]), {
            "id": h["id"],
            "automation_id": h["auto_id"],
            "automation_name": h["auto_name"],
            "version": h["ver"],
            "status": h["status"],
            "trigger": h["trigger"],
            "started_at": h["started_at"],
            "finished_at": h["finished_at"],
            "dur_ms": h["dur_ms"],
            "note": h["note"],
            "chip": h.get("chip"),
            "chip_status": h.get("chip_status"),
            "error": h.get("error"),
            "redacted_secrets": h["redacted"],
            "params": h.get("params", []),
            "steps": h["steps"],
        })

    def read_exec_yaml(self, exec_id: str) -> dict | None:
        y = load_yaml(self.exec_yaml_path(exec_id))
        if not y:
            return None
        return {
            "id": y.get("id", exec_id), "auto_id": y.get("automation_id"),
            "auto_name": y.get("automation_name"), "ver": y.get("version"),
            "status": y.get("status"), "trigger": y.get("trigger"),
            "started_at": y.get("started_at"), "finished_at": y.get("finished_at"),
            "dur_ms": y.get("dur_ms"), "note": y.get("note"),
            "chip": y.get("chip"), "chip_status": y.get("chip_status"),
            "error": y.get("error"), "redacted": y.get("redacted_secrets") or [],
            "params": y.get("params") or [], "steps": y.get("steps") or [],
        }

    def exec_full(self, exec_id: str) -> dict | None:
        """Full record: the live/in-memory record when it already has a body,
        else the header merged with `executions.yaml` (§5 bodies-lazily)."""
        with self.lock:
            h = self.execs.get(exec_id)
            if h is None:
                return None
            if "steps" in h:
                return h
            body = self.read_exec_yaml(exec_id)
            return {**h, **body} if body else {**h, "steps": [], "redacted": [], "params": []}

    # ---------- logs (§5 logs/, one file per step attempt) ----------
    EXEC_LOG = "execution.ndjson"

    @staticmethod
    def log_name(step_file: str | None, index: int, attempt: int) -> str:
        stem = Path(step_file).stem if step_file else f"{index + 1:02d}-step"
        return f"{stem}.a{attempt}.ndjson"

    def log_file(self, exec_id: str, name: str) -> Path:
        return self.exec_dir(exec_id) / "logs" / name

    def append_log_line(self, exec_id: str, name: str, line: dict) -> None:
        import json

        p = self.log_file(exec_id, name)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")

    def read_log(self, exec_id: str, step_idx: int | None = None,
                 attempt: int | None = None) -> list[dict]:
        import json

        if step_idx is None:
            name = self.EXEC_LOG
        else:
            full = self.exec_full(exec_id)
            steps = (full or {}).get("steps") or []
            if step_idx < 0 or step_idx >= len(steps):
                return []
            name = self.log_name(steps[step_idx].get("file"), step_idx, attempt or 1)
        p = self.log_file(exec_id, name)
        if not p.exists():
            return []
        out = []
        for ln in p.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(ln))
            except ValueError:
                pass
        return out

    def write_result(self, exec_id: str, result: dict) -> None:
        save_yaml(self.exec_dir(exec_id) / "result" / "result.yaml", result)

    def read_result(self, exec_id: str) -> dict | None:
        return load_yaml(self.exec_dir(exec_id) / "result" / "result.yaml")

    def result_files(self, exec_id: str) -> list[dict]:
        """§4.5: the file list IS the directory listing (result.yaml included)."""
        d = self.exec_dir(exec_id) / "result"
        if not d.exists():
            return []
        out = []
        for f in sorted(d.iterdir(), key=lambda p: p.name.lower()):
            if f.is_file():
                out.append({"name": f.name, "size": size_label(f.stat().st_size)})
        return out

    def result_json(self, h: dict) -> dict | None:
        """§4.5 result object: header chip + yaml fields + files listing + dir path.
        An execution with only output files (no builder calls) still has a result."""
        r = self.read_result(h["id"])
        files = self.result_files(h["id"])
        if not r and not files and not h.get("chip"):
            return None
        out = {**(r or {}), "files": files, "path": str(self.exec_dir(h["id"]) / "result")}
        if h.get("chip"):
            out["chip"] = h["chip"]
            out["chipStatus"] = h.get("chip_status") or "ok"
        return out

    def delete_execution(self, exec_id: str) -> None:
        with self.lock:
            h = self.execs.pop(exec_id, None)
            shutil.rmtree(self.exec_dir(exec_id), ignore_errors=True)
            self.execdb.delete(exec_id)
            # Keep `_latest` honest inside the mutator — no caller should have
            # to remember to recompute after deleting.
            if h:
                a = self.autos.get(h["auto_id"])
                if a and (a.get("_latest") or {}).get("id") == exec_id:
                    latest = self._latest_exec(a["id"])
                    a["_latest"] = latest
                    a["_last_status"] = latest["status"] if latest else "none"
                    a["_last_exec_at"] = latest["started_at"] if latest else None

    def retention_cleanup(self) -> int:
        with self.lock:
            if self.settings.get("keepForever"):
                return 0
            days = max(1, int(self.settings.get("days", 90)))
            cutoff = datetime.now().timestamp() - days * 86400
            doomed = []
            for h in self.execs.values():
                if h["status"] == "executing" or not h["started_at"]:
                    continue
                try:
                    if datetime.fromisoformat(h["started_at"]).timestamp() < cutoff:
                        doomed.append(h["id"])
                except ValueError:
                    # One unparsable row must never abort the whole sweep.
                    log.warning("retention: unparsable started_at on %s — skipping it", h["id"])
            for eid in doomed:
                self.delete_execution(eid)  # maintains each automation's `_latest`
            return len(doomed)

    # ---------- agents / secrets / settings ----------
    def save_agents(self) -> None:
        save_yaml(paths.agents_file(), {"agents": self.agents})

    def save_secrets(self) -> None:
        save_yaml(paths.secrets_file(), {"secrets": self.secrets})

    def save_settings(self) -> None:
        save_yaml(paths.settings_file(), self.settings)

    def secret_used_by(self, name: str) -> list[str]:
        used = []
        for a in self.autos.values():
            cur = a["versions"].get(a["current_version"], {})
            for s in cur.get("steps", []):
                if name in SECRET_REF_RE.findall(s.get("code", "")):
                    used.append(a["name"])
                    break
        return used

    # ---------- API serialization (§4 shapes) ----------
    def memory_stats(self, a: dict) -> dict:
        d = self.auto_dir(a) / "memory"
        size = 0
        newest: float | None = None
        if d.exists():
            for f in d.rglob("*"):
                if f.is_file():
                    st = f.stat()
                    size += st.st_size
                    newest = max(newest or 0, st.st_mtime)
        label = size_label(size) if size else "empty"
        updated = timefmt.date_label(datetime.fromtimestamp(newest)) if newest else "never written"
        return {"size": label, "updated": updated, "path": str(d)}

    def clear_memory(self, a: dict) -> None:
        d = self.auto_dir(a) / "memory"
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)

    # ---------- memory snapshots (§6.3) ----------
    def snapshots_dir(self, a: dict) -> Path:
        return self.auto_dir(a) / "memory-snapshots"

    def _snapshot_dir(self, a: dict, sid: str) -> Path | None:
        if not re.fullmatch(r"[0-9a-f-]{36}", sid):
            return None
        return self.snapshots_dir(a) / sid

    def _memory_file_stats(self, d: Path) -> tuple[int, int]:
        size = files = 0
        if d.exists():
            for f in d.rglob("*"):
                if f.is_file():
                    size += f.stat().st_size
                    files += 1
        return size, files

    def list_snapshots(self, a: dict) -> list[dict]:
        """§6.3: read from disk on demand, newest first; orphan dirs (no snapshot.yaml) skipped."""
        out = []
        root = self.snapshots_dir(a)
        if root.exists():
            for d in root.iterdir():
                if d.is_dir():
                    meta = load_yaml(d / "snapshot.yaml")
                    if meta:
                        out.append(meta)
        return sorted(out, key=lambda m: m.get("created_at") or "", reverse=True)

    def get_snapshot(self, a: dict, sid: str) -> dict | None:
        d = self._snapshot_dir(a, sid)
        return (load_yaml(d / "snapshot.yaml") or None) if d else None

    def snapshot_memory(self, a: dict, reason: str, name: str | None = None,
                        version: str | None = None) -> dict | None:
        """§6.3 create: memory copy first, snapshot.yaml last; empty memory → None.
        Automatic reasons toggled off (§6.3 memory_snapshots) → None, so no call
        site needs its own check. Sweeps crash orphans, then prunes unnamed
        snapshots beyond the newest 5."""
        with self.lock:
            if reason != "manual" and not a["memory_snapshots"][reason.replace("-", "_")]:
                return None
            mem = self.auto_dir(a) / "memory"
            size, files = self._memory_file_stats(mem)
            if files == 0:
                return None
            root = self.snapshots_dir(a)
            root.mkdir(parents=True, exist_ok=True)
            for d in root.iterdir():
                if d.is_dir() and not (d / "snapshot.yaml").exists():
                    shutil.rmtree(d, ignore_errors=True)
            sid = new_id()
            shutil.copytree(mem, root / sid / "memory")
            meta = {"id": sid, "name": name or None, "reason": reason,
                    "created_at": datetime.now().isoformat(timespec="seconds"),
                    "version": version or f"v{a['current_version']}",
                    "size": size, "files": files}
            save_yaml(root / sid / "snapshot.yaml", meta)
            unnamed = [m for m in self.list_snapshots(a) if not m.get("name")]
            for m in unnamed[5:]:
                shutil.rmtree(root / m["id"], ignore_errors=True)
            return meta

    def rename_snapshot(self, a: dict, sid: str, name: str | None) -> dict | None:
        with self.lock:
            meta = self.get_snapshot(a, sid)
            if not meta:
                return None
            meta["name"] = (name or "").strip() or None
            save_yaml(self.snapshots_dir(a) / sid / "snapshot.yaml", meta)
            return meta

    def delete_snapshot(self, a: dict, sid: str) -> bool:
        with self.lock:
            d = self._snapshot_dir(a, sid)
            if not d or not (d / "snapshot.yaml").exists():
                return False
            shutil.rmtree(d)
            return True

    def restore_snapshot(self, a: dict, sid: str) -> dict | None:
        """§6.3 restore: pre-restore snapshot of current memory, then replace it."""
        with self.lock:
            meta = self.get_snapshot(a, sid)
            src = self.snapshots_dir(a) / sid / "memory"
            if not meta or not src.exists():
                return None
            self.snapshot_memory(a, "pre-restore")
            mem = self.auto_dir(a) / "memory"
            if mem.exists():
                shutil.rmtree(mem)
            shutil.copytree(src, mem)
            return meta

    def snapshot_json(self, m: dict) -> dict:
        dt = datetime.fromisoformat(m["created_at"])
        return {"id": m["id"], "name": m.get("name"), "reason": m["reason"],
                "when": timefmt.date_label(dt), "version": m.get("version"),
                "size": size_label(int(m.get("size") or 0)), "files": int(m.get("files") or 0)}

    def merged_params(self, a: dict, ver: dict) -> list[dict]:
        out = []
        for d in ver.get("params", []):
            v = resolve_param_value(d, a["param_values"])
            p = {k: d[k] for k in d if k != "default"}
            kind = d.get("kind")
            if kind == "toggle":
                p["on"] = bool(v)
            elif kind == "list":
                p["lines"] = list(v)
            elif kind == "kv":
                p["rows"] = [{"k": r.get("k", ""), "v": r.get("v", "")} for r in v]
            else:
                p["value"] = v
            out.append(p)
        return out

    def version_json(self, a: dict, n: int, ver: dict) -> dict:
        when = ver.get("when")
        when_label = ""
        if when:
            dt = datetime.fromisoformat(when)
            when_label = ("created" if n == 1 else "updated") + f" {dt.strftime('%b')} {dt.day}"
        return {"v": n, "when": when_label, "note": ver.get("note"),
                "spec": ver.get("spec", []), "instr": ver.get("instr") or "",
                "steps": [self.step_json(a, s) for s in ver.get("steps", [])],
                "params": ver.get("params", []),
                "packages": ver.get("packages", []),
                **({"stepAgents": ver["step_agents"]} if ver.get("step_agents") is not None else {}),
                **({"allowedSecrets": ver["allowed_secrets"]} if ver.get("allowed_secrets") is not None else {}),
                **({"triggers": ver["triggers"]} if ver.get("triggers") is not None else {})}

    def step_json(self, a: dict | None, s: dict) -> dict:
        """One step-serialization for versions, drafts, and the pending slot —
        `a` (when given) supplies the enabled-agents fallback for agent steps."""
        out = {"name": s.get("name", ""), "desc": s.get("desc", ""), "code": s.get("code", ""), "file": s.get("file")}
        if s.get("agent"):
            enabled = a["enabled_agents"] if a else []
            out["agent"] = True
            out["agentId"] = s.get("agent_id") or (enabled[0] if enabled else None)
            out["why"] = s.get("why", "")
        return out

    def latest_result_json(self, a: dict) -> dict | None:
        hs = [h for h in self.execs.values() if h["auto_id"] == a["id"] and h["status"] != "executing"]
        for h in sorted(hs, key=lambda x: x["started_at"] or "", reverse=True):
            r = self.result_json(h)
            if r:
                dt = datetime.fromisoformat(h["started_at"])
                return {**r, "execId": h["id"], "when": f"from {timefmt.started_label(dt)}"}
        return None

    def auto_json(self, a: dict, full: bool = True) -> dict:
        cur = a["versions"].get(a["current_version"], {})
        last_at = a.get("_last_exec_at")
        last_dt = datetime.fromisoformat(last_at) if last_at else None
        live = a.get("_live")
        latest_h = a.get("_latest")  # kept current by create/update_execution — no per-call scan
        chip = None
        chip_status = None  # tints the chip everywhere (§7 colors), incl. the list row
        if latest_h and latest_h["status"] == "succeeded":
            chip = latest_h.get("chip")
            chip_status = latest_h.get("chip_status") if chip else None
        elif latest_h and latest_h["status"] == "failed":
            chip = "Needs attention"
            chip_status = "attention"
        nxt = schedule.next_at(a["triggers"])
        when = a["versions"].get(a["current_version"], {}).get("when")
        spec_meta = f"v{a['current_version']}"
        if when:
            dt = datetime.fromisoformat(when)
            spec_meta += f" · updated {timefmt.date_label(dt)}"
        out: dict[str, Any] = {
            "id": a["id"],
            "name": a["name"],
            "desc": cur.get("desc", ""),
            "version": a["current_version"],
            "triggers": [self.trigger_json(t) for t in a["triggers"]],
            "triggerChip": schedule.trigger_chip(a["triggers"]),
            "triggersOff": bool(a["triggers"]) and all(t["off"] for t in a["triggers"]),
            "nextAt": int(nxt.timestamp() * 1000) if nxt else None,
            "instr": cur.get("instr") or "",
            "lastStatus": a.get("_last_status", "none"),
            "live": live,
            "resultChip": chip,
            "resultStatus": chip_status,
            "lastExecLabel": "executing…" if live else (timefmt.date_label(last_dt) if last_dt else ""),
            "agentId": a["agent_id"],
            "stepAgents": a["enabled_agents"],
            "allowedSecrets": a["allowed_secrets"],
            "snapshotSettings": {"preVersion": a["memory_snapshots"]["pre_version"],
                                 "preClear": a["memory_snapshots"]["pre_clear"],
                                 "preRestore": a["memory_snapshots"]["pre_restore"]},
            "specMeta": spec_meta,
        }
        if full:
            out.update({
                "latest": self.latest_result_json(a),
                "params": self.merged_params(a, cur),
                "memory": self.memory_stats(a),
                "snapshots": [self.snapshot_json(m) for m in self.list_snapshots(a)],
                "steps": [self.step_json(a, s) for s in cur.get("steps", [])],
                "spec": cur.get("spec", []),
                "packages": cur.get("packages", []),
                "versions": [self.version_json(a, n, v)
                             for n, v in sorted(a["versions"].items(), reverse=True)
                             if n != a["current_version"]],
                "draft": self.version_json(a, a["current_version"], a["draft"]) if a["draft"] else None,
            })
        return out

    def step_attempts_json(self, s: dict) -> list[dict]:
        out = []
        for a in s.get("attempts", []):
            adt = datetime.fromisoformat(a["started_at"]) if a.get("started_at") else None
            out.append({"n": a["n"], "status": a["status"],
                        "dur": timefmt.dur_label(a["dur_ms"]) if a.get("dur_ms") else "",
                        "startedMs": int(adt.timestamp() * 1000) if adt else 0})
        return out

    def exec_json(self, h: dict, full: bool = False) -> dict:
        dt = datetime.fromisoformat(h["started_at"]) if h["started_at"] else None
        out: dict[str, Any] = {
            "id": h["id"], "autoId": h["auto_id"],
            "autoName": (self.autos.get(h["auto_id"], {}) or {}).get("name") or h["auto_name"],
            "autoDeleted": h["auto_id"] not in self.autos,
            "ver": h["ver"], "status": h["status"], "trigger": h["trigger"],
            "dur": timefmt.dur_label(h["dur_ms"]),
            "started": timefmt.started_label(dt) if dt else "",
            "startedMs": int(dt.timestamp() * 1000) if dt else 0,
            "note": h["note"],
            "error": h.get("error"),
        }
        if full:
            f = h if "steps" in h else (self.exec_full(h["id"]) or {**h, "steps": [], "redacted": [], "params": []})
            out["steps"] = [{"name": s["name"], "status": s["status"],
                             "dur": timefmt.dur_label(s["dur_ms"]) if s.get("dur_ms") else "",
                             "attempts": self.step_attempts_json(s)}
                            for s in f["steps"]]
            out["result"] = self.result_json(h)
            out["redact"] = ", ".join(f["redacted"]) if f.get("redacted") else None
            out["params"] = f.get("params", [])
        return out


store = Store()
