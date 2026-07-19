"""Filesystem locations (§5). Data under Application Support, logs under ~/Library/Logs.
AUTODAVE_HOME overrides both for dev/tests (logs go to <home>/logs)."""
from __future__ import annotations

import os
from pathlib import Path

APP_NAME = "Auto Dave"


def app_support() -> Path:
    env = os.environ.get("AUTODAVE_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / "Library" / "Application Support" / APP_NAME


def automations_dir() -> Path:
    return app_support() / "automations"


def settings_file() -> Path:
    return app_support() / "settings.yaml"


def agents_file() -> Path:
    return app_support() / "agents.yaml"


def secrets_file() -> Path:
    return app_support() / "secrets.yaml"


def backend_json() -> Path:
    return app_support() / "backend.json"


def default_data_path() -> Path:
    return app_support() / "executions"


def pending_draft_dir() -> Path:
    """§4.4: the single pending create-mode draft slot — created when the
    create flow opens, deleted when Create or Start over settles it."""
    return app_support() / "draft"


def harness_cwd() -> Path:
    """Empty cwd for harness CLI children — keeps their startup project
    scans out of TCC-protected folders (§6), so macOS never prompts."""
    return app_support() / "harness-cwd"


def logs_dir() -> Path:
    env = os.environ.get("AUTODAVE_HOME")
    if env:
        return Path(env).expanduser() / "logs"
    return Path.home() / "Library" / "Logs" / APP_NAME


def app_log() -> Path:
    return logs_dir() / "app.log"


def ensure_dirs() -> None:
    app_support().mkdir(parents=True, exist_ok=True)
    automations_dir().mkdir(parents=True, exist_ok=True)
    default_data_path().mkdir(parents=True, exist_ok=True)
    harness_cwd().mkdir(parents=True, exist_ok=True)
    logs_dir().mkdir(parents=True, exist_ok=True)
