#!/usr/bin/env python3
"""Optimize a screenshot for the web (README + docs): flatten, downscale, JPEG.

Re-run any time you capture a fresh ``screenshot.png`` — it overwrites the committed
``docs/assets/demo.jpg`` that both the README and the docs landing page point at.

    uv run python scripts/optimize_screenshot.py                 # screenshot.png -> docs/assets/demo.jpg
    uv run python scripts/optimize_screenshot.py shot.png -o docs/assets/demo.jpg --max-width 1600 --quality 82

Pillow is already a core dependency (the image encode path), so no extra install is needed.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = REPO_ROOT / "screenshot.png"
DEFAULT_DST = REPO_ROOT / "docs" / "assets" / "demo.jpg"


def optimize(src: Path, dst: Path, max_width: int, quality: int) -> None:
    im = Image.open(src)
    orig = im.size
    # JPEG has no alpha — flatten any transparency onto white so nothing turns black.
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")
    # Downscale (never upscale) so oversized captures don't bloat the page.
    if im.width > max_width:
        im = im.resize((max_width, round(im.height * max_width / im.width)), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, "JPEG", quality=quality, optimize=True, progressive=True)  # progressive: nicer web load
    src_kb, dst_kb = src.stat().st_size / 1024, dst.stat().st_size / 1024
    ratio = dst_kb / src_kb * 100
    print(f"{src.relative_to(REPO_ROOT)}  {orig[0]}x{orig[1]}  {src_kb:.0f} KB")
    print(f"-> {dst.relative_to(REPO_ROOT)}  {im.width}x{im.height}  {dst_kb:.0f} KB  ({ratio:.0f}% of original)")


def main() -> None:
    ap = argparse.ArgumentParser(description="Optimize a screenshot into a web JPEG for the README + docs.")
    ap.add_argument("src", nargs="?", type=Path, default=DEFAULT_SRC, help="source image (default: screenshot.png)")
    ap.add_argument("-o", "--out", type=Path, default=DEFAULT_DST, help="output JPEG (default: docs/assets/demo.jpg)")
    ap.add_argument("--max-width", type=int, default=1600, help="downscale if wider than this (default: 1600)")
    ap.add_argument("--quality", type=int, default=82, help="JPEG quality 1-95 (default: 82)")
    args = ap.parse_args()
    if not args.src.exists():
        raise SystemExit(f"source image not found: {args.src}")
    optimize(args.src, args.out, args.max_width, args.quality)


if __name__ == "__main__":
    main()
