"""Scheduler (§6): fires due triggers, coalesces same-moment occurrences,
skips mid-execution firings, consumes one-shot `time` triggers, retries a
failed trigger-fired execution once after 5 minutes, applies the
missed-execution policy, and handles retention."""
from __future__ import annotations

import threading
from datetime import datetime, timedelta

from . import schedule
from .engine import Engine
from .events import hub
from .storage import Store

TICK_S = 15
RETRY_AFTER = timedelta(minutes=5)
TRIGGER_LABELS = ("Cron", "Once", "App start")  # §4.5 trigger-fired execution labels


def fire_trigger(store: Store, engine: Engine, a: dict, t: dict) -> bool:
    """Start a trigger-fired execution; mid-execution → a skipped record (§6).
    True when an execution actually started."""
    label = schedule.trigger_exec_label(t)
    if a.get("_live"):
        h = store.create_execution(a, f"v{a['current_version']}", label,
                                   steps=[], status="skipped",
                                   note="previous execution still in progress")
        h["dur_ms"] = 0
        h["finished_at"] = h["started_at"]
        store.update_execution(h)
        hub.publish("exec.finished", execId=h["id"], autoId=a["id"],
                    exec_json=store.exec_json(h), auto_json=None)
        return False
    try:
        engine.start(a, label)
        return True
    except RuntimeError:
        return False


class Scheduler:
    def __init__(self, store: Store, engine: Engine):
        self.store = store
        self.engine = engine
        # (automation id, trigger id) → last position; occurrences at or before
        # it never fire (startup baseline = now, §6 no catch-up queue).
        self._baseline: dict[tuple[str, str], datetime] = {}
        self._retry_at: dict[str, tuple[datetime, str]] = {}  # auto id → (when, label)
        # §6 "retried once after 5 minutes": automation ids already retried for
        # the current failure streak — cleared when a trigger-fired execution succeeds.
        self._retried: set[str] = set()
        self._stop = threading.Event()
        self._last_retention = datetime.now()
        engine_on_finished = getattr(engine, "on_finished", None)

        def on_finished(h: dict) -> None:
            if engine_on_finished:
                engine_on_finished(h)
            if h["trigger"] not in TRIGGER_LABELS:
                return
            if h["status"] == "failed":
                if h["auto_id"] not in self._retried:
                    self._retried.add(h["auto_id"])
                    self._retry_at[h["auto_id"]] = (datetime.now() + RETRY_AFTER, h["trigger"])
            elif h["status"] == "succeeded":
                self._retried.discard(h["auto_id"])
                self._retry_at.pop(h["auto_id"], None)

        engine.on_finished = on_finished  # type: ignore[attr-defined]

    def start(self) -> None:
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
        with self.store.lock:
            autos = list(self.store.autos.values())
        live_keys: set[tuple[str, str]] = set()
        for a in autos:
            due: list[tuple[datetime, dict]] = []
            for t in a["triggers"]:
                key = (a["id"], t["id"])
                live_keys.add(key)
                base = self._baseline.setdefault(key, now)
                if t["off"]:
                    # Occurrences passing while off never fire, even after a re-enable.
                    self._baseline[key] = now
                    continue
                occ = schedule.trigger_next(t, after=base)
                if occ and occ <= now:
                    # §6: at most one catch-up per wake — swallow every older occurrence.
                    self._baseline[key] = now
                    due.append((occ, t))
            if due:
                # §6: same-moment (and same-wake) occurrences coalesce into one execution.
                due.sort(key=lambda p: p[0])
                self._fire(a, due[0][1])
                consumed = False
                for _, t in due:
                    if t["kind"] == "time":
                        self.store.consume_trigger(a, t["id"])
                        consumed = True
                if consumed:
                    hub.publish("auto.changed", autoId=a["id"])
            retry = self._retry_at.get(a["id"])
            if retry and retry[0] <= now:
                del self._retry_at[a["id"]]
                if not a.get("_live"):
                    old = self.store._latest_exec(a["id"])
                    try:
                        if old and old["status"] == "failed":
                            # §6/§7: in-place retry — same record, new attempt.
                            self.engine.retry(a, old)
                        else:
                            self.engine.start(a, retry[1])
                    except RuntimeError:
                        pass
        # Forget baselines of deleted automations / removed triggers.
        self._baseline = {k: v for k, v in self._baseline.items() if k in live_keys}
        if (now - self._last_retention).total_seconds() > 3600:
            self._last_retention = now
            removed = self.store.retention_cleanup()
            if removed:
                hub.publish("auto.changed")

    def _fire(self, a: dict, t: dict) -> None:
        # §6: a trigger firing mid-execution is skipped, not queued
        # (a due one-shot is still consumed by the caller).
        fire_trigger(self.store, self.engine, a, t)
