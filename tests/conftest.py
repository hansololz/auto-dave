import os
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend"))

# tests/bin holds a fake `claude` CLI so agent calls run the real subprocess
# path (backend → runner → Popen) without a real agent installed. Prepended at
# import time so engine subprocesses inherit it.
os.environ["PATH"] = f"{REPO / 'tests' / 'bin'}{os.pathsep}{os.environ['PATH']}"


@pytest.fixture(autouse=True)
def fake_keychain(monkeypatch):
    """In-memory stand-in for the macOS Keychain (backend-process only calls)."""
    from autodave import keychain

    mem: dict[str, str] = {}
    monkeypatch.setattr(keychain, "get_secret", mem.get)
    monkeypatch.setattr(keychain, "set_secret", mem.__setitem__)
    monkeypatch.setattr(keychain, "delete_secret", lambda name: mem.pop(name, None))


@pytest.fixture(autouse=True)
def no_notifications(monkeypatch):
    from autodave import notify

    monkeypatch.setattr(notify, "post", lambda title, body: None)


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """Isolated Auto Dave home per test."""
    monkeypatch.setenv("AUTODAVE_HOME", str(tmp_path))
    from autodave import paths

    paths.ensure_dirs()
    return tmp_path


@pytest.fixture()
def store(home):
    from autodave.storage import Store

    s = Store()
    s.load_all()
    return s


def make_version(**over):
    ver = {
        "desc": "Test automation",
        "note": "Created",
        "params": [
            {"name": "greeting", "kind": "text", "label": "Greeting", "help": "", "default": "hello"},
            {"name": "count", "kind": "number", "label": "Count", "help": "", "min": 1, "default": 3},
        ],
        "steps": [
            {"file": "01-say.py", "name": "Say hello", "desc": "prints",
             "code": 'log(f"{params[\'greeting\']} x{params[\'count\']}")\n'},
            {"file": "02-finish.py", "name": "Finish", "desc": "result",
             "code": 'result.status("ok")\nresult.chip("All good")\nresult.text("done")\n'},
        ],
        "spec": [{"k": "h1", "text": "Test automation"}, {"k": "p", "text": "It tests."}],
        "instr": None,
    }
    ver.update(over)
    return ver
