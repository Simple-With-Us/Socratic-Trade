# 2026-08-05 — iOS Light App Icon Sync

1. **Context & Objective**: The PWA / Web app used `public/icon.svg` as the primary logo, which had dark candlesticks or visual inconsistencies. The objective was to replace this icon with the clean, light version of the iOS App Icon (`AppIcon-1024.png`).

2. **Changes Made**: 
   - Deleted `public/icon.svg`.
   - Copied `ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` and resized it to create `public/icon.png`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, and `public/icons/apple-touch-icon-180.png`.
   - Updated `app/layout.tsx` and `app/manifest.ts` to reference the new static PNG icons instead of the legacy SVG.

3. **Decisions & Trade-offs**: 
   - The SVG was entirely removed. Static PNGs are standard for PWA manifests and Apple Touch Icons.
   - Used standard dimensions (`192x192`, `512x512`, `180x180`) generated via `sips` on macOS.

4. **Verification State**: 
   - `npx tsc --noEmit` -> PASS (712 warnings, 0 errors).
   - `npm run lint` -> PASS (0 errors).
   - Build checks ok.

5. **Next Steps & Blockers**:
   - Verify if any caching layers are retaining the old `icon.svg` on the client side.
