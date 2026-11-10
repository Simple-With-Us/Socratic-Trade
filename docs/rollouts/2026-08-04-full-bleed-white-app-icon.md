# 2026-08-04 — Full-Bleed Pure White App Icon Assets for Web, PWA & Native iOS

**Agent:** ANTIGRAVITY · branch `agent/antigravity`

## 1. Context & Objective

The user noted that the app icon was still missing a proper light background on iOS and web/PWA installs.
Root causes identified:
1. `public/icon.svg` had a rounded rectangle `<rect rx="96" fill="#ffffff"/>`. Because `rx="96"` left transparent pixels in the 4 corners of the 512x512 square canvas, iOS and Android home screen maskers treated those corners as transparent PNG pixels and rendered a dark/black background around the white icon box.
2. `app/manifest.ts` specified `background_color: "#0a0a0a"` and `theme_color: "#0a0a0a"` (dark mode Theme & PWA background), causing PWA web app manifest splash screens to draw a dark frame around the icon.
3. Native iOS Xcode asset catalog (`ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`) was last updated on July 22 and still contained the legacy dark app icon.

## 2. Changes Made

- **`public/icon.svg`**: Removed `rx="96"` corner radius attribute from the root `<rect width="512" height="512" fill="#ffffff"/>` so the SVG canvas has a 100% solid full-bleed pure white (`#ffffff`) background with zero transparent border pixels.
- **`app/manifest.ts`**: Updated `background_color` and `theme_color` to `#ffffff` (pure white light theme & splash background).
- **`scripts/generate-pwa-icons.mjs`**: Updated generator targets to rasterize `public/icon.svg` directly to:
  - `public/icons/apple-touch-icon-180.png` (180x180)
  - `public/icons/icon-192.png` (192x192)
  - `public/icons/icon-512.png` (512x512)
  - `ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` (1024x1024)
- **Asset Regeneration**: Re-ran icon generation; all 4 PNG icon assets are now fresh, 100% full-bleed white background PNGs.

## 3. Verification State

- `npx tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors
- Image dimensions verified:
  - `apple-touch-icon-180.png`: 180x180
  - `icon-192.png`: 192x192
  - `icon-512.png`: 512x512
  - `AppIcon-1024.png`: 1024x1024
