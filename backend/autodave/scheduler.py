"""Scheduler (§6): fires due schedules, skips mid-run firings, retries a failed
scheduled run once after 5 minutes, applies the missed-run policy, runs retention."""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta

from .engine import Engine
from .events import hub
from .schedule import next_occurrence
from .storage import Store

TICK_S = 15
RETRY_AFTER = timedelta(minutes=5)


class Scheduler:
    def __init__(self, store: Store, engine: Engine):
        self.store = store
        self.engine = engine
        self._baseline: dict[str, datetime] = {}
        self._retry_at: dict[str, datetime] = {}
        # §6 "retried once after 5 minutes": automation ids already retried for
        # the current failure streak — cleared when a scheduled run succeeds.
        self._retried: set[str] = set()
        self._stop = threading.Event()
        self._last_tick = datetime.now()
        self._last_retention = datetime.now()
        engine_on_finished = getattr(engine, "on_finished", None)

        def on_finished(h: dict) -> None:
            if engine_on_finished:
                engine_on_finished(h)
            if h["trigger"] != "Schedule":
                return
            if h["status"] == "failed":
                if h["auto_id"] not in self._retried:
                    self._retried.add(h["auto_id"])
                    self._retry_at[h["auto_id"]] = datetime.now() + RETRY_AFTER
            elif h["status"] == "succeeded":
                self._retried.discard(h["auto_id"])
                self._retry_at.pop(h["auto_id"], None)

        engine.on_finished = on_finished  # type: ignore[attr-defined]

    def start(self) -> None:
        # Startup baseline = now: occurrences missed while the backend was down
        # are skipped entirely (§6 — no catch-up queue at startup).
        now = datetime.now()
        for a in self.store.autos.values():
            self._baseline[a["id"]] = now
        t = threading.Thread(target=self._loop, daemon=True, name="ad-scheduler")
        t.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.wait(TICK_S):
            try:
                self._tick()
            except Exception:  # noqa: BLE001
                pass

    def _tick(self) -> None:
        now = datetime.now()
        woke_from_sleep = (now - self._last_tick).total_seconds() > 120
        self._last_tick = now
        with self.store.lock:
            autos = list(self.store.autos.values())
        for a in autos:
            base = self._baseline.setdefault(a["id"], now)
            if a["sched_off"]:
                self._baseline[a["id"]] = now
                continue
            occ = next_occurrence(a["hour"], a["min"], a["dow"], after=base)
            if occ > now:
                pass
            else:
                # §6: at most one catch-up per wake — swallow every older occurrence.
                self._baseline[a["id"]] = now
                self._fire(a, woke_from_sleep)
            retry = self._retry_at.get(a["id"])
            if retry and retry <= now:
                del self._retry_at[a["id"]]
                if not a.get("_live"):
                    old = self.store._latest_exec(a["id"])
                    try:
                        if old and old["status"] == "failed":
                            self.engine.rerun_from_failed(a, old, trigger="Schedule")
                        else:
                            self.engine.start(a, "Schedule")
                    except RuntimeError:
                        pass
        if (now - self._last_retention).total_seconds() > 3600:
            self._last_retention = now
            removed = self.store.retention_cleanup()
            if removed:
                hub.publish("auto.changed")

    def _fire(self, a: dict, woke: bool) -> None:
        if a.get("_live"):
            # §6: a schedule firing mid-run is skipped, not queued.
            h = self.store.create_execution(a, f"v{a['current_version']}", "Schedule",
                                            steps=[], status="skipped",
                                            note="previous run still in progress")
            h["dur_ms"] = 0
            h["finished_at"] = h["started_at"]
            self.store.update_execution(h)
            hub.publish("exec.finished", execId=h["id"], autoId=a["id"],
                        exec_json=self.store.exec_json(h), auto_json=None)
            return
        try:
            self.engine.start(a, "Schedule")
        except RuntimeError:
            pass
