from datetime import datetime

from autodave.schedule import countdown, next_occurrence, schedule_label, schedule_short


def test_daily_rolls_forward():
    now = datetime(2026, 7, 10, 9, 0)  # Friday 9:00
    nxt = next_occurrence(8, 0, None, after=now)
    assert nxt == datetime(2026, 7, 11, 8, 0)
    nxt = next_occurrence(21, 30, None, after=now)
    assert nxt == datetime(2026, 7, 10, 21, 30)


def test_weekly_dow_sunday_zero():
    now = datetime(2026, 7, 10, 9, 0)  # Friday
    assert next_occurrence(9, 0, 1, after=now) == datetime(2026, 7, 13, 9, 0)  # Monday
    assert next_occurrence(21, 0, 0, after=now) == datetime(2026, 7, 12, 21, 0)  # Sunday
    # same dow, time already passed → next week
    assert next_occurrence(8, 0, 5, after=now) == datetime(2026, 7, 17, 8, 0)  # Friday


def test_labels():
    assert schedule_label(8, 0, None) == "Daily at 8:00"
    assert schedule_label(9, 0, 1) == "Mondays at 9:00"
    assert schedule_short(21, 0, 0) == "Sun 21:00"
    assert countdown(10, 0, None, now=datetime(2026, 7, 10, 8, 30)) == "1h 30m"
    assert countdown(8, 0, 1, now=datetime(2026, 7, 10, 9, 0)) == "2d 23h"


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
