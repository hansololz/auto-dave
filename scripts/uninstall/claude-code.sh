#!/bin/bash
# Uninstall Claude Code (installed by backend/autodave/installer.py via
# claude.ai/install.sh — binary in ~/.local/bin, versions in ~/.local/share/claude).
# DEVELOPER-ONLY — run by hand in a terminal. Agents must never execute this.
# Usage: ./claude-code.sh [--purge]
#   --purge also deletes ~/.claude and ~/.claude.json* — settings, memory,
#   project history, and credentials. Irreversible; think before purging.
set -euo pipefail
cd "$(dirname "$0")"
. ./_lib.sh

guard "claude"

remove "$HOME/.local/bin/claude" \
       "$HOME/.local/share/claude"

if [ "${1:-}" = "--purge" ]; then
  remove "$HOME/.claude" \
         "$HOME/.claude.json" \
         "$HOME/.claude.json.backup"
fi

echo "Claude Code uninstalled."
