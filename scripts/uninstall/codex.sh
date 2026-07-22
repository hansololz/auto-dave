#!/bin/bash
# Uninstall Codex CLI (installed by backend/autodave/installer.py into ~/.local/bin).
# DEVELOPER-ONLY — run by hand in a terminal. Agents must never execute this.
# Usage: ./codex.sh [--purge]    --purge also deletes ~/.codex (config + auth)
set -euo pipefail
cd "$(dirname "$0")"
. ./_lib.sh

guard "codex"

remove "$HOME/.local/bin/codex"

if [ "${1:-}" = "--purge" ]; then
  remove "$HOME/.codex"
fi

echo "Codex uninstalled."
