from datetime import datetime, timedelta

import pytest

from autodave.schedule import (
    CronError, countdown, cron_display, cron_next, next_at, normalize_triggers,
    parse_cron, time_display, trigger_chip, trigger_next, validate_trigger,
)


def test_cron_daily_rolls_forward():
    now = datetime(2026, 7, 10, 9, 0)  # Friday 9:00
    assert cron_next("0 8 * * *", after=now) == datetime(2026, 7, 11, 8, 0)
    assert cron_next("30 21 * * *", after=now) == datetime(2026, 7, 10, 21, 30)


def test_cron_weekly_dow_sunday_zero():
    now = datetime(2026, 7, 10, 9, 0)  # Friday
    assert cron_next("0 9 * * 1", after=now) == datetime(2026, 7, 13, 9, 0)  # Monday
    assert cron_next("0 21 * * 0", after=now) == datetime(2026, 7, 12, 21, 0)  # Sunday
    # same dow, time already passed → next week
    assert cron_next("0 8 * * 5", after=now) == datetime(2026, 7, 17, 8, 0)  # Friday


def test_cron_lists_ranges_steps():
    now = datetime(2026, 7, 10, 9, 1)
    # every 15 minutes
    assert cron_next("*/15 * * * *", after=now) == datetime(2026, 7, 10, 9, 15)
    # weekday mornings 9-17 hourly
    assert cron_next("0 9-17 * * 1-5", after=now) == datetime(2026, 7, 10, 10, 0)
    # explicit list
    assert cron_next("0 8,20 * * *", after=now) == datetime(2026, 7, 10, 20, 0)


def test_cron_vixie_dom_dow_either_matches():
    # Both restricted: the 15th OR Mondays.
    now = datetime(2026, 7, 10, 9, 0)  # Friday
    assert cron_next("0 8 15 * 1", after=now) == datetime(2026, 7, 13, 8, 0)  # Monday first
    assert cron_next("0 8 15 * 1", after=datetime(2026, 7, 13, 9, 0)) == datetime(2026, 7, 15, 8, 0)


def test_cron_unsatisfiable_returns_none():
    assert cron_next("0 0 30 2 *", after=datetime(2026, 7, 10)) is None


def test_cron_rejects_bad_expressions():
    for expr in ["", "0 8 * *", "60 8 * * *", "0 8 * * 7", "0 8 * * mon", "@daily", "0 8 * * 1-0"]:
        with pytest.raises(CronError):
            parse_cron(expr)


def test_labels():
    assert cron_display("0 8 * * *") == ("Daily at 8:00", "Daily 8:00")
    assert cron_display("0 9 * * 1") == ("Mondays at 9:00", "Mon 9:00")
    assert cron_display("0 21 * * 0")[1] == "Sun 21:00"
    # anything beyond the two simple shapes shows the raw expression
    assert cron_display("*/15 9-17 * * 1-5") == ("*/15 9-17 * * 1-5", "*/15 9-17 * * 1-5")
    assert time_display("2026-07-20T15:00") == ("Once at Jul 20, 3:00 PM", "Once Jul 20 15:00")
    assert countdown(datetime(2026, 7, 10, 10, 0), now=datetime(2026, 7, 10, 8, 30)) == "1h 30m"
    assert countdown(datetime(2026, 7, 13, 8, 0), now=datetime(2026, 7, 10, 9, 0)) == "2d 23h"


def test_trigger_chip_and_next_at():
    t1 = {"id": "1", "kind": "cron", "off": False, "expr": "0 8 * * *"}
    t2 = {"id": "2", "kind": "cron", "off": False, "expr": "0 2 * * *"}
    assert trigger_chip([]) == "No triggers"
    assert trigger_chip([t1]) == "Daily 8:00"
    assert trigger_chip([t1, t2]) == "2 triggers"
    now = datetime(2026, 7, 10, 9, 0)
    assert next_at([t1, t2], after=now) == datetime(2026, 7, 11, 2, 0)
    assert next_at([{**t1, "off": True}, {**t2, "off": True}], after=now) is None


def test_time_trigger_validation_and_next():
    future = (datetime.now() + timedelta(days=1)).isoformat(timespec="minutes")
    past = (datetime.now() - timedelta(days=1)).isoformat(timespec="minutes")
    assert validate_trigger({"kind": "time", "at": future}) is None
    assert "future" in validate_trigger({"kind": "time", "at": past})
    assert "timestamp" in validate_trigger({"kind": "time", "at": "not-a-time"})
    t = {"id": "1", "kind": "time", "off": False, "at": future}
    assert trigger_next(t) == datetime.fromisoformat(future)
    assert trigger_next(t, after=datetime.fromisoformat(future)) is None  # spent


def test_reserved_and_unknown_kinds_rejected():
    for kind in ("discord", "imessage", "pubsub"):
        assert "coming soon" in validate_trigger({"kind": kind})
    assert "unknown" in validate_trigger({"kind": "webhook"})
    _, err = normalize_triggers([{"kind": "discord"}])
    assert err
    norm, err = normalize_triggers([{"kind": "cron", "expr": "0 8 * * *", "off": True}])
    assert err is None and norm[0]["off"] is True and norm[0]["id"]


def test_specmd_roundtrip():
    from autodave.specmd import blocks_to_md, md_to_blocks

    blocks = [
        {"k": "h1", "text": "Title"},
        {"k": "p", "text": "A paragraph of text."},
        {"k": "h2", "text": "Section"},
        {"k": "li", "text": "first"},
        {"k": "li", "text": "second"},
        {"k": "p", "text": "Closing."},
    ]
    assert md_to_blocks(blocks_to_md(blocks)) == blocks
