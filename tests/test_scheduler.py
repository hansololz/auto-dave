"""§6 scheduler retry policy: a failed trigger-fired execution is retried once
after 5 minutes — once per failure streak per automation, not once per execution id."""
from conftest import make_version


def _mk(store):
    from autowright.engine import Engine
    from autowright.scheduler import Scheduler

    engine = Engine(store)
    sched = Scheduler(store, engine)  # loop not started — we drive the hook
    return engine, sched


def _finished(auto_id, exec_id, status, trigger="Cron"):
    return {"id": exec_id, "auto_id": auto_id, "trigger": trigger, "status": status}


def test_failed_scheduled_run_retried_once_per_streak(store):
    engine, sched = _mk(store)
    # first trigger-fired failure → one retry scheduled
    engine.on_finished(_finished("a1", "e1", "failed"))
    assert "a1" in sched._retry_at and "a1" in sched._retried
    # the retry fires (tick pops the entry) and fails again — no second retry
    sched._retry_at.pop("a1")
    engine.on_finished(_finished("a1", "e2", "failed"))
    assert "a1" not in sched._retry_at
    # a later trigger-fired failure of the same streak still doesn't re-arm
    engine.on_finished(_finished("a1", "e3", "failed"))
    assert "a1" not in sched._retry_at


def test_retry_flag_clears_on_success(store):
    engine, sched = _mk(store)
    engine.on_finished(_finished("a1", "e1", "failed"))
    sched._retry_at.pop("a1")
    engine.on_finished(_finished("a1", "e2", "succeeded"))
    assert "a1" not in sched._retried
    # a fresh failure streak gets its one retry again
    engine.on_finished(_finished("a1", "e3", "failed"))
    assert "a1" in sched._retry_at


def test_manual_runs_never_arm_retry(store):
    engine, sched = _mk(store)
    engine.on_finished(_finished("a1", "e1", "failed", trigger="Manual"))
    assert not sched._retry_at and not sched._retried


def test_failed_scheduled_run_arms_retry_end_to_end(store):
    """Real engine execution with trigger Cron arms the retry via on_finished."""
    import time

    engine, sched = _mk(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'raise RuntimeError("boom")\n'
    a = store.create_automation(ver, "Sched Fail", None)
    h = engine.start(a, "Cron")
    t0 = time.time()
    while engine.is_live(h["id"]):
        assert time.time() - t0 < 30
        time.sleep(0.1)
    assert h["status"] == "failed"
    assert a["id"] in sched._retry_at and a["id"] in sched._retried


# ---------- §6 tick behavior, driven directly with an injected fake clock ----------

class _Clock:
    """Mutable fake clock for Scheduler(clock=...) — call returns .now."""

    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now


def _mk_clocked(store, clock):
    from autowright.engine import Engine
    from autowright.scheduler import Scheduler

    engine = Engine(store)
    sched = Scheduler(store, engine, clock=clock)  # loop never started
    return engine, sched


def _record_fires(monkeypatch):
    """Replace the module-level fire_trigger with a recorder."""
    from autowright import scheduler as sched_mod

    fires = []
    monkeypatch.setattr(sched_mod, "fire_trigger",
                        lambda store, engine, a, t: fires.append((a["id"], t["id"])) or True)
    return fires


def test_same_moment_triggers_coalesce_into_one_fire(store, monkeypatch):
    from datetime import datetime
    from conftest import make_version

    clock = _Clock(datetime(2026, 7, 10, 7, 59))
    engine, sched = _mk_clocked(store, clock)
    fires = _record_fires(monkeypatch)
    trigs = [{"id": "t1", "kind": "cron", "off": False, "expr": "0 8 * * *"},
             {"id": "t2", "kind": "cron", "off": False, "expr": "0 8 * * *"}]
    store.create_automation(make_version(), "Coalesce", None, triggers=trigs)
    sched._tick()  # establishes baselines at 7:59
    assert fires == []
    clock.now = datetime(2026, 7, 10, 8, 1)
    sched._tick()
    assert len(fires) == 1  # both due at 8:00 → one execution
    sched._tick()
    assert len(fires) == 1  # both baselines advanced — nothing re-fires


def test_at_most_one_catch_up_per_wake(store, monkeypatch):
    from datetime import datetime
    from conftest import make_version

    clock = _Clock(datetime(2026, 7, 10, 10, 30))
    engine, sched = _mk_clocked(store, clock)
    fires = _record_fires(monkeypatch)
    a = store.create_automation(make_version(), "Catchup", None, triggers=[
        {"id": "t1", "kind": "cron", "off": False, "expr": "0 * * * *"}])
    sched._tick()  # baseline 10:30
    clock.now = datetime(2026, 7, 10, 13, 31)  # slept through 11:00, 12:00, 13:00
    sched._tick()
    assert len(fires) == 1  # single catch-up, older occurrences swallowed
    assert sched._baseline[(a["id"], "t1")] == clock.now  # baseline advanced to now
    sched._tick()
    assert len(fires) == 1
    clock.now = datetime(2026, 7, 10, 14, 1)
    sched._tick()
    assert len(fires) == 2  # normal next occurrence still fires


def test_occurrence_missed_while_off_never_fires(store, monkeypatch):
    from datetime import datetime
    from conftest import make_version

    clock = _Clock(datetime(2026, 7, 10, 7, 59))
    engine, sched = _mk_clocked(store, clock)
    fires = _record_fires(monkeypatch)
    a = store.create_automation(make_version(), "OffMiss", None, triggers=[
        {"id": "t1", "kind": "cron", "off": True, "expr": "0 8 * * *"}])
    sched._tick()
    clock.now = datetime(2026, 7, 10, 8, 5)  # 8:00 passes while off
    sched._tick()
    assert fires == []
    a["triggers"][0]["off"] = False  # re-enable after the occurrence
    clock.now = datetime(2026, 7, 10, 8, 6)
    sched._tick()
    assert fires == []  # the missed 8:00 never fires
    clock.now = datetime(2026, 7, 11, 8, 1)  # NEXT occurrence
    sched._tick()
    assert len(fires) == 1


def test_one_shot_time_trigger_consumed_after_fire(store, monkeypatch):
    from datetime import datetime
    from conftest import make_version

    clock = _Clock(datetime(2026, 7, 10, 7, 59))
    engine, sched = _mk_clocked(store, clock)
    fires = _record_fires(monkeypatch)
    a = store.create_automation(make_version(), "OneShot", None, triggers=[
        {"id": "tt", "kind": "time", "off": False, "at": "2026-07-10T08:00"}])
    sched._tick()
    clock.now = datetime(2026, 7, 10, 8, 1)
    sched._tick()
    assert len(fires) == 1
    assert a["triggers"] == []  # consumed — removed from the automation
    clock.now = datetime(2026, 7, 10, 8, 2)
    sched._tick()
    assert len(fires) == 1


def test_auto_retry_lapses_when_latest_exec_is_no_longer_the_failure(store, monkeypatch):
    from datetime import datetime, timedelta
    from conftest import make_version

    clock = _Clock(datetime(2026, 7, 10, 9, 0))
    engine, sched = _mk_clocked(store, clock)
    a = store.create_automation(make_version(), "Lapse", None)
    engine.on_finished(_finished(a["id"], "e1", "failed"))
    assert a["id"] in sched._retry_at
    # the user executed again meanwhile — the latest record isn't the failed one
    monkeypatch.setattr(store, "_latest_exec",
                        lambda auto_id: {"id": "e2", "status": "succeeded"})
    retried = []
    monkeypatch.setattr(engine, "retry", lambda auto, h: retried.append(h))
    clock.now += timedelta(minutes=6)  # past the 5-minute retry point
    sched._tick()
    assert retried == []  # the retry lapsed
    assert a["id"] not in sched._retry_at  # and was consumed, not left armed


def test_fire_trigger_mid_execution_writes_skipped_record(store):
    from autowright.scheduler import fire_trigger
    from conftest import make_version

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Busy", None)
    a["_live"] = "some-live-exec"
    t = {"id": "t1", "kind": "cron", "off": False, "expr": "0 8 * * *"}
    assert fire_trigger(store, engine, a, t) is False
    recs = [h for h in store.execs.values() if h["auto_id"] == a["id"]]
    assert len(recs) == 1
    h = recs[0]
    assert h["status"] == "skipped"
    assert h["note"] == "previous execution still in progress"
    assert h["trigger"] == "Cron"
    assert h["dur_ms"] == 0 and h["finished_at"] == h["started_at"]
