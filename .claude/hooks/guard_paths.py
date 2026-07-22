#!/usr/bin/env python3
"""PreToolUse guard for Read|Edit|Write|Grep|Glob: block tool calls targeting
the repo-root knowledge.md (generated dev-only doc). Only that exact path —
same-named files elsewhere pass through."""
import json
import os
import sys

data = json.load(sys.stdin)
tool_input = data.get("tool_input") or {}
path = str(tool_input.get("file_path") or tool_input.get("path") or "")
root = os.environ.get("CLAUDE_PROJECT_DIR", "").rstrip("/")

if path and root:
    cwd = data.get("cwd") or os.getcwd()
    abspath = os.path.normpath(
        path if os.path.isabs(path) else os.path.join(cwd, path)
    )
    if abspath == os.path.join(root, "knowledge.md"):
        print(
            "Blocked: knowledge.md is a generated, developer-only doc — "
            "agents must not read, edit, or use it. SPEC.md is the source "
            "of truth.",
            file=sys.stderr,
        )
        sys.exit(2)
