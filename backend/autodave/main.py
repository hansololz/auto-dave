"""Backend entry point: bind localhost on a free port, write backend.json (§3),
load files, start the scheduler, serve the API."""
from __future__ import annotations

import json
import logging
import os
import socket

import uvicorn

from . import __version__, api, paths
from .scheduler import Scheduler
from .storage import store
from .yamlio import atomic_write_text


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    paths.ensure_dirs()
    store.load_all()
    port = int(os.environ.get("AUTODAVE_PORT", 0)) or free_port()
    # §3 discovery: port + auth token, 0600.
    atomic_write_text(paths.backend_json(), json.dumps({
        "port": port, "token": api.AUTH_TOKEN, "version": __version__, "pid": os.getpid(),
    }), mode=0o600)
    scheduler = Scheduler(store, api.engine)
    scheduler.start()
    # AUTODAVE_ACCESS_LOG=1 (§15, opt-in): log every HTTP request and every agent
    # request. basicConfig makes autodave.* INFO logs print.
    dev_log = os.environ.get("AUTODAVE_ACCESS_LOG") == "1"
    if dev_log:
        logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(message)s")
    log_level = "info" if dev_log else "warning"
    try:
        uvicorn.run(api.app, host="127.0.0.1", port=port, log_level=log_level)
    finally:
        scheduler.stop()
        try:
            paths.backend_json().unlink()
        except OSError:
            pass


if __name__ == "__main__":
    main()
