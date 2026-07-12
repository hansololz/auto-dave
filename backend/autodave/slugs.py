"""Automation directory slugs (§5: human-readable, id-suffixed on collision)."""
from __future__ import annotations

import re


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "automation"


def slug_for(name: str, auto_id: str, taken: set[str]) -> str:
    base = slugify(name)
    if base not in taken:
        return base
    return f"{base}-{auto_id.split('-')[0]}"
