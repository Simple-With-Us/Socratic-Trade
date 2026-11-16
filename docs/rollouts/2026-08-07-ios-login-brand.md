# Rollout: iOS login branded like the website

**Date:** 2026-08-07  
**Branch:** `grok/ios-login-brand`  
**Agent:** GROK

## Context & Objective

Owner asked for the native iOS login screen to be branded similarly to the website login (`app/login/page.tsx`). The website uses the animated candlestick "SOCRATIC TRADE" wordmark (`HeaderLogo` / `candle-ticker.ts`), accent-dot value bullets, plain `--bg` surface, and provider buttons styled Google (accent fill) / GitHub (outline surface) / Apple (system black/white). The iOS screen previously used a generic chart SF Symbol in a teal rounded square, a text title, icon-bullets, and a gradient mesh — visually off-brand.

## Changes Made

- Ported the web candlestick wordmark ticker to SwiftUI (`CandleWordmarkView.swift`) — same mulberry32 walk, green/red candle palette, letter sampling of "SOCRATIC TRADE", 1s column march, reduced-motion static frame.
- Restyled `LoginView.swift` to match web layout:
  - Plain light `#eef1f5` / dark `#0a0a0a` background (no accent gradient)
  - Wordmark at top (no SF Symbol badge or "Control remote…" subtitle)
  - Value bullets with accent dots; copy kept in sync with `LOGIN_VALUE_BULLETS`
  - Button order and styling: Google accent → GitHub outline → Sign in with Apple
  - Preserved Apple width cap (375) and iOS 26 `presentationAnchor` windowScene fix
- Regenerated Xcode project so the new Swift file is in the target (`objectVersion` 100).

### Files touched

- `ios/SocraticTrade/CandleWordmarkView.swift` (new)
- `ios/SocraticTrade/LoginView.swift`
- `ios/Socratic Trade.xcodeproj/project.pbxproj` (xcodegen)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout note

## Decisions & Trade-offs

- Wordmark height is 24pt on phone (web login uses 20) for legibility; aspect ratio pinned to `WORDMARK_AR` 13.081 from the web sampler.
- Provider button order matches web (Google first). Sign in with Apple remains the system control with equal height and full visual weight (App Store SIWA guidance).
- Privacy caption retained under the buttons (App Store transparency; web login has no equivalent).
- GitHub icon stays a small SF Symbol chevron-slash mark; Google uses a multicolor "G" ring. Perfect SVG octocat path parsing was not worth the complexity at 18pt.

## Verification State

```bash
cd ios && xcodegen generate
# objectVersion patched to 100
xcodebuild -scheme SocraticTrade -destination 'platform=iOS Simulator,name=iPhone 16' build
# ** BUILD SUCCEEDED **
```

Unit-test host path (`SocraticTrade.app` vs display name) is a pre-existing simulator test-host quirk; not introduced here. Pure Swift UI change — no `npm` gate required for correctness; CI verify still runs for merge.

## Next Steps & Blockers

- Ship via TestFlight when convenient (`bash scripts/ios-ship-testflight.sh`) so the owner can review on device.
- Optional: share `CandleWordmarkView` in the in-app chrome header later for deeper brand continuity.
- If letter sampling ever looks off on a device (font metrics), re-check Arial-BoldMT availability and the pixel-read flip in `sampleCells`.
