# ST-4618 iOS Dynamic Type chrome + 44pt tap targets

## Context & Objective

UIKit appearance-proxy fonts for nav bars, tab items, and segmented controls stayed at fixed point sizes while SwiftUI content scaled with Dynamic Type (split from ST-2813).  This change scales chrome through `UIFontMetrics`, re-applies on content-size changes, and brings two undersized controls up to a 44pt minimum hit area.

## Changes Made

- Added `AppChromeFontScaling` with per-surface text styles, Lato bases, and maximum point sizes; wired `AppAppearance.applyFonts()` through it and observe `UIContentSizeCategory.didChangeNotification`.
- Activity notification filter capsules and More-tab pin toggles use 44pt minimum hit targets with explicit accessibility labels where needed.

**Files touched:**

- `ios/SocraticTrade/AppTypography.swift`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTrade/MobileControlView.swift`
- `ios/SocraticTradeTests/AppTypographyTests.swift`
- `STATUS.md`
- `docs/rollouts/2026-11-12-st-4618-ios-dynamic-type-chrome.md`

## Decisions & Trade-offs

- Chrome uses capped scaling (e.g. nav title max 23pt, large title max 41pt) so accessibility sizes do not blow out tab bars.
- `xcodebuild` is not available on this cloud seat; iOS compile/XCTest is left to hosted `ios-build` CI.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

- Wait for PR `verify` and `ios-build` on GitHub.  Jay merges; do not auto-merge from the agent.

## Zero-Code Findings

None.
