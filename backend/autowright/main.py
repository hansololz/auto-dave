"""Backend entry point: bind localhost on a free port, write backend.json (§3),
load files, start the scheduler, serve the API."""
from __future__ import annotations

import copy
import json
import logging
import os
import socket

import uvicorn

from . import __version__, api, paths
from .scheduler import Scheduler
from .storage import store
from .yamlio import atomic_write_text


class _DevModeFilter(logging.Filter):
    """§4.9 devMode: INFO request logs pass only while the setting is on."""

    def filter(self, record: logging.LogRecord) -> bool:
        return record.levelno >= logging.WARNING or bool(store.settings.get("devMode"))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    paths.ensure_dirs()
    store.load_all()
    port = int(os.environ.get("AUTOWRIGHT_PORT", 0)) or free_port()
    # §3 discovery: port + auth token, 0600.
    atomic_write_text(paths.backend_json(), json.dumps({
        "port": port, "token": api.AUTH_TOKEN, "version": __version__, "pid": os.getpid(),
    }), mode=0o600)
    scheduler = Scheduler(store, api.engine)
    scheduler.start()
    # §4.9 devMode: request logging (every HTTP request via the uvicorn access
    # log, every agent request via autowright.harness) prints only while the
    # Settings toggle is on. The filter reads the live setting, so flipping the
    # toggle applies immediately — no restart. WARNING+ always prints.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(message)s")
    logging.getLogger().handlers[0].addFilter(_DevModeFilter())
    # uvicorn's dictConfig would wipe filters added to its loggers up front, so
    # the filter rides in on its log_config handlers instead.
    log_config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    log_config["filters"] = {"devmode": {"()": _DevModeFilter}}
    for handler in log_config["handlers"].values():
        handler.setdefault("filters", []).append("devmode")
    try:
        uvicorn.run(api.app, host="127.0.0.1", port=port, log_level="info",
                    log_config=log_config)
    finally:
        scheduler.stop()
        try:
            paths.backend_json().unlink()
        except OSError:
            pass


if __name__ == "__main__":
    main()
