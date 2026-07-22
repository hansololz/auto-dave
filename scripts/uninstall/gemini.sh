#!/bin/bash
# Uninstall Gemini CLI (installed by backend/autowright/installer.py via
# `npm install -g --prefix ~/.local @google/gemini-cli`).
# DEVELOPER-ONLY — run by hand in a terminal. Agents must never execute this.
# Usage: ./gemini.sh [--purge]    --purge also deletes ~/.gemini (config + auth)
set -euo pipefail
cd "$(dirname "$0")"
. ./_lib.sh

guard "gemini"

# Prefer npm's own uninstall (removes the bin link and package tree together);
# fall back to removing the files directly when npm is gone.
if command -v npm >/dev/null 2>&1; then
  npm uninstall -g --prefix "$HOME/.local" @google/gemini-cli >/dev/null 2>&1 || true
fi
remove "$HOME/.local/bin/gemini" \
       "$HOME/.local/lib/node_modules/@google/gemini-cli"

if [ "${1:-}" = "--purge" ]; then
  remove "$HOME/.gemini"
fi

echo "Gemini CLI uninstalled."
