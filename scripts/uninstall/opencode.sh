#!/bin/bash
# Uninstall OpenCode (installed by backend/autowright/installer.py into ~/.local/bin).
# DEVELOPER-ONLY — run by hand in a terminal. Agents must never execute this.
# Usage: ./opencode.sh [--purge]    --purge also deletes config/auth/data dirs
#
# Prefers the CLI's own `opencode uninstall` (official, opencode.ai/docs/cli),
# then sweeps any leftover paths. --force skips its prompt — guard() already
# confirmed with the developer.
set -euo pipefail
cd "$(dirname "$0")"
. ./_lib.sh

purge="${1:-}"
guard "opencode"

opencode_bin="$(command -v opencode || true)"
[ -x "$HOME/.local/bin/opencode" ] && opencode_bin="$HOME/.local/bin/opencode"
if [ -n "$opencode_bin" ]; then
  if [ "$purge" = "--purge" ]; then
    "$opencode_bin" uninstall --force || true
  else
    "$opencode_bin" uninstall --force --keep-config --keep-data || true
  fi
fi

remove "$HOME/.local/bin/opencode"

if [ "$purge" = "--purge" ]; then
  remove "$HOME/.local/share/opencode" \
         "$HOME/.local/state/opencode" \
         "$HOME/.config/opencode" \
         "$HOME/.cache/opencode"
fi

echo "OpenCode uninstalled."
