"""§6 scheduler retry policy: a failed scheduled run is retried once after
5 minutes — once per failure streak per automation, not once per execution id."""
from conftest import make_version


def _mk(store):
    from autodave.engine import Engine
    from autodave.scheduler import Scheduler

    engine = Engine(store)
    sched = Scheduler(store, engine)  # loop not started — we drive the hook
    return engine, sched


def _finished(auto_id, exec_id, status, trigger="Schedule"):
    return {"id": exec_id, "auto_id": auto_id, "trigger": trigger, "status": status}


def test_failed_scheduled_run_retried_once_per_streak(store):
    engine, sched = _mk(store)
    # first scheduled failure → one retry scheduled
    engine.on_finished(_finished("a1", "e1", "failed"))
    assert "a1" in sched._retry_at and "a1" in sched._retried
    # the retry fires (tick pops the entry) and fails again — no second retry
    sched._retry_at.pop("a1")
    engine.on_finished(_finished("a1", "e2", "failed"))
    assert "a1" not in sched._retry_at
    # a later scheduled failure of the same streak still doesn't re-arm
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
    """Real engine run with trigger Schedule arms the retry via on_finished."""
    import time

    engine, sched = _mk(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'raise RuntimeError("boom")\n'
    a = store.create_automation(ver, "Sched Fail", None)
    h = engine.start(a, "Schedule")
    t0 = time.time()
    while engine.is_live(h["id"]):
        assert time.time() - t0 < 30
        time.sleep(0.1)
    assert h["status"] == "failed"
    assert a["id"] in sched._retry_at and a["id"] in sched._retried
