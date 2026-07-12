#!/bin/bash
# Follow every Auto Dave log stream in one terminal (§5, §18).
#
# The backend runs under launchd, so its console output lands in files, not
# the terminal. Note backend.err.log is NOT errors-only: it is the backend's
# stderr stream, where Python logging and uvicorn write every level — the
# devMode request logging (§5) included. backend.out.log is its stdout
# (normally quiet), app.log the backend application log, vite.log the dev
# server (dev.sh runs only).
#
#   ./scripts/logs.sh            follow all logs; honors AUTODAVE_HOME (§15)
#   ./scripts/logs.sh --clear    truncate existing logs first, then follow
set -euo pipefail

CLEAR=0
[[ "${1:-}" == "--clear" ]] && CLEAR=1

# same resolution as dev.sh: ~/Library/Logs, or <home>/logs when isolated
DATA="${AUTODAVE_HOME:-$HOME/Library/Application Support/Auto Dave}"
LOGS="${AUTODAVE_HOME:+$DATA/logs}"
LOGS="${LOGS:-$HOME/Library/Logs/Auto Dave}"

mkdir -p "$LOGS"
cd "$LOGS"
FILES=(backend.err.log backend.out.log app.log)
touch "${FILES[@]}"
[[ -f vite.log ]] && FILES+=(vite.log)
# truncate in place (: >) — writers keep their open handles, tail -F follows on
[[ $CLEAR == 1 ]] && for f in "${FILES[@]}"; do : > "$f"; done
# -F follows across truncation/recreation (launchd restarts, dev.sh reruns)
exec tail -n 25 -F "${FILES[@]}"
