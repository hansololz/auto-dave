"""Generate the menu-bar icons (circle-play glyph) as PNGs — no deps.

Two variants (§13):
- trayTemplate.png / @2x — black glyph, alpha only; used as a macOS template image.
- trayAlert.png / @2x — non-template: neutral mid-gray glyph (reads on light and
  dark menu bars) with a red alert dot over the top-right, knocked out of the
  glyph so the dot stays crisp.
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

GRAY = (128, 128, 128)
RED = (255, 69, 58)  # systemRed-ish


def make(size: int, glyph_rgb: tuple[int, int, int] = (0, 0, 0), dot: bool = False) -> bytes:
    cx = cy = size / 2
    r_outer = size * 0.44
    stroke = size * 0.075
    # play triangle vertices (pointing right), relative to center
    tri = [(-r_outer * 0.32, -r_outer * 0.42), (-r_outer * 0.32, r_outer * 0.42), (r_outer * 0.52, 0.0)]
    # alert dot: top-right corner, in absolute pixel coords
    dot_cx, dot_cy, dot_r = size * 0.76, size * 0.24, size * 0.21
    knockout_r = dot_r + size * 0.07  # gap between glyph and dot

    def in_triangle(px: float, py: float) -> bool:
        def sign(ax, ay, bx, by, cx_, cy_):
            return (ax - cx_) * (by - cy_) - (bx - cx_) * (ay - cy_)

        d1 = sign(px, py, *tri[0], *tri[1])
        d2 = sign(px, py, *tri[1], *tri[2])
        d3 = sign(px, py, *tri[2], *tri[0])
        neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
        pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
        return not (neg and pos)

    rows = []
    ss = 3  # supersample
    for y in range(size):
        row = bytearray([0])  # filter byte
        for x in range(size):
            cov = 0
            dot_cov = 0
            for sy in range(ss):
                for sx in range(ss):
                    ax = x + (sx + 0.5) / ss
                    ay = y + (sy + 0.5) / ss
                    px, py = ax - cx, ay - cy
                    d = (px * px + py * py) ** 0.5
                    ring = abs(d - r_outer) <= stroke / 2
                    glyph_hit = ring or in_triangle(px, py)
                    if dot:
                        dd = ((ax - dot_cx) ** 2 + (ay - dot_cy) ** 2) ** 0.5
                        if dd <= dot_r:
                            dot_cov += 1
                            continue
                        if dd <= knockout_r:
                            continue  # knockout gap — neither glyph nor dot
                    if glyph_hit:
                        cov += 1
            n = ss * ss
            ga, da = cov / n, dot_cov / n
            # dot drawn over the (knocked-out) glyph; straight alpha
            out_a = da + ga * (1 - da)
            if out_a == 0:
                row += bytes([0, 0, 0, 0])
            else:
                rgb = tuple(
                    round((RED[i] * da + glyph_rgb[i] * ga * (1 - da)) / out_a) for i in range(3)
                )
                row += bytes([*rgb, round(255 * out_a)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "app/electron")
    (out / "trayTemplate.png").write_bytes(make(18))
    (out / "trayTemplate@2x.png").write_bytes(make(36))
    (out / "trayAlert.png").write_bytes(make(18, glyph_rgb=GRAY, dot=True))
    (out / "trayAlert@2x.png").write_bytes(make(36, glyph_rgb=GRAY, dot=True))
    print(f"wrote {out}/trayTemplate.png, trayAlert.png and @2x variants")
