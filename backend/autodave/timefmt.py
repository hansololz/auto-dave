"""Human display labels for timestamps (§4.1 lastRunLabel, §4.5 started)."""
from __future__ import annotations

from datetime import datetime


def clock(dt: datetime) -> str:
    h = dt.hour % 12 or 12
    return f"{h}:{dt.minute:02d} {'PM' if dt.hour >= 12 else 'AM'}"


def started_label(dt: datetime, now: datetime | None = None) -> str:
    now = now or datetime.now()
    days = (now.date() - dt.date()).days
    if days == 0:
        if (now - dt).total_seconds() < 90:
            return f"Just now, {clock(dt)}"
        return f"Today, {clock(dt)}"
    if days == 1:
        return f"Yesterday, {clock(dt)}"
    if days < 7:
        return f"{dt.strftime('%a')}, {clock(dt)}"
    return f"{dt.strftime('%b')} {dt.day}, {clock(dt)}"


def last_run_label(dt: datetime | None, now: datetime | None = None) -> str:
    if dt is None:
        return ""
    now = now or datetime.now()
    secs = (now - dt).total_seconds()
    if secs < 90:
        return "just now"
    if secs < 3600:
        return f"{int(secs // 60)}m ago"
    if (now.date() - dt.date()).days == 0:
        return f"{int(secs // 3600)}h ago"
    if (now.date() - dt.date()).days == 1:
        return "yesterday"
    return f"{dt.strftime('%b')} {dt.day}"


def dur_label(ms: int | None) -> str:
    if ms is None:
        return "—"
    s = ms / 1000
    if s < 60:
        return f"{s:.1f}s"
    return f"{int(s // 60)}m {int(s % 60)}s"


def ago_label(dt: datetime | None, now: datetime | None = None) -> str:
    """Relative label for memory/updated chips: 'updated this morning', 'updated Jun 28'."""
    if dt is None:
        return "empty"
    now = now or datetime.now()
    days = (now.date() - dt.date()).days
    if days == 0:
        return "updated this morning" if dt.hour < 12 else "updated today"
    if days == 1:
        return "updated yesterday"
    if days < 7:
        return f"updated {dt.strftime('%A')}"
    return f"updated {dt.strftime('%b')} {dt.day}"
