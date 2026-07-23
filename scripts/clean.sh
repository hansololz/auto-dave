#!/usr/bin/env bash
# Reset the repo to a pre-build state so the next build.sh / dev.sh rebuilds
# from scratch. Stops anything running first (backend service, Electron, vite —
# deleting .venv under the live launchd KeepAlive service would otherwise
# break), then deletes the build artifacts: .venv, app/node_modules, app/dist,
# and build/ contents (keeping build/cache/ — the pinned CPython tarball is
# expensive to re-download — unless --cache). Never touches the data dir
# (~/Library/Application Support/Autowright or AUTOWRIGHT_HOME) or the logs
# dir (logs.sh --clear handles logs).
#
#   ./scripts/clean.sh            delete build artifacts, keep build/cache/
#   ./scripts/clean.sh --cache    also drop build/cache/ (removes build/ entirely)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

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

# ---- stop running pieces (same patterns as dev.sh's stale-process sweep) ----
"$ROOT/.venv/bin/autowright" service uninstall > /dev/null 2>&1 || true
kill_stale "[Pp]ython -m autowright"                 # backend (python -m autowright.main)
kill_stale "$ROOT/.venv/bin/autowright"              # autowright / autowright-backend entry points
kill_stale "$ROOT/app/node_modules/electron"         # electron (incl. helper processes)
kill_stale "$ROOT/app/node_modules/.bin/vite"        # vite dev server

# ---- delete build artifacts ----
remove() {
  [ -e "$1" ] || return 0
  echo "· removing ${1#"$ROOT"/}"
  rm -rf "$1"
}
remove "$ROOT/.venv"
remove "$ROOT/app/node_modules"
remove "$ROOT/app/dist"
if [ "${1:-}" = "--cache" ]; then
  remove "$ROOT/build"
elif [ -d "$ROOT/build" ]; then
  echo "· removing build/ contents (keeping build/cache/)"
  find "$ROOT/build" -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} +
fi

echo "· clean — next ./scripts/dev.sh or ./scripts/build.sh rebuilds from scratch"
