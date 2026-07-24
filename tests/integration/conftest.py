"""Fixtures over the §15 integration harness (it_harness.py)."""
import http.server
import threading
from pathlib import Path

import pytest

from .it_harness import Backend


@pytest.fixture()
def backend_factory(tmp_path):
    """Factory so a test can restart a backend over the same home (recovery)."""
    started: list[Backend] = []

    def make(home: Path | None = None, extra_env: dict[str, str] | None = None) -> Backend:
        b = Backend(home or tmp_path, extra_env).start()
        started.append(b)
        return b

    yield make
    for b in started:
        b.stop()


@pytest.fixture()
def backend(backend_factory):
    return backend_factory()


@pytest.fixture()
def client(backend):
    with backend.client() as c:
        yield c


@pytest.fixture()
def web_server(tmp_path):
    """Localhost stand-in for the web: serves `docroot` (robots.txt included)."""
    docroot = tmp_path / "docroot"
    docroot.mkdir()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(docroot), **kw)

        def log_message(self, *a):  # keep pytest output clean
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", docroot
    srv.shutdown()
