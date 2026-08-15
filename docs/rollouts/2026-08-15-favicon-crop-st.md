# 2026-08-15 — Website favicon: cropped offset candlestick ST, transparent

## Context & Objective

Owner asked (iMessage, Grok — Socratic Trade) for the website favicon to be the candlestick **ST** that is offset with **S higher than T**, slightly larger / cropped so the letters barely fit, on a transparent background.

The tab icon was already that 3D ST, but it sat on a white grid with a lot of padding.  This pass cuts the grid away and tight-crops the mark.

## Changes Made

- Cut the 3D offset ST out of the original 1024 grid render (saturation core + hole fill + white-fringe decontamination).
- Letterboxed into a square with ~2% pad so the ST barely fits.
- Transparent PNG for the tab / PWA icons.  Apple home-screen icons stay **opaque white** (iOS fills transparency with black).
- Did **not** touch the iOS App Icon (dollar-sign candlesticks).

Files:

- `graphics/st-candlestick-favicon-source.png` — original 3D ST on the grid (regeneration source)
- `scripts/generate-favicon-st.py` — cutout + crop + size export
- `scripts/generate-pwa-icons.mjs` — now resizes `public/icon.png`; no longer writes `ios/**/AppIcon-1024.png`
- `public/icon.png` — 1024 RGBA master
- `public/icons/icon-32.png`, `icon-192.png`, `icon-512.png`
- `public/icons/apple-touch-icon-180.png`, `public/apple-touch-icon.png`, `public/apple-touch-icon-precomposed.png`
- `app/layout.tsx` — serve the 32px tab icon first

## Decisions & Trade-offs

- Website favicon only.  Native iOS app icon stays the dollar-sign mark from 2026-08-12.
- Apple touch icons are flattened onto `#ffffff` on purpose.
- A few 3D specular highlights on candle tops are slightly clipped at 1024; invisible at tab size.

## Verification State

- Visual check of 1024 / 512 / 64 / 32 on white and dark: reads as offset ST, S above T, no grid.
- `python3 -c` confirmed `public/icon.png` is 1024 RGBA.
- Gate: `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` via `scripts/land.sh`.

## Next Steps & Blockers

None.  Hard-refresh the tab if the old grid icon is cached.

## Zero-Code Findings

None.
