"""Curated-import allowlist (§6.2), shared by draft-time validation and the
runtime executor. Step scripts may import the Python stdlib plus the curated
packages — nothing else."""
from __future__ import annotations

import ast
import sys

ALLOWED_IMPORTS = set(sys.stdlib_module_names) | {
    "autodave", "requests", "httpx", "bs4", "lxml", "feedparser", "dateutil", "yaml",
}


def disallowed_imports(code: str) -> list[str]:
    """Module names imported by `code` that aren't on the §6.2 allowlist.

    Same rule as §8 draft validation: every `import X` / `from X import …`
    (absolute, any nesting) is checked by its top-level package name.
    Unparseable code returns [] — the syntax error surfaces at exec time.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    bad: list[str] = []
    for node in ast.walk(tree):
        mods: list[str] = []
        if isinstance(node, ast.Import):
            mods = [a.name.split(".")[0] for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            mods = [node.module.split(".")[0]]
        for mod in mods:
            if mod not in ALLOWED_IMPORTS and mod not in bad:
                bad.append(mod)
    return bad
