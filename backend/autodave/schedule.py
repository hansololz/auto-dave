"""Trigger math and display strings (§4.1, §4.3): the cron dialect, one-shot
times, next occurrences, humanized labels, and trigger validation."""
from __future__ import annotations

import uuid
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

DOW_LONG = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]
DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

CRON_KINDS = ("cron",)
RESERVED_KINDS = ("discord", "imessage", "pubsub")  # §4.3 message triggers — coming soon

# Unsatisfiable expressions (e.g. "0 0 30 2 *") stop searching after this many days.
_SEARCH_DAYS = 366 * 5


class CronError(ValueError):
    pass


# ---------- cron dialect (§4.3): 5 fields, numbers only, * , - / ----------

_FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"]
_FIELD_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]


def _parse_field(text: str, name: str, lo: int, hi: int) -> tuple[set[int], bool]:
    """One cron field → (matching values, is unrestricted `*`)."""
    out: set[int] = set()
    if not text:
        raise CronError(f"{name} field is empty")
    for item in text.split(","):
        body, _, step_s = item.partition("/")
        step = 1
        if step_s:
            if not step_s.isdigit() or int(step_s) < 1:
                raise CronError(f"{name}: bad step {item!r}")
            step = int(step_s)
        if body == "*":
            a, b = lo, hi
        elif "-" in body:
            a_s, _, b_s = body.partition("-")
            if not (a_s.isdigit() and b_s.isdigit()):
                raise CronError(f"{name}: bad range {item!r}")
            a, b = int(a_s), int(b_s)
        elif body.isdigit():
            a = b = int(body)
        else:
            raise CronError(f"{name}: bad value {item!r} (numbers only)")
        if not (lo <= a <= hi and lo <= b <= hi and a <= b):
            raise CronError(f"{name}: {item!r} out of range {lo}-{hi}")
        out.update(range(a, b + 1, step))
    return out, text == "*"


def parse_cron(expr: str) -> list[tuple[set[int], bool]]:
    """Validate + expand a §4.3 cron expression; raises CronError."""
    fields = (expr or "").split()
    if len(fields) != 5:
        raise CronError("a cron expression needs 5 fields (minute hour day month weekday)")
    return [_parse_field(f, n, lo, hi)
            for f, n, (lo, hi) in zip(fields, _FIELD_NAMES, _FIELD_RANGES)]


def cron_next(expr: str, after: datetime | None = None) -> datetime | None:
    """Next match strictly after `after` (local wall clock), None if unsatisfiable."""
    (mins, _), (hours, _), (doms, dom_star), (months, _), (dows, dow_star) = parse_cron(expr)
    t = (after or datetime.now()).replace(second=0, microsecond=0) + timedelta(minutes=1)
    hhmm = [(hh, mm) for hh in sorted(hours) for mm in sorted(mins)]
    day = t.date()
    for _ in range(_SEARCH_DAYS):
        if day.month in months:
            spec_dow = (day.weekday() + 1) % 7  # weekday(): Mon=0 → spec Sun=0
            # Vixie rule: both dom and dow restricted → a date matching either fires.
            if (day.day in doms if dow_star else
                    spec_dow in dows if dom_star else
                    day.day in doms or spec_dow in dows):
                floor = t if day == t.date() else datetime.combine(day, time.min)
                for hh, mm in hhmm:
                    cand = datetime(day.year, day.month, day.day, hh, mm)
                    if cand >= floor:
                        return cand
        day += timedelta(days=1)
    return None


# ---------- timezone (§4.3 `tz`): wall clock in the trigger's zone ----------

def zone_of(t: dict) -> ZoneInfo | None:
    """The trigger's zone, None when local. Assumes a validated `tz`."""
    return ZoneInfo(t["tz"]) if t.get("tz") else None


def _to_wall(local: datetime, tz: ZoneInfo) -> datetime:
    """Local naive → the zone's naive wall clock."""
    return local.astimezone(tz).replace(tzinfo=None)


def _to_local(wall: datetime, tz: ZoneInfo) -> datetime:
    """The zone's naive wall clock → local naive."""
    return wall.replace(tzinfo=tz).astimezone().replace(tzinfo=None)


def tz_error(tz) -> str | None:
    """Error message for an unusable `tz` value, None when valid (or absent)."""
    if tz is None:
        return None
    try:
        if not isinstance(tz, str):
            raise ValueError
        ZoneInfo(tz)
    except Exception:  # noqa: BLE001 — ZoneInfoNotFoundError, ValueError, ...
        return f"unknown timezone {tz!r} — use an IANA name like Asia/Tokyo"
    return None


def _tz_suffix(tz: str | None) -> str:
    """§4.3: labels append the zone's city — last IANA segment, _ → space."""
    return f" ({tz.rsplit('/', 1)[-1].replace('_', ' ')})" if tz else ""


# ---------- triggers (§4.3) ----------

def validate_trigger(t: dict) -> str | None:
    """§19 PATCH rule: error message, or None when the trigger is storable."""
    kind = t.get("kind")
    if kind in RESERVED_KINDS:
        return f"{kind} triggers are coming soon"
    if kind == "cron":
        if err := tz_error(t.get("tz")):
            return err
        try:
            parse_cron(t.get("expr") or "")
        except CronError as e:
            return str(e)
        return None
    if kind == "time":
        if err := tz_error(t.get("tz")):
            return err
        try:
            at = datetime.fromisoformat(t.get("at") or "")
        except (TypeError, ValueError):
            return "invalid timestamp — use local ISO format like 2026-07-20T15:00"
        tz = zone_of(t)
        if (_to_local(at, tz) if tz else at) <= datetime.now():
            return "the time must be in the future"
        return None
    return f"unknown trigger kind {kind!r}"


def normalize_triggers(raw: list) -> tuple[list[dict], str | None]:
    """Validate a whole list; assign ids to new entries. → (stored shape, error)."""
    out: list[dict] = []
    for t in raw or []:
        if not isinstance(t, dict):
            return [], "each trigger must be an object"
        err = validate_trigger(t)
        if err:
            return [], err
        n: dict = {"id": t.get("id") or str(uuid.uuid4()),
                   "kind": t["kind"], "off": bool(t.get("off", False))}
        if t["kind"] == "cron":
            n["expr"] = t["expr"].strip()
        else:
            n["at"] = t["at"]
        if t.get("tz"):
            n["tz"] = t["tz"]
        out.append(n)
    return out, None


def _hm(hour: int, minute: int) -> str:
    return f"{hour}:{minute:02d}"


def cron_display(expr: str, tz: str | None = None) -> tuple[str, str]:
    """§4.3 humanized labels — exactly two simple shapes get words."""
    sfx = _tz_suffix(tz)
    p = expr.split()
    if len(p) == 5 and p[0].isdigit() and p[1].isdigit() and p[2] == "*" and p[3] == "*":
        t = _hm(int(p[1]), int(p[0]))
        if p[4] == "*":
            return f"Daily at {t}{sfx}", f"Daily {t}{sfx}"
        if p[4].isdigit():
            d = int(p[4])
            return f"{DOW_LONG[d]} at {t}{sfx}", f"{DOW_SHORT[d]} {t}{sfx}"
    return expr + sfx, expr + sfx


def time_display(at: str, tz: str | None = None) -> tuple[str, str]:
    dt = datetime.fromisoformat(at)
    sfx = _tz_suffix(tz)
    ampm = f"{(dt.hour % 12) or 12}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"
    day = f"{dt.strftime('%b')} {dt.day}"
    return f"Once at {day}, {ampm}{sfx}", f"Once {day} {_hm(dt.hour, dt.minute)}{sfx}"


def trigger_display(t: dict) -> tuple[str, str]:
    if t["kind"] == "cron":
        return cron_display(t["expr"], t.get("tz"))
    return time_display(t["at"], t.get("tz"))


def trigger_exec_label(t: dict) -> str:
    """§4.5 execution trigger label."""
    return "Cron" if t["kind"] == "cron" else "Once"


def trigger_next(t: dict, after: datetime | None = None) -> datetime | None:
    """Next occurrence of one trigger strictly after `after`, both local naive.
    A `tz` trigger is evaluated on its zone's wall clock (off is the caller's concern)."""
    tz = zone_of(t)
    base = after or datetime.now()
    if t["kind"] == "cron":
        if not tz:
            return cron_next(t["expr"], base)
        nxt = cron_next(t["expr"], _to_wall(base, tz))
        return _to_local(nxt, tz) if nxt else None
    at = datetime.fromisoformat(t["at"])
    if tz:
        at = _to_local(at, tz)
    return at if at > base else None


def next_at(triggers: list[dict], after: datetime | None = None) -> datetime | None:
    """§4.3 nextAt: minimum over enabled triggers, None when nothing is coming."""
    nxts = [n for t in triggers if not t["off"] if (n := trigger_next(t, after))]
    return min(nxts) if nxts else None


def trigger_chip(triggers: list[dict]) -> str:
    if not triggers:
        return "No triggers"
    if len(triggers) == 1:
        return trigger_display(triggers[0])[1]
    return f"{len(triggers)} triggers"


def countdown(nxt: datetime, now: datetime | None = None) -> str:
    now = now or datetime.now()
    total_min = max(1, round((nxt - now).total_seconds() / 60))
    dd, rem = divmod(total_min, 1440)
    hh, mm = divmod(rem, 60)
    return f"{dd}d {hh}h" if dd > 0 else f"{hh}h {mm}m"
