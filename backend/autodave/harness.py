"""Agent harness adapters (§8): send one prompt, receive one text response.

Every adapter is one-shot and non-interactive.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
import urllib.request
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

# Top-level import (not lazy): the executor subprocess replaces
# sys.modules["autodave"] with the step SDK shim, which breaks late
# `from . import paths` resolution inside _app_log.
from . import paths

log = logging.getLogger("autodave.harness")


def _stamp() -> str:
    return datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d %H:%M:%S %Z")


def _app_log(text: str) -> None:
    try:
        with open(paths.app_log(), "a", encoding="utf-8") as f:
            f.write(text[:100_000] + "\n")
    except OSError:
        pass

OLLAMA_URL = os.environ.get("AUTODAVE_OLLAMA_URL", "http://localhost:11434")


class HarnessError(Exception):
    pass


# A backend launched from the Finder/Dock gets a minimal PATH without
# /opt/homebrew/bin or ~/.local/bin, so `shutil.which` alone misses
# normally-installed CLIs (claude installs to ~/.local/bin by default).
_FALLBACK_BIN_DIRS = (
    os.path.expanduser("~/.local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
)


def resolve_bin(binname: str) -> str | None:
    """Absolute path of `binname`, searching PATH then common install dirs."""
    found = shutil.which(binname)
    if found:
        return found
    for d in _FALLBACK_BIN_DIRS:
        path = os.path.join(d, binname)
        if os.access(path, os.X_OK):
            return path
    return None


def invoke(agent: dict, prompt: str, timeout: int = 300,
           proc_holder: dict | None = None) -> str:
    """Invoke the harness once with `prompt`, return its text reply.

    proc_holder, when given, receives {'proc': Popen} so a caller can cancel.
    Every request is framed in app.log (§5): BEGIN header + prompt on send,
    response (or error) + END footer when the request ends.
    """
    harness = agent.get("harness")
    model = agent.get("model") or "configured default"
    log.info("agent request · harness=%s · model=%s · prompt (%d chars):\n%s",
             harness or "?", model, len(prompt), prompt)
    req_id = str(uuid.uuid4())
    _app_log(f">>>>> BEGIN {_stamp()} {req_id} <<<<<\n"
             f"agent request · harness={harness or '?'} · model={model}"
             f" · prompt ({len(prompt)} chars):\n{prompt}")
    try:
        out = _invoke(harness, agent, prompt, timeout, proc_holder)
    except Exception as e:  # noqa: BLE001 — log, close the frame, re-raise
        _app_log(f"request failed: {e}\n>>>>> END {_stamp()} {req_id} <<<<<\n")
        raise
    _app_log(f"response ({len(out)} chars):\n{out}\n>>>>> END {_stamp()} {req_id} <<<<<\n")
    return out


def _invoke(harness: str | None, agent: dict, prompt: str, timeout: int,
            proc_holder: dict | None) -> str:
    if harness == "Ollama":
        return _ollama(agent.get("model") or "qwen3:8b", prompt, timeout)
    # §6: query-only runtime calls — invoke each harness with the strongest
    # flags it offers to disable tools/shell/file access beyond the model API.
    cmd_map = {
        # --tools "" disables every built-in tool; --strict-mcp-config with no
        # --mcp-config loads zero MCP servers; --no-session-persistence keeps
        # the one-shot call off disk. (Flags verified against claude --help.)
        "Claude Code": ["claude", "-p", "--tools", "", "--strict-mcp-config",
                        "--no-session-persistence", prompt],
        # Gemini CLI has no documented flag that disables its built-in tools
        # for a one-shot -p call (only sandbox/approval modes) — left bare.
        "Gemini CLI": ["gemini", "-p", prompt],
        # Codex: read-only sandbox blocks writes/shell side effects;
        # --skip-git-repo-check lets exec work outside a git repo (workspace).
        "Codex": ["codex", "exec", "--sandbox", "read-only",
                  "--skip-git-repo-check", prompt],
        # OpenCode has no documented flag that disables tool use for
        # `opencode run` — left bare.
        "OpenCode": ["opencode", "run", prompt],
    }
    cmd = cmd_map.get(harness)
    if not cmd:
        raise HarnessError(f"unknown harness: {harness}")
    binpath = resolve_bin(cmd[0])
    if binpath is None:
        raise HarnessError(f"{cmd[0]} is not installed on this Mac")
    cmd[0] = binpath
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            stdin=subprocess.DEVNULL, text=True)
    if proc_holder is not None:
        proc_holder["proc"] = proc
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise HarnessError(f"{harness} timed out after {timeout}s")
    if proc.returncode != 0:
        raise HarnessError(f"{harness} failed: {(err or out or '').strip()[:400]}")
    return out


def _ollama(model: str, prompt: str, timeout: int) -> str:
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps({"model": model, "prompt": prompt, "stream": False}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode()).get("response", "")
    except Exception as e:  # noqa: BLE001
        raise HarnessError(f"Ollama request failed: {e}") from e


_OLLAMA_APP_BIN = "/Applications/Ollama.app/Contents/Resources/ollama"


def ollama_bin() -> str | None:
    found = resolve_bin("ollama")
    if found:
        return found
    if os.access(_OLLAMA_APP_BIN, os.X_OK):
        return _OLLAMA_APP_BIN
    return None


def _ollama_models() -> list[str] | None:
    """Model names if the server answers, else None."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=2) as r:
            tags = json.loads(r.read().decode())
        return [m["name"] for m in tags.get("models", [])]
    except Exception:  # noqa: BLE001
        return None


_serve_spawned = False


def ollama_status() -> dict:
    global _serve_spawned
    models = _ollama_models()
    binpath = ollama_bin()
    local = "localhost" in OLLAMA_URL or "127.0.0.1" in OLLAMA_URL
    if models is None and binpath and local and not _serve_spawned:
        # Installed but the server isn't up — start it once and wait for it.
        _serve_spawned = True
        try:
            subprocess.Popen([binpath, "serve"], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        except Exception:  # noqa: BLE001
            pass
        else:
            for _ in range(10):
                time.sleep(0.3)
                models = _ollama_models()
                if models is not None:
                    break
    return {"ready": models is not None,
            "installed": models is not None or binpath is not None,
            "models": models or []}


def check_ready(harness_name: str) -> bool:
    """The single readiness check behind §19 `/agents/{id}/check`.

    Ready means the harness can take a prompt right now: the binary resolves
    (Ollama: the server answers), and Claude Code is additionally signed in —
    `claude auth status` exits 0 only when authenticated.
    """
    if harness_name == "Ollama":
        return ollama_status()["ready"]
    binname = {"Claude Code": "claude", "Gemini CLI": "gemini",
               "Codex": "codex", "OpenCode": "opencode"}.get(harness_name)
    if not binname:
        return False
    binpath = resolve_bin(binname)
    if not binpath:
        return False
    if harness_name == "Claude Code":
        try:
            r = subprocess.run([binpath, "auth", "status"], capture_output=True,
                               text=True, timeout=10)
            return r.returncode == 0
        except Exception:  # noqa: BLE001
            return False
    return True


def detect() -> list[dict]:
    """§10 step 2 — AIs already on this Mac."""
    found = []

    def version_of(binpath: str) -> str | None:
        try:
            r = subprocess.run([binpath, "--version"], capture_output=True, text=True, timeout=5)
            return (r.stdout or r.stderr).strip().splitlines()[0][:40] if r.returncode == 0 else None
        except Exception:  # noqa: BLE001
            return None

    claude = resolve_bin("claude")
    if claude:
        v = version_of(claude)
        found.append({"id": "claude", "name": "Claude Code",
                      "detail": f"{v or 'installed'} · signed in with your Claude account"})
    st = ollama_status()
    if st["ready"] or st.get("installed"):
        found.append({"id": "ollama", "name": "Ollama",
                      "detail": "serving locally on this Mac" if st["ready"] else "installed · not serving"})
    codex = resolve_bin("codex")
    if codex:
        v = version_of(codex)
        found.append({"id": "codex", "name": "Codex",
                      "detail": f"{v or 'installed'} · signed in with your OpenAI account"})
    gemini = resolve_bin("gemini")
    if gemini:
        v = version_of(gemini)
        found.append({"id": "gemini", "name": "Gemini CLI",
                      "detail": f"{v or 'installed'} · signed in with your Google account"})
    opencode = resolve_bin("opencode")
    if opencode:
        v = version_of(opencode)
        found.append({"id": "opencode", "name": "OpenCode",
                      "detail": f"{v or 'installed'} · signed in on this Mac"})
    return found
