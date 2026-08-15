#!/usr/bin/env python3
"""Crop the offset candlestick ST onto a transparent square.

Reads graphics/st-candlestick-favicon-source.png (the 3D ST with S higher
than T, on the original grid).  Writes public/icon.png and the derived
PWA / Apple sizes.  Apple home-screen icons stay opaque white because iOS
fills transparency with black.

  python3 scripts/generate-favicon-st.py
"""

from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "graphics" / "st-candlestick-favicon-source.png"
PUBLIC = ROOT / "public"
ICONS = PUBLIC / "icons"


def cutout(src: Image.Image) -> Image.Image:
    arr = np.asarray(src.convert("RGB")).astype(np.float32)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    sat = np.divide(mx - mn, mx, out=np.zeros_like(mx), where=mx > 1)
    h, w = sat.shape

    core = sat >= 0.26
    closed = Image.fromarray(core.astype(np.uint8) * 255, "L")
    closed = closed.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    core2 = np.asarray(closed) > 127

    reachable = np.zeros((h, w), dtype=bool)
    inv = ~core2
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        if inv[0, x]:
            q.append((0, x))
        if inv[h - 1, x]:
            q.append((h - 1, x))
    for y in range(h):
        if inv[y, 0]:
            q.append((y, 0))
        if inv[y, w - 1]:
            q.append((y, w - 1))
    while q:
        y, x = q.popleft()
        if y < 0 or y >= h or x < 0 or x >= w or reachable[y, x] or not inv[y, x]:
            continue
        reachable[y, x] = True
        q.append((y - 1, x))
        q.append((y + 1, x))
        q.append((y, x - 1))
        q.append((y, x + 1))
    filled = ~reachable

    near = np.asarray(Image.fromarray(filled.astype(np.uint8) * 255, "L").filter(ImageFilter.MaxFilter(5))) > 0
    alpha = np.clip((sat - 0.12) / 0.22, 0, 1)
    alpha = np.where(near, alpha, 0.0)
    alpha = np.where(filled, 1.0, alpha)

    paper = np.array([252.0, 253.0, 254.0], dtype=np.float32)
    rgb = arr.copy()
    a = alpha[..., None]
    decon = np.clip((rgb - (1.0 - a) * paper) / np.maximum(a, 1e-4), 0, 255)
    edge = (alpha > 0.01) & (alpha < 0.95)
    rgb = np.where(edge[..., None], decon, rgb)

    ys, xs = np.where(alpha > 0.30)
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    pad = int(round(max(x1 - x0, y1 - y0) * 0.018))
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(w, x1 + pad), min(h, y1 + pad)
    crop_rgb = rgb[y0:y1, x0:x1]
    crop_a = alpha[y0:y1, x0:x1]
    ch, cw = crop_rgb.shape[:2]
    side = max(cw, ch)
    canvas = np.zeros((side, side, 4), dtype=np.float32)
    ox, oy = (side - cw) // 2, (side - ch) // 2
    canvas[oy : oy + ch, ox : ox + cw, :3] = crop_rgb
    canvas[oy : oy + ch, ox : ox + cw, 3] = crop_a * 255
    out = Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8), "RGBA")
    return out.resize((1024, 1024), Image.Resampling.LANCZOS)


def on_white(src: Image.Image, size: int) -> Image.Image:
    im = src.resize((size, size), Image.Resampling.LANCZOS)
    bg = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    bg.alpha_composite(im)
    return bg.convert("RGB")


def main() -> None:
    if not SOURCE.is_file():
        raise SystemExit(f"missing source {SOURCE}")
    master = cutout(Image.open(SOURCE))
    ICONS.mkdir(parents=True, exist_ok=True)
    master.save(PUBLIC / "icon.png", optimize=True)
    master.resize((512, 512), Image.Resampling.LANCZOS).save(ICONS / "icon-512.png", optimize=True)
    master.resize((192, 192), Image.Resampling.LANCZOS).save(ICONS / "icon-192.png", optimize=True)
    master.resize((32, 32), Image.Resampling.LANCZOS).save(ICONS / "icon-32.png", optimize=True)
    apple = on_white(master, 180)
    apple.save(ICONS / "apple-touch-icon-180.png", optimize=True)
    apple.save(PUBLIC / "apple-touch-icon.png", optimize=True)
    apple.save(PUBLIC / "apple-touch-icon-precomposed.png", optimize=True)
    print("wrote public/icon.png + derived PWA/Apple sizes")


if __name__ == "__main__":
    main()
