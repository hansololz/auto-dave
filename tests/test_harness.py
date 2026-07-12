"""Harness adapters (§6/§8): query-only invocation flags + CLI detection."""


class _FakeProc:
    returncode = 0

    def communicate(self, timeout=None):
        return "ok", ""


def _captured_invoke(monkeypatch, agent):
    from autodave import harness

    monkeypatch.setattr(harness, "resolve_bin", lambda name: f"/usr/local/bin/{name}")
    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return _FakeProc()

    monkeypatch.setattr(harness.subprocess, "Popen", fake_popen)
    out = harness.invoke(agent, "question: hi?")
    assert out == "ok"
    return captured["cmd"]


def test_claude_invoked_with_no_tools_flags(monkeypatch):
    cmd = _captured_invoke(monkeypatch, {"harness": "Claude Code"})
    assert cmd[0] == "/usr/local/bin/claude" and "-p" in cmd
    i = cmd.index("--tools")
    assert cmd[i + 1] == ""  # all built-in tools disabled
    assert "--strict-mcp-config" in cmd
    assert "--no-session-persistence" in cmd
    assert cmd[-1] == "question: hi?"


def test_codex_invoked_with_read_only_sandbox(monkeypatch):
    cmd = _captured_invoke(monkeypatch, {"harness": "Codex"})
    assert cmd[:2] == ["/usr/local/bin/codex", "exec"]
    i = cmd.index("--sandbox")
    assert cmd[i + 1] == "read-only"
    assert "--skip-git-repo-check" in cmd
    assert cmd[-1] == "question: hi?"


def test_detect_finds_gemini_and_opencode(monkeypatch):
    from autodave import harness

    present = {"gemini", "opencode"}
    monkeypatch.setattr(harness, "resolve_bin",
                        lambda name: f"/usr/local/bin/{name}" if name in present else None)

    class _R:
        returncode = 0
        stdout = "9.9.9\n"
        stderr = ""

    monkeypatch.setattr(harness.subprocess, "run", lambda *a, **kw: _R())
    monkeypatch.setattr(harness, "ollama_status", lambda: {"ready": False, "models": []})
    found = harness.detect()
    by_id = {f["id"]: f for f in found}
    assert by_id["gemini"]["name"] == "Gemini CLI" and "9.9.9" in by_id["gemini"]["detail"]
    assert by_id["opencode"]["name"] == "OpenCode" and "9.9.9" in by_id["opencode"]["detail"]
    assert "claude" not in by_id and "codex" not in by_id


def test_detect_finds_fake_claude_from_path(monkeypatch):
    """conftest prepends tests/bin, so the real detection path finds the fake CLI."""
    from autodave import harness

    monkeypatch.setattr(harness, "ollama_status",
                        lambda: {"ready": False, "installed": False, "models": []})
    found = harness.detect()
    by_id = {f["id"]: f for f in found}
    assert "claude" in by_id
    assert "auto-dave test fake" in by_id["claude"]["detail"]


def test_disallowed_imports_matches_drafting_rule():
    from autodave.imports_check import ALLOWED_IMPORTS, disallowed_imports

    code = ("import django\n"
            "import requests\n"
            "from bs4 import BeautifulSoup\n"
            "from dateutil.parser import parse\n"
            "from . import sibling\n"           # relative → ignored
            "import numpy.linalg\n")
    assert disallowed_imports(code) == ["django", "numpy"]
    assert disallowed_imports("x = 1 +\n") == []  # syntax error surfaces at exec
    # rule identical to §8 draft validation — drafting uses the shared module directly
    from autodave import drafting

    assert drafting.disallowed_imports is disallowed_imports
    assert "requests" in ALLOWED_IMPORTS
