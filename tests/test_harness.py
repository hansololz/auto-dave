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
    from autowright import harness

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
    from autowright import harness

    chunks = []
    out = harness.invoke({"harness": "Claude Code"}, "question: hi?",
                         on_chunk=chunks.append)
    assert out == "Mock answer: nothing new."
    assert chunks and "".join(chunks) == out


def test_opencode_local_model_invoked_with_ollama_model_flag(monkeypatch):
    # §4.7: a local-model agent rides in as `--model ollama/<model>` after the
    # §19 opencode.json provider sync.
    from autowright import harness

    synced = []
    monkeypatch.setattr(harness, "sync_opencode_ollama", synced.append)
    cmd = _captured_invoke(monkeypatch, {"harness": "OpenCode", "mode": "ollama",
                                         "model": "qwen3:8b"})
    assert cmd[:2] == ["/usr/local/bin/opencode", "run"]
    i = cmd.index("--model")
    assert cmd[i + 1] == "ollama/qwen3:8b"
    assert cmd[-1] == "question: hi?"
    assert synced == ["qwen3:8b"]

    cmd = _captured_invoke(monkeypatch, {"harness": "OpenCode"})
    assert "--model" not in cmd  # default mode: no model is ever passed
    assert synced == ["qwen3:8b"]  # and no sync either


def test_custom_model_invoked_with_verbatim_model_flag(monkeypatch):
    # §4.7: a custom-model agent passes the user-typed string verbatim as
    # `--model` on every harness — no ollama/ prefix, no opencode.json sync.
    from autowright import harness

    synced = []
    monkeypatch.setattr(harness, "sync_opencode_ollama", synced.append)
    for name, model in (("Claude Code", "claude-opus-4-8"),
                        ("Gemini CLI", "gemini-2.5-pro"),
                        ("Codex", "gpt-5-codex"),
                        ("OpenCode", "anthropic/claude-opus-4-8")):
        cmd = _captured_invoke(monkeypatch, {"harness": name, "mode": "custom",
                                             "model": model})
        i = cmd.index("--model")
        assert cmd[i + 1] == model
        assert cmd[-1] == "question: hi?"
    assert synced == []


def test_sync_opencode_ollama_merges_config(monkeypatch, tmp_path):
    import json

    from autowright import harness

    cfg = tmp_path / "opencode.json"
    cfg.write_text(json.dumps({"theme": "dark", "provider": {"anthropic": {}}}))
    monkeypatch.setattr(harness, "_OPENCODE_CONFIG", str(cfg))
    harness.sync_opencode_ollama("qwen3:8b")
    out = json.loads(cfg.read_text())
    assert out["theme"] == "dark"                    # untouched keys survive
    assert "anthropic" in out["provider"]
    entry = out["provider"]["ollama"]
    assert entry["npm"] == "@ai-sdk/openai-compatible"
    assert entry["options"]["baseURL"].endswith("/v1")
    assert "qwen3:8b" in entry["models"]
    # idempotent: a second sync writes nothing new
    before = cfg.read_text()
    harness.sync_opencode_ollama("qwen3:8b")
    assert cfg.read_text() == before


def test_codex_invoked_with_read_only_sandbox(monkeypatch):
    cmd = _captured_invoke(monkeypatch, {"harness": "Codex"})
    assert cmd[:2] == ["/usr/local/bin/codex", "exec"]
    i = cmd.index("--sandbox")
    assert cmd[i + 1] == "read-only"
    assert "--skip-git-repo-check" in cmd
    assert cmd[-1] == "question: hi?"


def test_detect_reports_all_four_with_sign_in_state(monkeypatch):
    from autowright import harness

    present = {"gemini", "opencode"}
    monkeypatch.setattr(harness, "resolve_bin",
                        lambda name: f"/usr/local/bin/{name}" if name in present else None)

    class _R:
        returncode = 0
        stdout = "9.9.9\n"
        stderr = ""

    monkeypatch.setattr(harness.subprocess, "run", lambda *a, **kw: _R())
    monkeypatch.setattr(harness, "signed_in", lambda pid: pid == "gemini")
    by_id = {f["id"]: f for f in harness.detect()}
    # §19: one entry per harness, all four always present — Ollama is not a
    # harness and never appears in detection
    assert set(by_id) == {"claude", "codex", "gemini", "opencode"}
    assert by_id["gemini"]["installed"] and by_id["gemini"]["signedIn"] is True
    assert "9.9.9" in by_id["gemini"]["detail"] and "signed in" in by_id["gemini"]["detail"]
    assert by_id["opencode"]["installed"] and by_id["opencode"]["signedIn"] is False
    assert "not signed in yet" in by_id["opencode"]["detail"]
    assert not by_id["claude"]["installed"] and by_id["claude"]["detail"] == ""


def test_detect_finds_fake_claude_from_path(monkeypatch):
    """conftest prepends tests/bin, so the real detection path finds the fake CLI."""
    from autowright import harness

    found = harness.detect()
    by_id = {f["id"]: f for f in found}
    assert by_id["claude"]["installed"]
    assert "autowright test fake" in by_id["claude"]["detail"]


def test_check_ready_requires_sign_in(monkeypatch):
    """§19: every account-backed harness must be signed in to be ready."""
    from autowright import harness

    monkeypatch.setattr(harness, "resolve_bin", lambda name: f"/usr/local/bin/{name}")
    monkeypatch.setattr(harness, "signed_in", lambda pid: False)
    for name in ("Claude Code", "Codex", "Gemini CLI", "OpenCode"):
        assert not harness.check_ready(name)
    monkeypatch.setattr(harness, "signed_in", lambda pid: True)
    for name in ("Claude Code", "Codex", "Gemini CLI", "OpenCode"):
        assert harness.check_ready(name)
    monkeypatch.setattr(harness, "resolve_bin", lambda name: None)
    assert not harness.check_ready("Codex")  # not installed → never ready


def test_signin_state_is_cheap_per_provider(monkeypatch):
    from autowright import harness

    monkeypatch.setattr(harness, "resolve_bin", lambda name: "/usr/local/bin/x")
    monkeypatch.setattr(harness, "signed_in", lambda pid: pid == "codex")
    assert harness.signin_state("codex") == {"installed": True, "signedIn": True}
    assert harness.signin_state("gemini") == {"installed": True, "signedIn": False}
    monkeypatch.setattr(harness, "ollama_status",
                        lambda: {"ready": False, "installed": False, "models": []})
    assert harness.signin_state("ollama") == {"installed": False, "signedIn": None}


def test_check_ready_local_model_requires_installed_model(monkeypatch):
    """§4.7: a local-model agent is OpenCode + Ollama server + the model —
    no sign-in needed."""
    from autowright import harness

    monkeypatch.setattr(harness, "resolve_bin", lambda name: f"/usr/local/bin/{name}")
    monkeypatch.setattr(harness, "signed_in", lambda pid: False)
    monkeypatch.setattr(harness, "sync_opencode_ollama", lambda model: None)
    monkeypatch.setattr(harness, "ollama_status",
                        lambda: {"ready": True, "installed": True,
                                 "models": ["qwen3:8b", "llama3.2:latest"]})
    assert harness.check_ready("OpenCode", "qwen3:8b", "ollama")  # signed out is fine
    assert harness.check_ready("OpenCode", "llama3.2", "ollama")  # bare name → :latest
    assert not harness.check_ready("OpenCode", "mistral:7b", "ollama")
    assert not harness.check_ready("Claude Code", "qwen3:8b", "ollama")  # OpenCode only
    # §4.7 custom mode: model string never validated — sign-in decides, and a
    # signed-out harness is not ready
    assert not harness.check_ready("Claude Code", "made-up-model", "custom")
    monkeypatch.setattr(harness, "signed_in", lambda pid: True)
    assert harness.check_ready("Claude Code", "made-up-model", "custom")
    monkeypatch.setattr(harness, "signed_in", lambda pid: False)

    monkeypatch.setattr(harness, "ollama_status",
                        lambda: {"ready": False, "installed": True, "models": []})
    assert not harness.check_ready("OpenCode", "qwen3:8b", "ollama")

    monkeypatch.setattr(harness, "resolve_bin", lambda name: None)
    assert not harness.check_ready("OpenCode", "qwen3:8b")  # no binary → never ready


def test_disallowed_imports_matches_drafting_rule():
    from autowright.imports_check import ALLOWED_IMPORTS, disallowed_imports

    code = ("import django\n"
            "import requests\n"
            "from bs4 import BeautifulSoup\n"
            "from dateutil.parser import parse\n"
            "from . import sibling\n"           # relative → ignored
            "import numpy.linalg\n")
    assert disallowed_imports(code) == ["django", "numpy"]
    assert disallowed_imports("x = 1 +\n") == []  # syntax error surfaces at exec
    # rule identical to §8 draft validation — drafting uses the shared module directly
    from autowright import drafting

    assert drafting.disallowed_imports is disallowed_imports
    assert "requests" in ALLOWED_IMPORTS


def test_sync_opencode_ollama_sidesteps_corrupt_config(monkeypatch, tmp_path):
    # §19: corrupt (half-written) opencode.json is preserved as .corrupt and a
    # fresh valid config written — the user's bytes are never silently replaced.
    import json

    from autowright import harness

    cfg = tmp_path / "opencode.json"
    corrupt = '{"theme": "dark", "provider": {'  # truncated mid-write
    cfg.write_text(corrupt)
    monkeypatch.setattr(harness, "_OPENCODE_CONFIG", str(cfg))
    harness.sync_opencode_ollama("qwen3:8b")

    assert (tmp_path / "opencode.json.corrupt").read_text() == corrupt
    out = json.loads(cfg.read_text())  # fresh file parses
    assert "theme" not in out  # started clean, not from the corrupt bytes
    entry = out["provider"]["ollama"]
    assert entry["npm"] == "@ai-sdk/openai-compatible"
    assert "qwen3:8b" in entry["models"]


def test_spawn_env_path_prepend_dedupe_order(monkeypatch):
    # §19 GUI minimal PATH fix. Fallback dirs go in FRONT of the existing PATH
    # (not appended), duplicates collapse to their first occurrence, and the
    # surviving original entries keep their relative order.
    from autowright import harness

    monkeypatch.setattr(harness, "_FALLBACK_BIN_DIRS", ("/fb1", "/b"))
    monkeypatch.setenv("PATH", "/a:/b:/c")
    env = harness.spawn_env()
    assert env["PATH"] == "/fb1:/b:/a:/c"  # /b deduped; /a before /c preserved
    assert env["PATH"].split(":")[-2:] == ["/a", "/c"]


def test_spawn_env_idempotent_and_binpath_dir_first(monkeypatch):
    from autowright import harness

    monkeypatch.setattr(harness, "_FALLBACK_BIN_DIRS", ("/fb1", "/b"))
    monkeypatch.setenv("PATH", "/a:/b:/c")
    once = harness.spawn_env()["PATH"]
    monkeypatch.setenv("PATH", once)
    assert harness.spawn_env()["PATH"] == once  # already-present dirs: no change

    monkeypatch.setenv("PATH", "/a")
    env = harness.spawn_env("/opt/x/claude")
    assert env["PATH"] == "/opt/x:/fb1:/b:/a"  # binary's own dir leads
