"""SQLite index over execution headers (§5).

`<dataPath>/executions/executions.db` is a pure list/filter index: the
authoritative record is `executions/<uuid>/executions.yaml`, and the engine
writes both together (yaml first). The connection is shared across threads and
every call happens under `Store.lock` (check_same_thread=False relies on that).
"""
from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

SCHEMA_VERSION = 3

DDL = """
CREATE TABLE IF NOT EXISTS executions (
  id               TEXT PRIMARY KEY,
  automation_id    TEXT NOT NULL,
  automation_name  TEXT NOT NULL,
  version          TEXT NOT NULL,
  status           TEXT NOT NULL,
  "trigger"        TEXT NOT NULL,
  test             INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  dur_ms           INTEGER,
  note             TEXT,
  chip             TEXT,
  chip_status      TEXT,
  error_step       TEXT,
  error_message    TEXT,
  error_reason     TEXT
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
        if self.conn.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
            # The DB is only an index (§5): on any schema change, drop and let
            # startup's yaml reconcile rebuild the rows from disk.
            with self.conn:
                self.conn.execute("DROP TABLE IF EXISTS executions")
                self.conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        self.conn.executescript(DDL)

    def close(self) -> None:
        self.conn.close()

    def upsert(self, h: dict) -> None:
        """Write an execution header row (internal shape, ISO timestamps)."""
        err = h.get("error") or {}
        with self.conn:
            self.conn.execute(
                'INSERT INTO executions (id, automation_id, automation_name, version, status,'
                ' "trigger", test, started_at, finished_at, dur_ms, note, chip, chip_status,'
                " error_step, error_message, error_reason)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET"
                " automation_name=excluded.automation_name, status=excluded.status,"
                " finished_at=excluded.finished_at, dur_ms=excluded.dur_ms, note=excluded.note,"
                " chip=excluded.chip, chip_status=excluded.chip_status,"
                " error_step=excluded.error_step, error_message=excluded.error_message,"
                " error_reason=excluded.error_reason",
                (h["id"], h["auto_id"], h["auto_name"], h["ver"], h["status"], h["trigger"],
                 1 if h.get("test") else 0,
                 _ms(h["started_at"]), _ms(h.get("finished_at")), h["dur_ms"], h["note"],
                 h.get("chip"), h.get("chip_status"),
                 err.get("step"), err.get("message"), err.get("reason")))

    def load_all(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for row in self.conn.execute(
                'SELECT id, automation_id, automation_name, version, status, "trigger", test,'
                " started_at, finished_at, dur_ms, note, chip, chip_status,"
                " error_step, error_message, error_reason FROM executions"):
            (eid, auto_id, auto_name, ver, status, trigger, test,
             started, finished, dur_ms, note, chip, chip_status,
             err_step, err_message, err_reason) = row
            out[eid] = {
                "id": eid, "auto_id": auto_id, "auto_name": auto_name, "ver": ver,
                "status": status, "trigger": trigger, "test": bool(test),
                "started_at": _iso(started), "finished_at": _iso(finished),
                "dur_ms": dur_ms, "note": note,
                "chip": chip, "chip_status": chip_status,
                "error": {"step": err_step, "message": err_message, "reason": err_reason}
                         if err_message else None,
            }
        return out

    def delete(self, exec_id: str) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM executions WHERE id=?", (exec_id,))
