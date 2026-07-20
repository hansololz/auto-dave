"""Harness adapters (§6/§8): query-only invocation flags + CLI detection."""
import io


class _FakeProc:
    """Streamed-read stand-in (§8): invoke() iterates stdout, drains stderr on
    a thread, then wait()s — no communicate()."""
    returncode = 0

    def __init__(self):
        self.stdout = io.StringIO("ok")
        self.stderr = io.StringIO("")

    def wait(self, timeout=None):
        return 0

    def poll(self):
        return 0

    def kill(self):
        pass


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
    # §8 live progress: partial text streams as stream-json deltas
    j = cmd.index("--output-format")
    assert cmd[j + 1] == "stream-json"
    assert "--include-partial-messages" in cmd
    assert "--verbose" in cmd  # stream-json in print mode requires it
    assert cmd[-1] == "question: hi?"


def test_fake_cli_streams_chunks_and_result():
    # §8 live progress: the fake CLI answers stream-json — on_chunk sees each
    # text delta and the returned text comes from the terminal result event.
    from autodave import harness

    chunks = []
    out = harness.invoke({"harness": "Claude Code"}, "question: hi?",
                         on_chunk=chunks.append)
    assert out == "Mock answer: nothing new."
    assert chunks and "".join(chunks) == out


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


def test_check_ready_ollama_requires_installed_model(monkeypatch):
    from autodave import harness

    monkeypatch.setattr(harness, "ollama_status",
                        lambda: {"ready": True, "installed": True,
                                 "models": ["qwen3:8b", "llama3.2:latest"]})
    assert harness.check_ready("Ollama", "qwen3:8b")
    assert harness.check_ready("Ollama", "llama3.2")  # bare name → :latest
    assert not harness.check_ready("Ollama", "mistral:7b")
    assert harness.check_ready("Ollama", None)  # null model → qwen3:8b fallback

    monkeypatch.setattr(harness, "ollama_status",
                        lambda: {"ready": False, "installed": True, "models": []})
    assert not harness.check_ready("Ollama", "qwen3:8b")


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
