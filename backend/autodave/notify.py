"""macOS notifications (§6 decided: backend posts via osascript, works headless)."""
from __future__ import annotations

import subprocess


def post(title: str, body: str) -> None:
    esc_t = title.replace("\\", "\\\\").replace('"', '\\"')
    esc_b = body.replace("\\", "\\\\").replace('"', '\\"')
    try:
        subprocess.run(
            ["osascript", "-e", f'display notification "{esc_b}" with title "{esc_t}"'],
            capture_output=True,
            timeout=10,
        )
    except Exception:
        pass
