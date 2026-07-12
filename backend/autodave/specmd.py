"""spec.md ↔ block-list conversion (§4.1 spec blocks: h1|h2|li|p, §5 spec.md)."""
from __future__ import annotations


def blocks_to_md(blocks: list[dict]) -> str:
    out: list[str] = []
    for b in blocks or []:
        k, text = b.get("k"), (b.get("text") or "").rstrip()
        if k == "h1":
            out.append(f"# {text}")
        elif k == "h2":
            out.append(f"## {text}")
        elif k == "li":
            out.append(f"- {text}")
        else:
            out.append(text)
    # Blank line between blocks except between consecutive list items.
    lines: list[str] = []
    for i, ln in enumerate(out):
        if i and not (ln.startswith("- ") and lines and lines[-1].startswith("- ")):
            lines.append("")
        lines.append(ln)
    return "\n".join(lines) + "\n"


def md_to_blocks(md: str) -> list[dict]:
    blocks: list[dict] = []
    para: list[str] = []

    def flush() -> None:
        if para:
            blocks.append({"k": "p", "text": " ".join(para)})
            para.clear()

    for raw in (md or "").splitlines():
        ln = raw.rstrip()
        if not ln.strip():
            flush()
        elif ln.startswith("# "):
            flush()
            blocks.append({"k": "h1", "text": ln[2:].strip()})
        elif ln.startswith("## "):
            flush()
            blocks.append({"k": "h2", "text": ln[3:].strip()})
        elif ln.lstrip().startswith("- "):
            flush()
            blocks.append({"k": "li", "text": ln.lstrip()[2:].strip()})
        else:
            para.append(ln.strip())
    flush()
    return blocks
