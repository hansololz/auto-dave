# Shared guard + helpers for the developer-only uninstall scripts.
# Sourced by every scripts/uninstall/<tool>.sh — not runnable on its own.
#
# DEVELOPER-ONLY. Agents (Claude Code, Codex, Gemini, OpenCode, or any Auto Dave
# automation) must NEVER execute these scripts. guard() enforces that:
#   1. refuses when agent environment markers are present (CLAUDECODE),
#   2. refuses without an interactive TTY on stdin and stdout
#      (harness children spawn with stdin=/dev/null),
#   3. requires the developer to type the tool name to confirm.

set -euo pipefail

guard() {
  local tool="$1"
  if [ -n "${CLAUDECODE:-}" ] || [ -n "${CLAUDE_CODE_ENTRYPOINT:-}" ]; then
    echo "refusing: developer-only script — agents must not run this" >&2
    exit 1
  fi
  if ! [ -t 0 ] || ! [ -t 1 ]; then
    echo "refusing: developer-only script — needs an interactive terminal" >&2
    exit 1
  fi
  printf 'This uninstalls %s from this Mac. Type "%s" to confirm: ' "$tool" "$tool"
  local answer
  read -r answer
  if [ "$answer" != "$tool" ]; then
    echo "aborted" >&2
    exit 1
  fi
}

# remove <path>... — rm -rf each path that exists (or is a dangling symlink),
# printing what was removed.
remove() {
  local p
  for p in "$@"; do
    if [ -e "$p" ] || [ -L "$p" ]; then
      rm -rf "$p"
      echo "removed $p"
    fi
  done
}
