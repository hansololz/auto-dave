"""launchd LaunchAgent management (§3 headless bootstrap): install/uninstall/status/restart.

Writes a per-user plist to ~/Library/LaunchAgents/ pointing at this interpreter —
the same service the app registers via SMAppService; the two are equivalent and
mutually exclusive (install adopts an existing registration).
"""
from __future__ import annotations

import plistlib
import subprocess
import sys
from pathlib import Path

from . import paths

LABEL = "com.autowright.backend"


def plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def install() -> str:
    plist = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, "-m", "autowright.main"],
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(paths.logs_dir() / "backend.out.log"),
        "StandardErrorPath": str(paths.logs_dir() / "backend.err.log"),
    }
    paths.logs_dir().mkdir(parents=True, exist_ok=True)  # launchd won't create it for the log paths
    p = plist_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "wb") as f:
        plistlib.dump(plist, f)
    subprocess.run(["launchctl", "unload", str(p)], capture_output=True)
    r = subprocess.run(["launchctl", "load", str(p)], capture_output=True, text=True)
    if r.returncode != 0:
        return f"install failed: {r.stderr.strip()}"
    return f"installed and started ({p})"


def uninstall() -> str:
    p = plist_path()
    subprocess.run(["launchctl", "unload", str(p)], capture_output=True)
    if p.exists():
        p.unlink()
        return "service unloaded and removed"
    return "service was not installed"


def status() -> str:
    r = subprocess.run(["launchctl", "list"], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if LABEL in line:
            pid = line.split()[0]
            alive = pid != "-"
            bj = paths.backend_json()
            port = ""
            if bj.exists():
                import json

                # A SIGKILL'd backend leaves a stale (possibly truncated)
                # backend.json — status must report, not crash.
                try:
                    port = f" · port {json.loads(bj.read_text())['port']}"
                except (OSError, ValueError, KeyError, TypeError):
                    port = " · stale backend.json"
            return ("active" if alive else "loaded, not active") + f" (pid {pid}){port}"
    return "not installed"


def restart() -> str:
    p = plist_path()
    if not p.exists():
        return "not installed — use `autowright service install` first"
    subprocess.run(["launchctl", "unload", str(p)], capture_output=True)
    r = subprocess.run(["launchctl", "load", str(p)], capture_output=True, text=True)
    return "restarted" if r.returncode == 0 else f"restart failed: {r.stderr.strip()}"
