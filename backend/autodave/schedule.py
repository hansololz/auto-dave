"""Schedule math and display strings (§4.1, §4.3)."""
from __future__ import annotations

from datetime import datetime, timedelta

DOW_LONG = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]
DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]


def hm(hour: int, minute: int) -> str:
    return f"{hour}:{minute:02d}"


def schedule_label(hour: int, minute: int = 0, dow: int | None = None) -> str:
    if dow is None:
        return f"Daily at {hm(hour, minute)}"
    return f"{DOW_LONG[dow]} at {hm(hour, minute)}"


def schedule_short(hour: int, minute: int = 0, dow: int | None = None) -> str:
    if dow is None:
        return f"Daily {hm(hour, minute)}"
    return f"{DOW_SHORT[dow]} {hm(hour, minute)}"


def next_occurrence(hour: int, minute: int = 0, dow: int | None = None,
                    after: datetime | None = None) -> datetime:
    """Next occurrence strictly after `after` (§4.3 roll-forward rules)."""
    now = after or datetime.now()
    nxt = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if dow is not None:
        # Python weekday(): Mon=0; spec dow: Sun=0.
        py_dow = (dow - 1) % 7
        add = (py_dow - nxt.weekday()) % 7
        if add == 0 and nxt <= now:
            add = 7
        nxt += timedelta(days=add)
    elif nxt <= now:
        nxt += timedelta(days=1)
    return nxt


def countdown(hour: int, minute: int = 0, dow: int | None = None,
              now: datetime | None = None) -> str:
    now = now or datetime.now()
    nxt = next_occurrence(hour, minute, dow, now)
    total_min = max(1, round((nxt - now).total_seconds() / 60))
    dd, rem = divmod(total_min, 1440)
    hh, mm = divmod(rem, 60)
    return f"{dd}d {hh}h" if dd > 0 else f"{hh}h {mm}m"
