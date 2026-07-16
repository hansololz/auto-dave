"""Storage (§5): YAML/markdown files for automations, SQLite for execution records.

All derived state lives in memory (`Store`) and is rebuilt from disk at every
startup. Every write goes disk-first (atomic file / DB transaction), then
memory updates. Execution logs, results, and workspaces stay as files under
`executions/<uuid>/`; only the execution header lives in the DB (execdb.py).
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
from .slugs import slug_for
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


def _size_label(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


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
        self.secret_names: list[str] = []

    # ---------- paths ----------
    def data_path(self) -> Path:
        p = self.settings.get("dataPath")
        return Path(p).expanduser() if p else paths.default_data_path()

    def executions_dir(self) -> Path:
        d = self.data_path()
        return d if d.name == "executions" else d / "executions"

    def auto_dir(self, a: dict) -> Path:
        return paths.automations_dir() / a["slug"]

    def exec_dir(self, exec_id: str) -> Path:
        return self.executions_dir() / exec_id

    # ---------- startup walk (§5 load model) ----------
    def load_all(self) -> None:
        with self.lock:
            paths.ensure_dirs()
            self.settings = {**DEFAULT_SETTINGS, **(load_yaml(paths.settings_file(), {}) or {})}
            self.agents = (load_yaml(paths.agents_file(), {}) or {}).get("agents", [])
            self.secret_names = [s["name"] for s in (load_yaml(paths.secrets_file(), {}) or {}).get("secrets", [])]
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
            self._refresh_exec_derived()

    def close_exec_db(self) -> None:
        with self.lock:
            if self.execdb:
                self.execdb.close()
                self.execdb = None

    def _load_automation(self, d: Path) -> dict | None:
        top = load_yaml(d / "automation.yaml")
        if not top or "id" not in top:
            return None
        sched = top.get("schedule", {}) or {}
        a: dict = {
            "id": top["id"],
            "slug": d.name,
            "name": top.get("name", d.name),
            "current_version": int(top.get("current_version", 1)),
            "hour": sched.get("hour"),  # None -> no schedule (manual / menu bar only)
            "min": sched.get("min", 0),
            "dow": sched.get("dow"),
            "sched_off": bool(sched.get("off", False)),
            "agent_id": top.get("agent_id"),
            "enabled_agents": top.get("enabled_agents", []) or [],
            "allowed_secrets": top.get("allowed_secrets", []) or [],
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
        if (d / "draft" / "automation.yaml").exists():
            a["draft"] = self._load_version_folder(d / "draft")
        if not a["versions"]:
            log.warning("automation %r at %s has no version folders — skipping it at load", a["name"], d)
            return None
        return a

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
            "steps": steps,
            "spec": md_to_blocks(spec_md),
            "instr": instr,
        }

    def _refresh_exec_derived(self) -> None:
        """Fill last_status / last_exec_at / live per automation (§5 load model);
        the result chip rides on the execution header itself."""
        for a in self.autos.values():
            latest = self._latest_exec(a["id"])
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
        sched: dict[str, Any] = {}
        if a["hour"] is not None:
            sched["hour"] = a["hour"]
            sched["min"] = a["min"]
            if a["dow"] is not None:
                sched["dow"] = a["dow"]
        if a["sched_off"]:
            sched["off"] = True
        save_yaml(self.auto_dir(a) / "automation.yaml", {
            "id": a["id"],
            "name": a["name"],
            "current_version": a["current_version"],
            "schedule": sched,
            "agent_id": a["agent_id"],
            "enabled_agents": a["enabled_agents"],
            "allowed_secrets": a["allowed_secrets"],
            "param_values": a["param_values"],
            "created_at": a["created_at"],
            "updated_at": a["updated_at"],
        })

    def _write_version_folder(self, vd: Path, ver: dict) -> None:
        vd.mkdir(parents=True, exist_ok=True)
        manifest_steps = []
        for i, s in enumerate(ver["steps"], 1):
            fname = s.get("file") or f"{i:02d}-{re.sub(r'[^a-z0-9]+', '-', s['name'].lower()).strip('-')}.py"
            entry: dict[str, Any] = {"file": fname, "name": s["name"], "desc": s.get("desc", "")}
            if s.get("agent"):
                entry["agent"] = True
                entry["agent_id"] = s.get("agent_id")
                entry["why"] = s.get("why", "")
            manifest_steps.append(entry)
            atomic_write_text(vd / fname, s.get("code", ""))
        save_yaml(vd / "automation.yaml", {
            "when": ver.get("when"),
            "note": ver.get("note"),
            "desc": ver.get("desc", ""),
            "params": ver.get("params", []),
            "steps": manifest_steps,
        })
        atomic_write_text(vd / "spec.md", blocks_to_md(ver.get("spec", [])))
        if ver.get("instr"):
            atomic_write_text(vd / "instructions.md", ver["instr"].strip() + "\n")
        elif (vd / "instructions.md").exists():
            (vd / "instructions.md").unlink()

    def create_automation(self, ver: dict, name: str, agent_id: str | None,
                          hour: int | None = None, minute: int = 0, dow: int | None = None,
                          enabled_agents: list[str] | None = None,
                          allowed_secrets: list[str] | None = None) -> dict:
        with self.lock:
            auto_id = new_id()
            slug = slug_for(name, auto_id, {a["slug"] for a in self.autos.values()})
            now = datetime.now().isoformat(timespec="seconds")
            a = {
                "id": auto_id, "slug": slug, "name": name, "current_version": 1,
                "hour": hour, "min": minute, "dow": dow, "sched_off": False,
                "agent_id": agent_id,
                "enabled_agents": enabled_agents or ([agent_id] if agent_id else []),
                "allowed_secrets": allowed_secrets or [],
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
        with self.lock:
            dd = self.auto_dir(a) / "draft"
            if dd.exists():
                shutil.rmtree(dd)
            self._write_version_folder(dd, ver)
            a["draft"] = self._load_version_folder(dd)

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
                a["name"] = patch["name"]
                new_slug = slug_for(a["name"], a["id"],
                                    {x["slug"] for x in self.autos.values() if x["id"] != a["id"]})
                if new_slug != a["slug"]:
                    old = self.auto_dir(a)
                    a_new = paths.automations_dir() / new_slug
                    old.rename(a_new)
                    a["slug"] = new_slug
            for k_api, k_int in [("hour", "hour"), ("min", "min"), ("agentId", "agent_id"),
                                 ("stepAgents", "enabled_agents"), ("allowedSecrets", "allowed_secrets")]:
                if k_api in patch:
                    a[k_int] = patch[k_api]
            if "dow" in patch:
                a["dow"] = patch["dow"]
            if "schedOff" in patch:
                a["sched_off"] = bool(patch["schedOff"])
            if "paramValues" in patch:
                a["param_values"].update(patch["paramValues"])
            a["updated_at"] = datetime.now().isoformat(timespec="seconds")
            self._write_toplevel(a)

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
                "dur_ms": None, "note": note, "chip": None, "chip_status": None, "redacted": [],
                "steps": [{"name": s["name"], "status": s.get("status", "queued"), "dur_ms": s.get("dur_ms")} for s in steps],
            }
            d = self.exec_dir(h["id"])
            (d / "workspace").mkdir(parents=True, exist_ok=True)
            (d / "result").mkdir(parents=True, exist_ok=True)
            self.execdb.upsert(h)
            self.execs[h["id"]] = h
            if status == "executing":
                auto["_live"] = h["id"]
                auto["_last_status"] = "executing"
                auto["_last_exec_at"] = h["started_at"]
            return h

    def update_execution(self, h: dict) -> None:
        with self.lock:
            self.execdb.upsert(h)
            if h["status"] != "executing":
                a = self.autos.get(h["auto_id"])
                if a and a.get("_live") == h["id"]:
                    a["_live"] = None
                if a:
                    latest = self._latest_exec(a["id"])
                    if latest:
                        a["_last_status"] = latest["status"]
                        a["_last_exec_at"] = latest["started_at"]

    def append_log(self, exec_id: str, line: dict) -> None:
        import json

        p = self.exec_dir(exec_id) / "logs.ndjson"
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")

    def write_result(self, exec_id: str, result: dict) -> None:
        save_yaml(self.exec_dir(exec_id) / "result" / "result.yaml", result)

    def read_logs(self, exec_id: str) -> list[dict]:
        import json

        p = self.exec_dir(exec_id) / "logs.ndjson"
        if not p.exists():
            return []
        out = []
        for ln in p.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(ln))
            except ValueError:
                pass
        return out

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
                out.append({"name": f.name, "size": _size_label(f.stat().st_size)})
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
            shutil.rmtree(self.exec_dir(exec_id), ignore_errors=True)
            self.execdb.delete(exec_id)
            self.execs.pop(exec_id, None)

    def retention_cleanup(self) -> int:
        with self.lock:
            if self.settings.get("keepForever"):
                return 0
            days = max(1, int(self.settings.get("days", 90)))
            cutoff = datetime.now().timestamp() - days * 86400
            doomed = [h["id"] for h in self.execs.values()
                      if h["status"] != "executing" and h["started_at"]
                      and datetime.fromisoformat(h["started_at"]).timestamp() < cutoff]
            for eid in doomed:
                self.delete_execution(eid)
            return len(doomed)

    # ---------- agents / secrets / settings ----------
    def save_agents(self) -> None:
        save_yaml(paths.agents_file(), {"agents": self.agents})

    def save_secret_names(self) -> None:
        save_yaml(paths.secrets_file(), {"secrets": [{"name": n} for n in self.secret_names]})

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
        label = (f"{size / 1024:.0f} KB" if size < 1024 * 1024 else f"{size / 1024 / 1024:.1f} MB") if size else "empty"
        updated = timefmt.ago_label(datetime.fromtimestamp(newest)) if newest else "never written"
        return {"size": label, "updated": updated, "path": str(d)}

    def clear_memory(self, a: dict) -> None:
        d = self.auto_dir(a) / "memory"
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)

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
                "params": ver.get("params", [])}

    def step_json(self, a: dict, s: dict) -> dict:
        out = {"name": s.get("name", ""), "desc": s.get("desc", ""), "code": s.get("code", ""), "file": s.get("file")}
        if s.get("agent"):
            out["agent"] = True
            out["agentId"] = s.get("agent_id") or (a["enabled_agents"][0] if a["enabled_agents"] else None)
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
        latest_h = self._latest_exec(a["id"])
        chip = None
        chip_status = None  # tints the chip everywhere (§7 colors), incl. the list row
        if latest_h and latest_h["status"] == "succeeded":
            chip = latest_h.get("chip")
            chip_status = latest_h.get("chip_status") if chip else None
        elif latest_h and latest_h["status"] == "failed":
            chip = "Needs attention"
            chip_status = "attention"
        when = a["versions"].get(a["current_version"], {}).get("when")
        spec_meta = f"v{a['current_version']}"
        if when:
            dt = datetime.fromisoformat(when)
            days = (datetime.now().date() - dt.date()).days
            ago = "just now" if days == 0 else ("yesterday" if days == 1 else
                  (f"{days} days ago" if days < 30 else dt.strftime("%B %Y")))
            spec_meta += f" · updated {ago}"
        out: dict[str, Any] = {
            "id": a["id"],
            "name": a["name"],
            "desc": cur.get("desc", ""),
            "version": a["current_version"],
            "schedule": schedule.schedule_label(a["hour"], a["min"], a["dow"]),
            "scheduleShort": schedule.schedule_short(a["hour"], a["min"], a["dow"]),
            "hour": a["hour"], "min": a["min"], "dow": a["dow"],
            "schedOff": a["sched_off"],
            "instr": cur.get("instr") or "",
            "lastStatus": a.get("_last_status", "none"),
            "live": live,
            "resultChip": chip,
            "resultStatus": chip_status,
            "lastExecLabel": "executing…" if live else timefmt.last_exec_label(last_dt),
            "agentId": a["agent_id"],
            "stepAgents": a["enabled_agents"],
            "allowedSecrets": a["allowed_secrets"],
            "specMeta": spec_meta,
        }
        if full:
            out.update({
                "latest": self.latest_result_json(a),
                "params": self.merged_params(a, cur),
                "memory": self.memory_stats(a),
                "steps": [self.step_json(a, s) for s in cur.get("steps", [])],
                "spec": cur.get("spec", []),
                "versions": [self.version_json(a, n, v)
                             for n, v in sorted(a["versions"].items(), reverse=True)
                             if n != a["current_version"]],
                "draft": self.version_json(a, a["current_version"], a["draft"]) if a["draft"] else None,
            })
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
            "steps": [{"name": s["name"], "status": s["status"], "dur": timefmt.dur_label(s["dur_ms"]) if s.get("dur_ms") else ""}
                      for s in h["steps"]],
        }
        if full:
            logs = self.read_logs(h["id"])
            out["logs"] = [{"t": l.get("t", ""), "k": l.get("k", "out"), "text": l.get("text", "")} for l in logs]
            out["result"] = self.result_json(h)
            out["redact"] = ", ".join(h["redacted"]) if h["redacted"] else None
            out["params"] = h.get("params", [])
        return out


store = Store()
