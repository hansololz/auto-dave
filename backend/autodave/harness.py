"""Agent harness adapters (§8): send one prompt, receive one text response.

Every adapter is one-shot and non-interactive.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import threading
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
OLLAMA_DEFAULT_MODEL = "qwen3:8b"


class HarnessError(Exception):
    pass


# A backend launched from the Finder/Dock gets a minimal PATH without
# /opt/homebrew/bin or ~/.local/bin, so `shutil.which` alone misses
# normally-installed CLIs (claude installs to ~/.local/bin by default).
_FALLBACK_BIN_DIRS = (
    os.path.expanduser("~/.local/bin"),
    os.path.expanduser("~/.opencode/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
)


def _neutral_cwd() -> str:
    """§6: every harness child runs in this empty dir so CLI startup scans
    never touch TCC-protected folders (no macOS permission prompts)."""
    d = paths.harness_cwd()
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


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
           proc_holder: dict | None = None, on_chunk=None) -> str:
    """Invoke the harness once with `prompt`, return its text reply.

    proc_holder, when given, receives {'proc': Popen} so a caller can cancel.
    on_chunk, when given, receives each partial-text chunk as the harness
    streams its response (§8 live progress); chunks joined ≙ the reply.
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
        out = _invoke(harness, agent, prompt, timeout, proc_holder, on_chunk)
    except Exception as e:  # noqa: BLE001 — log, close the frame, re-raise
        _app_log(f"request failed: {e}\n>>>>> END {_stamp()} {req_id} <<<<<\n")
        raise
    _app_log(f"response ({len(out)} chars):\n{out}\n>>>>> END {_stamp()} {req_id} <<<<<\n")
    return out


def _claude_stream_line(line: str) -> tuple[str | None, str | None]:
    """One `--output-format stream-json` stdout line → (text_chunk, final_result).

    Partial text arrives as stream_event/content_block_delta/text_delta chunks
    (`--include-partial-messages`); the terminal `result` event carries the
    complete reply. Anything else — init events, tool noise, non-JSON — is None.
    """
    try:
        obj = json.loads(line)
    except ValueError:
        return None, None
    if not isinstance(obj, dict):
        return None, None
    if obj.get("type") == "stream_event":
        ev = obj.get("event") or {}
        delta = ev.get("delta") or {}
        if ev.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
            return delta.get("text") or "", None
        return None, None
    if obj.get("type") == "result" and isinstance(obj.get("result"), str):
        return None, obj["result"]
    return None, None


def _invoke(harness: str | None, agent: dict, prompt: str, timeout: int,
            proc_holder: dict | None, on_chunk=None) -> str:
    if harness == "Ollama":
        return _ollama(agent.get("model") or OLLAMA_DEFAULT_MODEL, prompt, timeout, on_chunk)
    # §6: query-only runtime calls — invoke each harness with the strongest
    # flags it offers to disable tools/shell/file access beyond the model API.
    cmd_map = {
        # --tools "" disables every built-in tool; --strict-mcp-config with no
        # --mcp-config loads zero MCP servers; --no-session-persistence keeps
        # the one-shot call off disk. stream-json + --include-partial-messages
        # streams text deltas for §8 live progress (stream-json in print mode
        # requires --verbose). (Flags verified against claude --help.)
        "Claude Code": ["claude", "-p", "--tools", "", "--strict-mcp-config",
                        "--no-session-persistence", "--output-format", "stream-json",
                        "--include-partial-messages", "--verbose", prompt],
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
                            stdin=subprocess.DEVNULL, text=True, errors="replace",
                            cwd=_neutral_cwd())
    if proc_holder is not None:
        proc_holder["proc"] = proc
    # §8 live progress: read stdout as it streams instead of communicate();
    # the timeout is enforced by a timer that kills the child (readline then
    # sees EOF), and stderr drains on its own thread so a chatty child can't
    # deadlock on a full pipe.
    timed_out = threading.Event()

    def _kill() -> None:
        timed_out.set()
        proc.kill()

    timer = threading.Timer(timeout, _kill)
    timer.start()
    err_parts: list[str] = []
    drain = threading.Thread(target=lambda: err_parts.append(proc.stderr.read() or ""),
                             daemon=True)
    drain.start()
    raw_parts: list[str] = []
    deltas: list[str] = []
    final: str | None = None
    try:
        for line in proc.stdout:
            raw_parts.append(line)
            if harness == "Claude Code":
                chunk, result = _claude_stream_line(line)
                if result is not None:
                    final = result
                if chunk:
                    deltas.append(chunk)
                    if on_chunk:
                        on_chunk(chunk)
            elif on_chunk:
                on_chunk(line)
        proc.wait()
    finally:
        timer.cancel()
    drain.join(timeout=5)
    if timed_out.is_set() and proc.returncode != 0:
        # returncode guard: a timer firing in the instant after a successful
        # exit must not discard a complete valid reply.
        raise HarnessError(f"{harness} timed out after {timeout}s")
    raw = "".join(raw_parts)
    if proc.returncode != 0:
        err = (err_parts[0] if err_parts else "") or raw
        raise HarnessError(f"{harness} failed: {err.strip()[:400]}")
    if harness == "Claude Code":
        # The result event is authoritative; joined deltas cover a CLI that
        # streamed but never sent one; raw stdout covers non-stream output.
        return final if final is not None else ("".join(deltas) or raw)
    return raw


def _ollama(model: str, prompt: str, timeout: int, on_chunk=None) -> str:
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps({"model": model, "prompt": prompt, "stream": True}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            parts: list[str] = []
            for line in r:  # §8 live progress: one JSON object per line
                obj = json.loads(line.decode())
                piece = obj.get("response", "")
                if piece:
                    parts.append(piece)
                    if on_chunk:
                        on_chunk(piece)
                if obj.get("done"):
                    break
            return "".join(parts)
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
                             stderr=subprocess.DEVNULL, start_new_session=True,
                             cwd=_neutral_cwd())
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


def ollama_model_installed(model: str, installed: list[str]) -> bool:
    """A bare name without a tag matches its `:latest` variant."""
    if model in installed:
        return True
    return ":" not in model and f"{model}:latest" in installed


# Provider ids (§19 install/login/signin endpoints, §10 cards) ↔ harness names.
PROVIDERS: tuple[tuple[str, str], ...] = (
    ("claude", "Claude Code"),
    ("ollama", "Ollama"),
    ("codex", "Codex"),
    ("gemini", "Gemini CLI"),
    ("opencode", "OpenCode"),
)
PROVIDER_NAME = dict(PROVIDERS)
PROVIDER_BIN = {"claude": "claude", "codex": "codex", "gemini": "gemini",
                "opencode": "opencode", "ollama": "ollama"}
HARNESS_ID = {name: pid for pid, name in PROVIDERS}


def _status_ok(cmd: list[str]) -> bool:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10,
                           cwd=_neutral_cwd())
        return r.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def signed_in(provider_id: str) -> bool | None:
    """§19 per-harness sign-in rule. None means the provider needs no account
    (Ollama); False for an account-backed provider that isn't installed."""
    if provider_id == "ollama":
        return None
    if provider_id == "claude":
        binpath = resolve_bin("claude")
        return bool(binpath) and _status_ok([binpath, "auth", "status"])
    if provider_id == "codex":
        binpath = resolve_bin("codex")
        return bool(binpath) and _status_ok([binpath, "login", "status"])
    if provider_id == "gemini":
        return (os.path.exists(os.path.expanduser("~/.gemini/oauth_creds.json"))
                or bool(os.environ.get("GEMINI_API_KEY")))
    if provider_id == "opencode":
        try:
            with open(os.path.expanduser("~/.local/share/opencode/auth.json"),
                      encoding="utf-8") as f:
                creds = json.load(f)
            return isinstance(creds, dict) and len(creds) > 0
        except (OSError, ValueError):
            return False
    return False


def signin_state(provider_id: str) -> dict:
    """§19 `GET /agents/signin/{id}` — cheap poll, no version lookups."""
    if provider_id == "ollama":
        st = ollama_status()
        return {"installed": st["installed"], "signedIn": None}
    binpath = resolve_bin(PROVIDER_BIN[provider_id])
    return {"installed": binpath is not None, "signedIn": signed_in(provider_id)}


def check_ready(harness_name: str, model: str | None = None) -> bool:
    """The single readiness check behind §19 `/agents/{id}/check` and
    `/agents/check-harness`.

    Ready means the harness can take a prompt right now: the binary resolves
    (Ollama: the server answers and the agent's model is installed — no
    sign-in, Ollama needs no account), and every account-backed harness is
    additionally signed in by the §19 per-harness rule.
    """
    if harness_name == "Ollama":
        st = ollama_status()
        return st["ready"] and ollama_model_installed(
            model or OLLAMA_DEFAULT_MODEL, st["models"])
    pid = HARNESS_ID.get(harness_name)
    if not pid:
        return False
    if resolve_bin(PROVIDER_BIN[pid]) is None:
        return False
    return signed_in(pid) is True


def detect() -> list[dict]:
    """§10 step 2 — one entry per provider, all five always present, with real
    installed and sign-in state (§19)."""
    def version_of(binpath: str) -> str | None:
        try:
            r = subprocess.run([binpath, "--version"], capture_output=True, text=True,
                               timeout=5, cwd=_neutral_cwd())
            return (r.stdout or r.stderr).strip().splitlines()[0][:40] if r.returncode == 0 else None
        except Exception:  # noqa: BLE001
            return None

    out = []
    for pid, name in PROVIDERS:
        if pid == "ollama":
            st = ollama_status()
            installed = bool(st["ready"] or st.get("installed"))
            detail = ("serving locally on this Mac" if st["ready"]
                      else "installed · not serving" if installed else "")
            out.append({"id": pid, "name": name, "installed": installed,
                        "signedIn": None, "detail": detail})
            continue
        binpath = resolve_bin(PROVIDER_BIN[pid])
        if not binpath:
            out.append({"id": pid, "name": name, "installed": False,
                        "signedIn": False, "detail": ""})
            continue
        s = signed_in(pid) is True
        v = version_of(binpath)
        detail = f"{v or 'installed'} · {'signed in' if s else 'not signed in yet'}"
        out.append({"id": pid, "name": name, "installed": True,
                    "signedIn": s, "detail": detail})
    return out
