#!/usr/bin/env bash
# Commit all uncommitted changes with an AI-generated message.
# Uses claude (opus 4.8) to summarize the diff, then commits.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ -z "$(git status --porcelain)" ]]; then
  echo "No uncommitted changes."
  exit 0
fi

git add -A

diff="$(git diff --cached)"
stat="$(git diff --cached --stat)"

message="$(claude --model claude-opus-4-8 -p "Write a git commit message for the following changes.
First line: concise summary under 72 characters, imperative mood.
Keep the message short: at most 2-3 sentences total, including the summary line.
Output only the commit message, nothing else. **Never** add any co-contribute to the message.

File stats:
$stat

Diff:
$diff")"

if [[ -z "$message" ]]; then
  echo "Failed to generate commit message." >&2
  exit 1
fi

echo "Commit message:"
echo "---"
echo "$message"
echo "---"

git commit -m "$message"
