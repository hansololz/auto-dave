"""Real harness installers and sign-in help (§19).

Official vendor channels only, into user-writable locations (`~/.local/bin`)
— no sudo, never Homebrew. One background install per provider at a time;
progress streams through a publish callback (the API layer forwards it as
`harness.install` WS events) and the latest snapshot is kept for
`GET /agents/install/{id}` so a remounted UI can reattach.
"""
from __future__ import annotations

import os
import platform
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request

from . import harness

LOCAL_BIN = os.path.expanduser("~/.local/bin")

CLAUDE_INSTALLER = "https://claude.ai/install.sh"
OPENCODE_INSTALLER = "https://opencode.ai/install"
CODEX_URL = ("https://github.com/openai/codex/releases/latest/download/"
             "codex-{arch}-apple-darwin.tar.gz")
OLLAMA_URL = ("https://github.com/ollama/ollama/releases/latest/download/"
              "ollama-darwin.tgz")

_lock = threading.Lock()
_jobs: dict[str, dict] = {}  # provider id → §19 install snapshot


def status(provider_id: str) -> dict:
    with _lock:
        snap = _jobs.get(provider_id)
        return dict(snap) if snap else {"state": "idle"}


def start(provider_id: str, publish) -> bool:
    """Kick off a background install. False if one is already running."""
    with _lock:
        if _jobs.get(provider_id, {}).get("state") == "running":
            return False
        _jobs[provider_id] = {"state": "running", "line": "", "pct": None}

    def emit(line: str | None = None, pct: int | None = None) -> None:
        with _lock:
            snap = _jobs[provider_id]
            if line is not None:
                snap["line"] = line
            if pct is not None:
                snap["pct"] = pct
        publish(line=line, pct=pct, done=False)

    def run() -> None:
        try:
            _INSTALLERS[provider_id](emit)
        except Exception as e:  # noqa: BLE001 — becomes the §10 failure card
            msg = (str(e).strip().splitlines() or ["install failed"])[0][:300]
            with _lock:
                _jobs[provider_id] = {"state": "failed", "error": msg}
            publish(done=True, ok=False, error=msg)
            return
        with _lock:
            _jobs[provider_id] = {"state": "done"}
        publish(done=True, ok=True)

    threading.Thread(target=run, daemon=True).start()
    return True


def login(provider_id: str) -> str:
    """Start sign-in help; returns the §19 method (`browser` | `terminal`).

    Codex's `login` completes on its own OAuth browser callback, so it runs
    detached. The other CLIs sign in through interactive TUIs — those open in
    Terminal.app, and the UI polls `GET /agents/signin/{id}` until done.
    """
    binpath = harness.resolve_bin(harness.PROVIDER_BIN[provider_id])
    if binpath is None:
        raise RuntimeError(f"{harness.PROVIDER_NAME[provider_id]} isn't installed on this Mac")
    if provider_id == "codex":
        subprocess.Popen([binpath, "login"], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                         start_new_session=True, cwd=harness._neutral_cwd())
        return "browser"
    args = {"claude": ["/login"], "gemini": [], "opencode": ["auth", "login"]}[provider_id]
    cmd = " ".join(shlex.quote(p) for p in [binpath, *args])
    osa = cmd.replace("\\", "\\\\").replace('"', '\\"')
    subprocess.run(["osascript", "-e", 'tell application "Terminal" to activate',
                    "-e", f'tell application "Terminal" to do script "{osa}"'],
                   capture_output=True, timeout=10, check=False)
    return "terminal"


# ---------- mechanics ----------

def _stream_shell(cmd: list[str], emit, env_extra: dict | None = None) -> None:
    """Run an installer child, forwarding each output line; raise on failure
    with the last decisive line as the message."""
    env = dict(os.environ)
    env.setdefault("HOME", os.path.expanduser("~"))
    if env_extra:
        env.update(env_extra)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, text=True, errors="replace",
                            env=env, cwd=harness._neutral_cwd())
    tail: list[str] = []
    for raw in proc.stdout:  # type: ignore[union-attr]
        line = raw.strip()
        if line:
            tail = (tail + [line])[-5:]
            emit(line=line)
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(tail[-1] if tail else f"installer exited with code {proc.returncode}")


def _download(url: str, dest: str, emit, label: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "auto-dave"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got, last = 0, -1
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                pct = int(got * 100 / total)
                if pct != last:
                    last = pct
                    emit(line=f"{label} — {pct}%", pct=pct)


def _install_tarball(url: str, binprefix: str, dest_name: str, emit, label: str) -> None:
    os.makedirs(LOCAL_BIN, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        tar_path = os.path.join(td, "pkg.tgz")
        _download(url, tar_path, emit, label)
        emit(line="Unpacking…")
        with tarfile.open(tar_path) as tf:
            member = next((m for m in tf.getmembers()
                           if m.isreg() and os.path.basename(m.name).startswith(binprefix)),
                          None)
            if member is None:
                raise RuntimeError("no binary found in the downloaded archive")
            tf.extract(member, td, filter="data")
            src = os.path.join(td, member.name)
        dest = os.path.join(LOCAL_BIN, dest_name)
        shutil.move(src, dest)
        os.chmod(dest, 0o755)


def _require(binname: str) -> None:
    if harness.resolve_bin(binname) is None:
        raise RuntimeError(f"the installer finished but `{binname}` didn't appear on this Mac")


def _install_claude(emit) -> None:
    emit(line="Downloading the Claude Code installer…")
    _stream_shell(["/bin/bash", "-c", f"curl -fsSL {CLAUDE_INSTALLER} | bash"], emit)
    _require("claude")


def _install_opencode(emit) -> None:
    emit(line="Downloading the OpenCode installer…")
    _stream_shell(["/bin/bash", "-c", f"curl -fsSL {OPENCODE_INSTALLER} | bash"], emit,
                  env_extra={"OPENCODE_INSTALL_DIR": LOCAL_BIN})
    _require("opencode")


def _install_gemini(emit) -> None:
    # Gemini CLI ships only through npm (§19) — fail fast without Node.
    npm = harness.resolve_bin("npm")
    if npm is None:
        raise RuntimeError("Gemini CLI needs Node.js — install it from nodejs.org first, "
                           "then try again.")
    emit(line="Installing @google/gemini-cli with npm…")
    _stream_shell([npm, "install", "-g", "--prefix", os.path.expanduser("~/.local"),
                   "@google/gemini-cli"], emit)
    _require("gemini")


def _install_codex(emit) -> None:
    arch = "aarch64" if platform.machine() == "arm64" else "x86_64"
    _install_tarball(CODEX_URL.format(arch=arch), "codex", "codex", emit,
                     "Downloading Codex")
    _require("codex")


def _install_ollama(emit) -> None:
    _install_tarball(OLLAMA_URL, "ollama", "ollama", emit, "Downloading Ollama")
    _require("ollama")
    emit(line="Starting the Ollama server…")
    for _ in range(10):  # ollama_status autostarts `ollama serve` (§19)
        if harness.ollama_status()["ready"]:
            return
        time.sleep(1)
    raise RuntimeError("Ollama installed but its server didn't start")


_INSTALLERS = {
    "claude": _install_claude,
    "codex": _install_codex,
    "gemini": _install_gemini,
    "opencode": _install_opencode,
    "ollama": _install_ollama,
}
