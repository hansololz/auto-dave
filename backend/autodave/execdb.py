"""SQLite store for execution records (§5) — the one exception to file-first storage.

`<dataPath>/executions/executions.db` holds the metadata that was previously
`execution.yaml`; logs (NDJSON), results, and workspaces stay as files under
`executions/<uuid>/`. The connection is shared across threads and every call
happens under `Store.lock` (check_same_thread=False relies on that).
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

DDL = """
CREATE TABLE IF NOT EXISTS executions (
  id               TEXT PRIMARY KEY,
  automation_id    TEXT NOT NULL,
  automation_name  TEXT NOT NULL,
  version          TEXT NOT NULL,
  status           TEXT NOT NULL,
  "trigger"        TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  dur_ms           INTEGER,
  note             TEXT,
  chip             TEXT,
  chip_status      TEXT,
  redacted_secrets TEXT NOT NULL DEFAULT '[]',
  params           TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS execution_steps (
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL,
  dur_ms       INTEGER,
  PRIMARY KEY (execution_id, idx)
);
CREATE INDEX IF NOT EXISTS ix_exec_page   ON executions (started_at DESC, id);
CREATE INDEX IF NOT EXISTS ix_exec_auto   ON executions (automation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_exec_status ON executions (status, started_at DESC);
"""


def _ms(iso: str | None) -> int | None:
    return int(datetime.fromisoformat(iso).timestamp() * 1000) if iso else None


def _iso(ms: int | None) -> str | None:
    return datetime.fromtimestamp(ms / 1000).isoformat(timespec="seconds") if ms is not None else None


class ExecDB:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(DDL)

    def close(self) -> None:
        self.conn.close()

    def upsert(self, h: dict) -> None:
        """Write a full execution header (internal shape, ISO timestamps)."""
        with self.conn:
            self.conn.execute(
                'INSERT INTO executions (id, automation_id, automation_name, version, status,'
                ' "trigger", started_at, finished_at, dur_ms, note, chip, chip_status,'
                " redacted_secrets, params)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET"
                " automation_name=excluded.automation_name, status=excluded.status,"
                " finished_at=excluded.finished_at, dur_ms=excluded.dur_ms, note=excluded.note,"
                " chip=excluded.chip, chip_status=excluded.chip_status,"
                " redacted_secrets=excluded.redacted_secrets, params=excluded.params",
                (h["id"], h["auto_id"], h["auto_name"], h["ver"], h["status"], h["trigger"],
                 _ms(h["started_at"]), _ms(h.get("finished_at")), h["dur_ms"], h["note"],
                 h.get("chip"), h.get("chip_status"),
                 json.dumps(h["redacted"]), json.dumps(h.get("params", []))))
            self.conn.execute("DELETE FROM execution_steps WHERE execution_id=?", (h["id"],))
            self.conn.executemany(
                "INSERT INTO execution_steps (execution_id, idx, name, status, dur_ms) VALUES (?,?,?,?,?)",
                [(h["id"], i, s["name"], s["status"], s.get("dur_ms"))
                 for i, s in enumerate(h["steps"])])

    def load_all(self) -> dict[str, dict]:
        steps: dict[str, list[dict]] = {}
        for eid, name, status, dur_ms in self.conn.execute(
                "SELECT execution_id, name, status, dur_ms FROM execution_steps ORDER BY execution_id, idx"):
            steps.setdefault(eid, []).append({"name": name, "status": status, "dur_ms": dur_ms})
        out: dict[str, dict] = {}
        for row in self.conn.execute(
                'SELECT id, automation_id, automation_name, version, status, "trigger",'
                " started_at, finished_at, dur_ms, note, chip, chip_status,"
                " redacted_secrets, params FROM executions"):
            (eid, auto_id, auto_name, ver, status, trigger,
             started, finished, dur_ms, note, chip, chip_status, redacted, params) = row
            out[eid] = {
                "id": eid, "auto_id": auto_id, "auto_name": auto_name, "ver": ver,
                "status": status, "trigger": trigger,
                "started_at": _iso(started), "finished_at": _iso(finished),
                "dur_ms": dur_ms, "note": note,
                "chip": chip, "chip_status": chip_status,
                "redacted": json.loads(redacted), "params": json.loads(params),
                "steps": steps.get(eid, []),
            }
        return out

    def delete(self, exec_id: str) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM executions WHERE id=?", (exec_id,))
