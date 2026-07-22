#!/usr/bin/env bash
# Build Autowright from the repo. Touches no processes and no data dir.
#
#   ./scripts/build.sh          fast build: deps (below) + typecheck + bundle the
#                               renderer (npm run build → app/dist, the bundle
#                               Electron loads in release).
#
#   ./scripts/build.sh --deps   deps only: venv + backend deps (re-install when
#                               backend/pyproject.toml changed, stamp file
#                               .venv/.backend-stamp), npm install when
#                               app/package.json changed. Used by dev.sh, which
#                               serves the renderer via Vite instead of app/dist.
#
# Production distributables (.app + DMG) are built by ./scripts/prod.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---- backend ----
if [ ! -x "$ROOT/.venv/bin/python" ]; then
  echo "· creating venv"
  python3.14 -m venv "$ROOT/.venv"
fi
PY_STAMP="$ROOT/.venv/.backend-stamp"
if [ ! -f "$PY_STAMP" ] || [ "$ROOT/backend/pyproject.toml" -nt "$PY_STAMP" ]; then
  echo "· installing backend (pyproject.toml changed)"
  "$ROOT/.venv/bin/pip" -q install -e "$ROOT/backend[dev]"
  touch "$PY_STAMP"
fi

# ---- app deps ----
if [ ! -d "$ROOT/app/node_modules" ] \
   || [ "$ROOT/app/package.json" -nt "$ROOT/app/node_modules/.package-lock.json" ]; then
  echo "· npm install"
  (cd "$ROOT/app" && npm install --no-audit --no-fund)
fi

if [ "${1:-}" = "--deps" ]; then
  echo "· deps done (backend: .venv, app: node_modules)"
  exit 0
fi

# ---- renderer build (Electron loads app/dist, same as release) ----
echo "· building renderer (typecheck + bundle → app/dist)"
(cd "$ROOT/app" && npm run build)

echo "· build done (backend: .venv, renderer: app/dist)"
