#!/usr/bin/env bash
# Fastest way to run Auto Dave from the repo, with hot reloading: deps only (no
# renderer bundle), then the real backend, a Vite dev server for the renderer
# (HMR — edits to app/src apply live), and Electron pointed at it via
# AUTODAVE_RENDERER_URL (§15). Same real code everywhere: real data dir
# (~/Library/Application Support/Auto Dave), macOS Keychain, random free port,
# backend as the real launchd LaunchAgent (com.autodave.backend, §3:
# RunAtLoad/KeepAlive, survives Electron quit), no mocks, no seed data.
# Backend edits still need a rerun (the backend is not hot-reloaded).
# Ctrl+C shuts the whole app down (Electron, vite, and the backend);
# quitting Electron normally leaves the backend running, like release.
#
#   ./scripts/dev.sh    deps, restart the service, vite + Electron with HMR
#
# Isolated mode (opt-in): setting any AUTODAVE_* knob makes dev.sh spawn the
# backend directly with that env instead of via launchd (the plist carries no
# env). Knobs (§15): AUTODAVE_HOME (isolated data dir), AUTODAVE_PORT,
# AUTODAVE_OLLAMA_URL, AUTODAVE_STEP_TIMEOUT.
#   --fresh    wipe the data dir first — refused unless AUTODAVE_HOME is set
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_HOME="$HOME/Library/Application Support/Auto Dave"
DATA="${AUTODAVE_HOME:-$RELEASE_HOME}"
# logs live outside the data dir (§5): ~/Library/Logs, or <home>/logs when isolated
LOGS="${AUTODAVE_HOME:+$DATA/logs}"
LOGS="${LOGS:-$HOME/Library/Logs/Auto Dave}"

# any AUTODAVE_* env present → isolated mode (direct spawn so the env reaches the backend)
ISOLATED=0
if env | grep -q '^AUTODAVE_'; then ISOLATED=1; fi

if [ "${1:-}" = "--fresh" ]; then
  if [ -z "${AUTODAVE_HOME:-}" ]; then
    echo "--fresh would wipe the real app data ($RELEASE_HOME)."
    echo "Set AUTODAVE_HOME to an isolated dir to use --fresh."
    exit 1
  fi
  echo "· wiping $DATA"
  rm -rf "$DATA"
fi
mkdir -p "$DATA" "$LOGS"

# ---- deps only (venv + backend deps + npm deps — no renderer bundle) ----
"$ROOT/scripts/build.sh" --deps

# kill lingering processes matching a command-line pattern (scoped to this repo)
kill_stale() {
  local pattern="$1" pids
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  [ -z "$pids" ] && return 0
  echo "· stopping lingering processes (pid $pids): $pattern"
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 25); do
    pgrep -f "$pattern" > /dev/null 2>&1 || return 0
    sleep 0.2
  done
  pkill -9 -f "$pattern" 2>/dev/null || true
}

# ---- shut down lingering processes from previous runs ----
# ps shows the venv python's RESOLVED binary (e.g. Homebrew Python.app), never
# "$ROOT/.venv/bin/python", so match the module invocation itself. Backends can
# be stuck in graceful shutdown (uvicorn waits on open WebSockets) — the
# kill_stale SIGKILL fallback is what actually clears those.
BEFORE=$(cat "$DATA/backend.json" 2>/dev/null || true)
"$ROOT/.venv/bin/autodave" service uninstall > /dev/null 2>&1 || true
kill_stale "[Pp]ython -m autodave"                   # backend (python -m autodave.main)
kill_stale "$ROOT/.venv/bin/autodave"                # autodave / autodave-backend entry points
kill_stale "$ROOT/app/node_modules/electron"         # electron (incl. helper processes)
kill_stale "$ROOT/app/node_modules/.bin/vite"        # vite dev server

# ---- backend ----
if [ "$ISOLATED" = "1" ]; then
  # direct spawn, detached, launchd-like environment (cwd /, minimal PATH)
  echo "· starting backend (isolated mode, data: $DATA)"
  (cd / && PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    "$ROOT/.venv/bin/python" -m autodave.main \
    > "$LOGS/backend.out.log" 2> "$LOGS/backend.err.log" &)
else
  # the real thing: launchd LaunchAgent, exactly as a release install runs it
  echo "· installing launchd service (data: $DATA)"
  "$ROOT/.venv/bin/autodave" service install
fi

# Ctrl+C shuts the whole app down: Electron dies with the terminal's SIGINT,
# the EXIT trap below clears vite, and this stops the backend — service
# uninstall first (launchd KeepAlive would otherwise respawn it), then
# kill_stale, because a plain SIGTERM leaves uvicorn hanging in graceful
# shutdown and only its SIGKILL fallback clears that. Quitting Electron
# normally (Cmd+Q) still leaves the backend running, like release.
shutdown_backend() {
  echo
  echo "· ctrl-c — stopping the backend"
  "$ROOT/.venv/bin/autodave" service uninstall > /dev/null 2>&1 || true
  kill_stale "[Pp]ython -m autodave"
  exit 130
}
trap shutdown_backend INT TERM

# ---- vite dev server (starts while the backend comes up) ----
VPORT=$("$ROOT/.venv/bin/python" -c \
  'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
echo "· starting vite dev server on :$VPORT (log: $LOGS/vite.log)"
(cd "$ROOT/app" && npx vite --host 127.0.0.1 --port "$VPORT" --strictPort \
  > "$LOGS/vite.log" 2>&1 &)
trap 'pkill -f "$ROOT/app/node_modules/.bin/vite" 2>/dev/null || true' EXIT

# wait for a fresh backend.json (rewritten with new pid/token on every start)
PORT=""
for _ in $(seq 1 75); do
  CUR=$(cat "$DATA/backend.json" 2>/dev/null || true)
  if [ -n "$CUR" ] && [ "$CUR" != "$BEFORE" ]; then
    PORT=$(python3 -c "import json;print(json.load(open('$DATA/backend.json'))['port'])" 2>/dev/null || true)
    if [ -n "$PORT" ] && curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then break; fi
    PORT=""
  fi
  sleep 0.2
done
[ -n "$PORT" ] || { echo "backend didn't come up — see $LOGS/backend.err.log"; exit 1; }
echo "· backend healthy on :$PORT (logs: $LOGS/backend.{out,err}.log)"

# wait for vite to answer
VITE_UP=""
for _ in $(seq 1 75); do
  if curl -sf "http://127.0.0.1:$VPORT/" > /dev/null 2>&1; then VITE_UP=1; break; fi
  sleep 0.2
done
[ -n "$VITE_UP" ] || { echo "vite didn't come up — see $LOGS/vite.log"; exit 1; }

# ---- electron (foreground; quitting it leaves the backend running, like release) ----
echo "· launching Electron (HMR via http://127.0.0.1:$VPORT)"
cd "$ROOT/app" && AUTODAVE_RENDERER_URL="http://127.0.0.1:$VPORT" npx electron .
