#!/bin/bash
# Uninstall Ollama (installed by backend/autodave/installer.py into ~/.local/bin).
# DEVELOPER-ONLY — run by hand in a terminal. Agents must never execute this.
# Usage: ./ollama.sh [--purge]    --purge also deletes ~/.ollama (downloaded models!)
set -euo pipefail
cd "$(dirname "$0")"
. ./_lib.sh

guard "ollama"

# Stop the server first — the app autostarts `ollama serve` (§19).
pkill -x ollama 2>/dev/null && echo "stopped ollama server" || true

remove "$HOME/.local/bin/ollama"

if [ "${1:-}" = "--purge" ]; then
  remove "$HOME/.ollama"
fi

echo "Ollama uninstalled."
