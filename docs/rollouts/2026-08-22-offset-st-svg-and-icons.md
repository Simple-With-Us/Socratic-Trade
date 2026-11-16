# 2026-08-22 — Offset Candlestick ST Vector SVG and Icon Synchronization

## Context & Objective
The user requested:
1. Creating a vector SVG file representing the offset candlestick "ST" logo (where the horizontal bar of "T" aligns with the middle crossbar of "S").
2. Ensuring the transparent PNG is used for all icons that support transparency (including web favicons and PWA icons).
3. Verifying the iOS App Icon (`AppIcon.appiconset`) and App Store Connect (ASC) listing icon.
4. Explaining why App Store Connect displays the non-offset icon while the iOS on-device app icon shows the offset ST.

## Why ASC Differs from On-Device App Icon
- **On-Device / TestFlight Icon:** Sourced directly from the compiled app bundle's asset catalog (`ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`), which already contains the 3D offset ST mark.
- **App Store Connect Listing Icon:** Apple requires a separate 1024x1024 RGB (no alpha) marketing image uploaded in the App Store Connect web portal under *App Information > App Store Icon*. Apple does **not** automatically pull or overwrite this marketing icon from new `.ipa` builds once a version enters "Prepare for Submission".
- We provide `graphics/asc-app-icon-1024-3d.png` (matching the iOS 3D offset app icon) so the owner can upload it with one click in ASC to sync the store listing icon.

## Changes Made
- **Vector SVG Generation:**
  - Created [`graphics/st-offset-logo.svg`](file:///Users/jay/apps/trading-antigravity/graphics/st-offset-logo.svg) with exact candlestick geometry, rounded rect bodies, and rounded line wicks.
  - Mirrored to [`public/st-offset-logo.svg`](file:///Users/jay/apps/trading-antigravity/public/st-offset-logo.svg) and [`public/icons/st-offset.svg`](file:///Users/jay/apps/trading-antigravity/public/icons/st-offset.svg).
- **Web & PWA Icons:**
  - Generated all sizes from the transparent 1024x1024 offset mark (`public/icon.png`, `public/icons/icon-32.png`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, `graphics/android-launcher-icon-1024.png`).
- **App Store Connect Asset:**
  - Added `graphics/asc-app-icon-1024-3d.png` (1024x1024 RGB 3D offset ST) ready for ASC upload.
- **Testing & Verification:**
  - Updated [`test/favicon-st.test.ts`](file:///Users/jay/apps/trading-antigravity/test/favicon-st.test.ts) to assert SVG and PNG integrity.

## Verification Commands
- `npx vitest run test/favicon-st.test.ts`: passed (5/5 tests).
- `npm run lint`: passed (0 errors).
- `npx tsc --noEmit`: passed (0 errors).
- `xcodebuild build -project 'ios/Socratic Trade.xcodeproj' -scheme SocraticTrade -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`: **BUILD SUCCEEDED**.
