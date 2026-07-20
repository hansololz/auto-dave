"""Atomic YAML/text IO (§5: every write is temp-write + rename, file-first)."""
from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger("autodave.yamlio")


def load_yaml(path: Path, default: Any = None) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return default if data is None else data
    except FileNotFoundError:
        return default
    except yaml.YAMLError as e:
        # Disk is hand-editable (§5) — a corrupt file must never brick startup
        # into a launchd crash loop; skip it with a warning like malformed triggers.
        log.warning("unreadable YAML at %s (%s) — using the default", path, e)
        return default


def atomic_write_text(path: Path, text: str, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".ad-tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def save_yaml(path: Path, data: Any, mode: int | None = None) -> None:
    atomic_write_text(path, yaml.safe_dump(data, sort_keys=False, allow_unicode=True), mode)
