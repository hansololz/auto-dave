"""launchd LaunchAgent management (§3): install/status/uninstall.

launchctl is never touched — every subprocess.run is a recorded fake, and
plist_path is redirected into the per-test home.
"""
import json
import plistlib
import sys
from types import SimpleNamespace

import pytest


@pytest.fixture()
def svc(home, monkeypatch):
    """service module with plist_path in tmp home and subprocess.run recorded."""
    from autowright import service

    plist = home / "LaunchAgents" / f"{service.LABEL}.plist"
    monkeypatch.setattr(service, "plist_path", lambda: plist)

    calls = []
    results = {}  # verb ("load"/"unload"/"list") → canned result override

    def fake_run(cmd, **kw):
        calls.append(list(cmd))
        assert cmd[0] == "launchctl"
        return results.get(cmd[1],
                           SimpleNamespace(returncode=0, stdout="", stderr=""))

    monkeypatch.setattr(service.subprocess, "run", fake_run)
    return SimpleNamespace(mod=service, plist=plist, calls=calls, results=results)


# ---------------------------------------------------------------- install

def test_install_writes_plist_and_reloads(svc):
    out = svc.mod.install()
    assert str(svc.plist) in out and out.startswith("installed and started")

    with open(svc.plist, "rb") as f:
        plist = plistlib.load(f)
    assert plist["Label"] == "com.autowright.backend"
    assert plist["ProgramArguments"] == [sys.executable, "-m", "autowright.main"]
    assert plist["RunAtLoad"] is True
    assert plist["KeepAlive"] is True

    # unload-then-load, in that order, both against the written plist
    assert svc.calls == [
        ["launchctl", "unload", str(svc.plist)],
        ["launchctl", "load", str(svc.plist)],
    ]


def test_install_reports_failed_load(svc):
    svc.results["load"] = SimpleNamespace(returncode=1, stdout="",
                                          stderr="Load failed: 5\n")
    out = svc.mod.install()
    assert out == "install failed: Load failed: 5"
    assert svc.plist.exists()  # plist written before the load attempt


# ---------------------------------------------------------------- status

def _list_result(stdout):
    return SimpleNamespace(returncode=0, stdout=stdout, stderr="")


def test_status_parses_active_pid_and_port(svc, home):
    svc.results["list"] = _list_result(
        "PID\tStatus\tLabel\n"
        "77\t0\tcom.apple.other\n"
        "1234\t0\tcom.autowright.backend\n")
    from autowright import paths

    paths.backend_json().write_text(json.dumps({"port": 5151, "token": "t"}))
    assert svc.mod.status() == "active (pid 1234) · port 5151"


def test_status_loaded_not_active(svc):
    svc.results["list"] = _list_result("-\t0\tcom.autowright.backend\n")
    assert svc.mod.status() == "loaded, not active (pid -)"


def test_status_not_installed(svc):
    svc.results["list"] = _list_result("1\t0\tcom.apple.other\n")
    assert svc.mod.status() == "not installed"


def test_status_tolerates_stale_or_garbage_backend_json(svc):
    svc.results["list"] = _list_result("42\t0\tcom.autowright.backend\n")
    from autowright import paths

    bj = paths.backend_json()
    for garbage in ('{"port": 51', "not json at all", json.dumps({"token": "t"}),
                    ""):
        bj.write_text(garbage)
        assert svc.mod.status() == "active (pid 42) · stale backend.json"


# ---------------------------------------------------------------- uninstall

def test_uninstall_removes_plist_and_unloads(svc):
    svc.plist.parent.mkdir(parents=True, exist_ok=True)
    svc.plist.write_bytes(b"<plist/>")
    assert svc.mod.uninstall() == "service unloaded and removed"
    assert not svc.plist.exists()
    assert svc.calls == [["launchctl", "unload", str(svc.plist)]]


def test_uninstall_when_not_installed(svc):
    assert svc.mod.uninstall() == "service was not installed"
    # unload is still attempted (harmless), plist untouched
    assert svc.calls == [["launchctl", "unload", str(svc.plist)]]
