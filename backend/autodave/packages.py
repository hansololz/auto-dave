"""Declared-package install (§6.2): packages a manifest declares beyond the
curated list install into `<app-support>/site-packages` via the bundled
interpreter's pip — the user never runs pip. Manifests carry bare distribution
names; the installed distribution is the single source of truth for the
version. One idempotent `ensure` serves every call site: the §8 post-steps
install stage, the §19 install endpoint, and the engine's pre-execution
self-heal (§7). `outdated` backs the §11 update badges — read-only PyPI
lookups, never pip; `upgrade` backs the §11 Update button."""
from __future__ import annotations

import re
import subprocess
import sys
import threading
from pathlib import Path

from . import paths

# §6.2/§8: bare PEP 503 distribution name — no version specifier, no extras.
PIP_NAME_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")

INSTALL_TIMEOUT = 600  # seconds per package

# §6.2: one pip run at a time process-wide — pip has no locking of its own,
# and a draft-stage install may race the engine's pre-execution ensure.
_pip_lock = threading.Lock()


def site_packages_dir() -> Path:
    return paths.app_support() / "site-packages"


def _norm(name: str) -> str:
    """PEP 503 distribution-name normalization."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _installed_versions() -> dict[str, str]:
    """Normalized distribution name → version, in the §6.2 directory only."""
    import importlib.metadata as md

    out: dict[str, str] = {}
    d = site_packages_dir()
    if not d.exists():
        return out
    for dist in md.distributions(path=[str(d)]):
        try:
            out[_norm(dist.metadata["Name"])] = dist.version
        except Exception:  # noqa: BLE001 — a broken dist-info never blocks the check
            continue
    return out


def check(entries: list[dict]) -> list[dict]:
    """§19 POST /packages/check — the fast installed-check, never runs pip.
    Each entry comes back as {pip, import, status: installed | missing,
    version?} — `version` is the real installed version (§6.2: the installed
    distribution is the source of truth; any version counts as installed)."""
    installed = _installed_versions()
    out = []
    for e in entries or []:
        name = str(e.get("pip") or "").strip()
        version = installed.get(_norm(name)) if PIP_NAME_RE.match(name) else None
        r = {"pip": name, "import": str(e.get("import") or "").strip(),
             "status": "installed" if version else "missing"}
        if version:
            r["version"] = version
        out.append(r)
    return out


PYPI_TIMEOUT = 8  # seconds per package lookup


def _latest_compatible(name: str) -> str | None:
    """Newest stable, non-yanked PyPI version of `name` that ships a wheel
    compatible with the bundled interpreter (§6.2 wheels-only applies to the
    update check too). None on any lookup/parse failure — advisory feature."""
    import json
    import urllib.request

    from packaging.tags import sys_tags
    from packaging.utils import parse_wheel_filename
    from packaging.version import InvalidVersion, Version

    url = f"https://pypi.org/pypi/{_norm(name)}/json"
    req = urllib.request.Request(url, headers={"User-Agent": "AutoDave/1.0"})
    with urllib.request.urlopen(req, timeout=PYPI_TIMEOUT) as resp:
        releases = json.load(resp).get("releases") or {}
    supported = set(sys_tags())
    candidates: list[tuple[Version, list]] = []
    for ver_str, files in releases.items():
        try:
            v = Version(ver_str)
        except InvalidVersion:
            continue
        if v.is_prerelease or v.is_devrelease or not files:
            continue
        candidates.append((v, files))
    for v, files in sorted(candidates, reverse=True):
        for f in files:
            if f.get("yanked") or not str(f.get("filename", "")).endswith(".whl"):
                continue
            try:
                tags = parse_wheel_filename(f["filename"])[3]
            except Exception:  # noqa: BLE001 — odd filename, skip the file
                continue
            if tags & supported:
                return str(v)
    return None


def outdated(entries: list[dict]) -> list[dict]:
    """§19 POST /packages/outdated — read-only PyPI lookups, in parallel.
    Each entry comes back as {pip, import, latest?}; `latest` is present only
    when a version newer than the **installed** one exists (§6.2: the
    installed distribution is the comparison baseline). Not installed or any
    failure → no `latest`."""
    from concurrent.futures import ThreadPoolExecutor

    from packaging.version import Version

    installed = _installed_versions()

    def probe(e: dict) -> dict:
        name = str(e.get("pip") or "").strip()
        out = {"pip": name, "import": str(e.get("import") or "").strip()}
        cur = installed.get(_norm(name)) if PIP_NAME_RE.match(name) else None
        if not cur:
            return out
        try:
            latest = _latest_compatible(name)
            if latest and Version(latest) > Version(cur):
                out["latest"] = latest
        except Exception:  # noqa: BLE001 — network/parse failure: badge stays off
            pass
        return out

    items = list(entries or [])
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=min(8, len(items))) as pool:
        return list(pool.map(probe, items))


def _pip_install(name: str) -> str | None:
    """One pip run into the §6.2 directory; returns an error string or None.
    Caller holds `_pip_lock`."""
    target = site_packages_dir()
    target.mkdir(parents=True, exist_ok=True)
    try:
        # §6.2: wheels only — a source-only package would need a
        # compiler users don't have; fail fast with pip's clear
        # "no matching distribution" instead of a build traceback.
        proc = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--upgrade",
             "--no-input", "--disable-pip-version-check",
             "--only-binary", ":all:",
             "--target", str(target), name],
            capture_output=True, text=True, timeout=INSTALL_TIMEOUT)
    except subprocess.TimeoutExpired:
        return f"pip timed out after {INSTALL_TIMEOUT} s"
    except OSError as e:
        return str(e)
    if proc.returncode == 0:
        return None
    tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
    return " · ".join(ln.strip() for ln in tail) or f"pip exited {proc.returncode}"


def ensure(entries: list[dict], on_progress=None) -> list[dict]:
    """§6.2 ensure — idempotent: check first, pip only for missing
    distributions (newest compatible wheel at that moment), serialized
    process-wide. An installed distribution is never touched — upgrades go
    through `upgrade()` only. Each entry comes back as {pip, import,
    status: installed | failed, version?, error?}. `on_progress(name)` fires
    before each actual pip run."""
    results = check(entries)
    if all(r["status"] == "installed" for r in results):
        return results
    with _pip_lock:
        results = check(entries)  # re-check: another ensure may have run first
        for r in results:
            if r["status"] == "installed":
                continue
            if not PIP_NAME_RE.match(r["pip"]):
                r["status"] = "failed"
                r["error"] = "not a bare distribution name"
                continue
            if on_progress:
                on_progress(r["pip"])
            if err := _pip_install(r["pip"]):
                r["status"] = "failed"
                r["error"] = err
            else:
                r["status"] = "installed"
                r["version"] = _installed_versions().get(_norm(r["pip"]))
    return results


def upgrade(entries: list[dict]) -> list[dict]:
    """§19 POST /packages/update — the §11 Update button: always runs pip
    (`install --upgrade name`), the one path that moves an installed
    distribution forward. Same result shape as `ensure`."""
    results = check(entries)
    with _pip_lock:
        for r in results:
            if err := _pip_install(r["pip"]):
                r["status"] = "failed"
                r["error"] = err
                r.pop("version", None)
            else:
                r["status"] = "installed"
                r["version"] = _installed_versions().get(_norm(r["pip"]))
    return results
