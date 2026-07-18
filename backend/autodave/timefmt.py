"""Human display labels for timestamps — one shared scheme (§4.1)."""
from __future__ import annotations

import locale
from datetime import datetime

try:
    locale.setlocale(locale.LC_TIME, "")
except locale.Error:
    pass


def clock(dt: datetime) -> str:
    h = dt.hour % 12 or 12
    return f"{h}:{dt.minute:02d} {'PM' if dt.hour >= 12 else 'AM'}"


def date_label(dt: datetime, now: datetime | None = None) -> str:
    """Shared scheme: Today | Yesterday | weekday (2-6 days) | locale date."""
    now = now or datetime.now()
    days = (now.date() - dt.date()).days
    if days == 0:
        return "Today"
    if days == 1:
        return "Yesterday"
    if days < 7:
        return dt.strftime("%A")
    return dt.strftime("%x")


def started_label(dt: datetime, now: datetime | None = None) -> str:
    return f"{date_label(dt, now)}, {clock(dt)}"


def dur_label(ms: int | None) -> str:
    if ms is None:
        return "—"
    s = ms / 1000
    if s < 60:
        return f"{s:.1f}s"
    return f"{int(s // 60)}m {int(s % 60)}s"
