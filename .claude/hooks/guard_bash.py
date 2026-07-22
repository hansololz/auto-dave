#!/usr/bin/env python3
"""PreToolUse guard for Bash: block commands touching the repo's scripts/
directory (developer-only) or the repo-root knowledge.md (generated dev-only
doc). Scoped to exactly those repo-root paths — same-named files or scripts/
directories anywhere else pass through."""
import json
import os
import re
import sys

data = json.load(sys.stdin)
cmd = (data.get("tool_input") or {}).get("command") or ""
root = os.environ.get("CLAUDE_PROJECT_DIR", "").rstrip("/")

# A path token counts only when it starts a shell word: beginning of the
# command or after whitespace/quote/=/;/&/|/(/</>/backtick — never mid-path.
SEP = r'(^|[\s"\'=;&|(<>`])'
ENDCHARS = r'[\s"\';&|)<>`]'
END = "(" + ENDCHARS + "|$)"

MSG_SCRIPTS = (
    "Blocked: the scripts/ directory is developer-only — agents must never "
    "run these scripts. The developer runs them by hand in a terminal."
)
MSG_KNOWLEDGE = (
    "Blocked: knowledge.md is a generated, developer-only doc — agents must "
    "not read, edit, or use it. SPEC.md is the source of truth."
)


def refs_scripts() -> bool:
    if re.search(SEP + r"(\./)?scripts/", cmd):
        return True
    if re.search(r"\bcd\s+\.?/?scripts(/|[\s;&|]|$)", cmd):
        return True
    if root and re.search(
        re.escape(root + "/scripts") + "(/|" + ENDCHARS + "|$)", cmd
    ):
        return True
    return False


def refs_knowledge() -> bool:
    if re.search(SEP + r"(\./)?knowledge\.md" + END, cmd):
        return True
    if root and re.search(re.escape(root + "/knowledge.md") + END, cmd):
        return True
    return False


if refs_scripts():
    print(MSG_SCRIPTS, file=sys.stderr)
    sys.exit(2)
if refs_knowledge():
    print(MSG_KNOWLEDGE, file=sys.stderr)
    sys.exit(2)
