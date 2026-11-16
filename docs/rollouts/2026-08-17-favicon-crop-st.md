# 2026-08-17 — Website favicon: cropped offset candlestick ST

## Context & Objective

Owner asked (issue #2731) for the website favicon to be the candlestick ST, cropped so the letters barely fit, on a transparent background, using the offset ST with S higher than T.  That mark is the current iOS App Icon.  The first pass on this branch wrongly rebuilt the old #1626 2D pipeline ST and called the App Icon a dollar sign.  Owner correction: the App Icon is the offset candlestick ST.  This pass uses that asset.

## Changes Made

`scripts/generate-favicon-st.mjs` reads `AppIcon-1024.png` (never writes it), knocks the light grid to alpha with a saturation ramp, un-composites AA fringe from white, and square-crops to the ST with a 3% inset.  Website PNGs are RGBA.  `public/icon.svg` is removed so tabs do not show the 2D pipeline mark.

- `scripts/generate-favicon-st.mjs`
- `scripts/generate-pwa-icons.mjs` (resizes `public/icon.png`; iOS App Icon path removed)
- `public/icon.png`
- `public/icons/icon-192.png`
- `public/icons/icon-512.png`
- `public/icons/apple-touch-icon-180.png`
- `public/apple-touch-icon.png`
- `public/apple-touch-icon-precomposed.png`
- `app/layout.tsx`
- `app/manifest.ts`
- `test/favicon-st.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-13-candlestick-st-favicon.md`
- this note

Removed: `public/icon.svg`, `graphics/favicon-st-source.svg` (wrong source for this ask).

## Decisions & Trade-offs

- Source is the iOS App Icon raster, not a new SVG.  The owner named that offset ST as the mark.
- Saturation ramp (not a hard threshold) so soft-shadow AA does not speckle.  Same class of fix as the 2026-08-12 App Icon lighten.
- Square crop of an 831x703 content box leaves a little vertical air.  That is the offset composition in a square tab, not extra paper.
- iOS App Icon stays opaque RGB 1024.  Apple requires that for the store icon.

## Verification State

```bash
node scripts/generate-favicon-st.mjs
npx vitest run test/favicon-st.test.ts
npx tsc --noEmit
md5sum ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png
# 46703def33604e89c127cfbaeafff1f0 — unchanged from origin/main
```

`public/icon.png` is 512x512 RGBA.

## Next Steps & Blockers

Owner visual check of the tab icon on light and dark browser chrome after deploy.  No TestFlight follow-up; the App Icon was not touched.
