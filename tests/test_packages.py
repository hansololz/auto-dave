"""Declared-package management (§6.2) — no network, no pip runs."""
import io
import json

import pytest


def _fake_dist(home, name="requests", version="2.31.0"):
    """Minimal installed distribution in the §6.2 site-packages dir."""
    d = home / "site-packages" / f"{name}-{version}.dist-info"
    d.mkdir(parents=True)
    (d / "METADATA").write_text(
        f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n", encoding="utf-8")


def test_norm_pep503():
    from autowright.packages import _norm

    assert _norm("requests") == "requests"
    assert _norm("Beautiful.Soup_4") == "beautiful-soup-4"
    assert _norm("A__b..c--d") == "a-b-c-d"
    assert _norm("Typing_Extensions") == "typing-extensions"


def test_pip_name_re():
    from autowright.packages import PIP_NAME_RE

    assert PIP_NAME_RE.match("requests")
    assert PIP_NAME_RE.match("beautifulsoup4")
    assert PIP_NAME_RE.match("typing_extensions")
    assert not PIP_NAME_RE.match("bad name!")
    assert not PIP_NAME_RE.match("")
    assert not PIP_NAME_RE.match("-leading")
    assert not PIP_NAME_RE.match("requests==2.0")  # §6.2: bare names, no specifier


def test_check_missing_then_installed(home):
    from autowright.packages import check

    entries = [{"pip": "requests", "import": "requests"}]
    assert check(entries) == [{"pip": "requests", "import": "requests", "status": "missing"}]

    _fake_dist(home, "requests", "2.31.0")
    assert check(entries) == [{"pip": "requests", "import": "requests",
                               "status": "installed", "version": "2.31.0"}]
    # normalization applies: manifest spelling differs, distribution still found
    assert check([{"pip": "Requests", "import": "requests"}])[0]["status"] == "installed"
    # invalid names never match anything
    assert check([{"pip": "bad name!", "import": "x"}])[0]["status"] == "missing"


def _pypi_payload():
    """Releases crafted so every skip rule fires before the winner (1.2)."""
    return {"releases": {
        "2.0a1": [{"filename": "pkg-2.0a1-py3-none-any.whl"}],           # prerelease
        "1.9.dev1": [{"filename": "pkg-1.9.dev1-py3-none-any.whl"}],     # dev release
        "1.8": [],                                                        # no files
        "1.7": [{"filename": "pkg-1.7-py3-none-any.whl", "yanked": True}],
        "1.6": [{"filename": "pkg-1.6.tar.gz"}],                          # sdist only
        "1.5": [{"filename": "pkg-1.5-cp27-cp27m-manylinux1_x86_64.whl"}],  # bad tags
        "1.2": [{"filename": "pkg-1.2-py3-none-any.whl"}],                # winner
        "not-a-version": [{"filename": "pkg-x-py3-none-any.whl"}],
    }}


def test_latest_compatible_picks_newest_valid_wheel(monkeypatch):
    from autowright.packages import _latest_compatible

    urls = []

    def fake_urlopen(req, timeout=None):
        urls.append(req.full_url)
        return io.BytesIO(json.dumps(_pypi_payload()).encode("utf-8"))

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    assert _latest_compatible("Pkg") == "1.2"
    # lookup goes to the PEP 503-normalized project URL
    assert urls == ["https://pypi.org/pypi/pkg/json"]


def test_latest_compatible_none_when_nothing_ships_a_usable_wheel(monkeypatch):
    from autowright.packages import _latest_compatible

    payload = {"releases": {"1.0": [{"filename": "pkg-1.0.tar.gz"}]}}
    monkeypatch.setattr(
        "urllib.request.urlopen",
        lambda req, timeout=None: io.BytesIO(json.dumps(payload).encode("utf-8")))
    assert _latest_compatible("pkg") is None


def test_fetch_failure_means_no_update_badge(monkeypatch):
    """A fetch exception propagates out of _latest_compatible (its docstring
    says None, but the swallow actually lives in outdated's probe); through the
    §19 outdated endpoint the badge simply stays off."""
    import urllib.error

    from autowright import packages

    def boom(req, timeout=None):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr("urllib.request.urlopen", boom)
    with pytest.raises(urllib.error.URLError):
        packages._latest_compatible("pkg")

    monkeypatch.setattr(packages, "_installed_versions", lambda: {"pkg": "1.0"})
    assert packages.outdated([{"pip": "pkg", "import": "pkg"}]) == [
        {"pip": "pkg", "import": "pkg"}]  # no "latest" key


def test_ensure_fast_path_never_spawns_pip(home, monkeypatch):
    from autowright import packages

    def no_pip(*a, **kw):
        raise AssertionError("ensure must not run pip when everything is installed")

    monkeypatch.setattr(packages.subprocess, "run", no_pip)
    _fake_dist(home, "requests", "2.31.0")
    _fake_dist(home, "pyyaml", "6.0.2")
    out = packages.ensure([{"pip": "requests", "import": "requests"},
                           {"pip": "pyyaml", "import": "yaml"}])
    assert out == [
        {"pip": "requests", "import": "requests", "status": "installed", "version": "2.31.0"},
        {"pip": "pyyaml", "import": "yaml", "status": "installed", "version": "6.0.2"},
    ]
