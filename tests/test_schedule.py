from datetime import datetime, timedelta

import pytest

from autowright.schedule import (
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


def test_tz_validation():
    assert validate_trigger({"kind": "cron", "expr": "0 8 * * *", "tz": "Asia/Tokyo"}) is None
    assert "unknown timezone" in validate_trigger({"kind": "cron", "expr": "0 8 * * *", "tz": "Mars/Olympus"})
    assert "unknown timezone" in validate_trigger({"kind": "time", "at": "2099-01-01T00:00", "tz": 5})
    norm, err = normalize_triggers([{"kind": "cron", "expr": "0 8 * * *", "tz": "UTC"}])
    assert err is None and norm[0]["tz"] == "UTC"
    norm, err = normalize_triggers([{"kind": "cron", "expr": "0 8 * * *"}])
    assert err is None and "tz" not in norm[0]


def test_tz_cron_next_is_zone_wall_clock():
    from datetime import timezone
    now = datetime(2026, 7, 10, 9, 0)
    # "0 8 * * *" in UTC: next 08:00 UTC after `now` (local), expressed in local naive time.
    got = trigger_next({"id": "1", "kind": "cron", "off": False, "expr": "0 8 * * *", "tz": "UTC"}, after=now)
    now_utc = now.astimezone(timezone.utc).replace(tzinfo=None)
    nxt_utc = now_utc.replace(hour=8, minute=0, second=0, microsecond=0)
    if nxt_utc <= now_utc:
        nxt_utc += timedelta(days=1)
    assert got == nxt_utc.replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None)


def test_tz_time_trigger():
    from datetime import timezone
    wall = datetime.now(timezone.utc) + timedelta(hours=2)
    at = wall.replace(tzinfo=None).isoformat(timespec="minutes")
    t = {"id": "1", "kind": "time", "off": False, "at": at, "tz": "UTC"}
    assert validate_trigger(t) is None
    got = trigger_next(t)
    expect = datetime.fromisoformat(at).replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None)
    assert got == expect
    past = (datetime.now(timezone.utc) - timedelta(hours=2)).replace(tzinfo=None).isoformat(timespec="minutes")
    assert "future" in validate_trigger({"kind": "time", "at": past, "tz": "UTC"})


def test_tz_labels():
    assert cron_display("0 8 * * *", "Asia/Tokyo") == ("Daily at 8:00 (Tokyo)", "Daily 8:00 (Tokyo)")
    assert cron_display("0 9 * * 1", "America/New_York")[1] == "Mon 9:00 (New York)"
    assert cron_display("*/15 * * * *", "UTC") == ("*/15 * * * * (UTC)", "*/15 * * * * (UTC)")
    assert time_display("2026-07-20T15:00", "Asia/Tokyo") == (
        "Once at Jul 20, 3:00 PM (Tokyo)", "Once Jul 20 15:00 (Tokyo)")


def test_app_start_trigger():
    from autowright.schedule import trigger_display, trigger_exec_label

    assert validate_trigger({"kind": "app_start"}) is None
    norm, err = normalize_triggers([{"kind": "app_start", "off": True, "tz": "UTC"}])
    assert err is None
    assert norm[0]["kind"] == "app_start" and norm[0]["off"] is True and norm[0]["id"]
    assert "tz" not in norm[0] and "expr" not in norm[0] and "at" not in norm[0]
    # §4.3: at most one per automation
    _, err = normalize_triggers([{"kind": "app_start"}, {"kind": "app_start"}])
    assert "one app-start" in err
    t = {"id": "1", "kind": "app_start", "off": False}
    assert trigger_next(t) is None  # no computable next occurrence
    assert next_at([t]) is None
    assert trigger_display(t) == ("On app start", "App start")
    assert trigger_chip([t]) == "App start"
    assert trigger_exec_label(t) == "App start"


def test_reserved_and_unknown_kinds_rejected():
    for kind in ("discord", "imessage", "pubsub"):
        assert "coming soon" in validate_trigger({"kind": kind})
    assert "unknown" in validate_trigger({"kind": "webhook"})
    _, err = normalize_triggers([{"kind": "discord"}])
    assert err
    norm, err = normalize_triggers([{"kind": "cron", "expr": "0 8 * * *", "off": True}])
    assert err is None and norm[0]["off"] is True and norm[0]["id"]


def test_specmd_roundtrip():
    from autowright.specmd import blocks_to_md, md_to_blocks

    blocks = [
        {"k": "h1", "text": "Title"},
        {"k": "p", "text": "A paragraph of text."},
        {"k": "h2", "text": "Section"},
        {"k": "li", "text": "first"},
        {"k": "li", "text": "second"},
        {"k": "p", "text": "Closing."},
    ]
    assert md_to_blocks(blocks_to_md(blocks)) == blocks


# ---------- §15 cross-runtime parity fixture (shared with the TypeScript suite) ----------

def _fixture():
    import json
    from pathlib import Path

    return json.loads((Path(__file__).parent / "fixtures" / "cron_parity.json").read_text())


def _utc_str_to_local_naive(s):
    from datetime import timezone

    return (datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")
            .replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None))


def _local_naive_to_utc_str(dt):
    from datetime import timezone

    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def test_cron_parity_fixture_next_occurrences():
    for e in _fixture()["next"]:
        trig = {"kind": "cron", "expr": e["expr"], "tz": e["tz"], "off": False, "id": "x"}
        got = trigger_next(trig, after=_utc_str_to_local_naive(e["after_utc"]))
        if e["next_utc"] is None:
            assert got is None, e
        else:
            assert got is not None, e
            assert _local_naive_to_utc_str(got) == e["next_utc"], e


def test_cron_parity_fixture_labels():
    for e in _fixture()["labels"]:
        assert cron_display(e["expr"], e["tz"]) == (e["label"], e["short"]), e


def test_dst_spring_forward_gap_fires_next_valid_instant():
    """§4.3: 2:30 AM is erased on 2027-03-14 in Los Angeles — the trigger
    still fires, at the first valid instant (10:30 UTC)."""
    trig = {"kind": "cron", "expr": "30 2 * * *", "tz": "America/Los_Angeles",
            "off": False, "id": "x"}
    after = _utc_str_to_local_naive("2027-03-13T18:00:00Z")
    got = trigger_next(trig, after=after)
    assert got == _utc_str_to_local_naive("2027-03-14T10:30:00Z")


def test_dst_fall_back_ambiguity_fires_once_at_earlier_instant():
    """§4.3: 1:30 AM happens twice on 2026-11-01 in Los Angeles — one firing,
    at the earlier instant (08:30 UTC, PDT side)."""
    trig = {"kind": "cron", "expr": "30 1 * * *", "tz": "America/Los_Angeles",
            "off": False, "id": "x"}
    after = _utc_str_to_local_naive("2026-10-31T18:00:00Z")
    got = trigger_next(trig, after=after)
    assert got == _utc_str_to_local_naive("2026-11-01T08:30:00Z")
    # the occurrence after it is the next day's (PST) — not the repeated 1:30
    assert trigger_next(trig, after=got) == _utc_str_to_local_naive("2026-11-02T09:30:00Z")


def test_cron_display_dow_edge_parity():
    """§4.3: only a single-digit 0-6 dow humanizes; "7", "07", "00" fall back
    to the raw expression — no exception, no humanizing."""
    for expr in ("0 8 * * 7", "0 8 * * 07", "0 8 * * 00"):
        assert cron_display(expr) == (expr, expr)
    # whitespace-padded expressions fall back trimmed
    assert cron_display("  0 8 1 * *  ") == ("0 8 1 * *", "0 8 1 * *")
    # single-digit 0-6 humanizes
    assert cron_display("0 8 * * 0") == ("Sundays at 8:00", "Sun 8:00")
    assert cron_display("0 8 * * 6") == ("Saturdays at 8:00", "Sat 8:00")


def test_trigger_exec_labels():
    from autowright.schedule import trigger_exec_label

    assert trigger_exec_label({"kind": "cron"}) == "Cron"
    assert trigger_exec_label({"kind": "app_start"}) == "App start"
    assert trigger_exec_label({"kind": "time"}) == "Once"
