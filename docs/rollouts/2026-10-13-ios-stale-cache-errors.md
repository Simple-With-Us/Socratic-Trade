# iOS stale cache + network error copy

## Context & Objective

Stop the native app from trusting stale snapshot market session, surfacing generic alerts over cached workspace data, and treating PR #4609 stale scan responses as failures.

## Changes Made

- `ios/SocraticTrade/MobileStore.swift` — 45s snapshot timeout, network retry with backoff (2 attempts) even when cache exists; suppress load errors when cached snapshot is on screen.
- `ios/SocraticTrade/NYSEMarketSession.swift` — device NYSE session (holidays + regular hours).
- `ios/SocraticTrade/MobileAPIClient.swift` — URLError-specific user messages.
- `ios/SocraticTrade/MobileModels.swift`, `AppComponents.swift`, `HomeView.swift`, `ActivityView.swift`, `GuardrailsView.swift`, `InsightsView.swift`, `ScanView.swift`, `DeskModels.swift` — stale session + scan handling.
- `ios/SocraticTradeTests/*` — unit tests.

## Decisions & Trade-offs

- Stale snapshot uses client session only (not cached `marketSession`).  Early-close days follow the same rules as `src/lib/market-hours.ts`.
- Scan `stale: true` HTTP 200 is success with an informational note, not `loadError`.

## Verification State

```bash
npm run lint
npx tsc --noEmit
```

iOS: `ios-build` CI (Swift compile + XCTest on macos-latest).

## Next Steps & Blockers

- Merge after `ios-build` + `verify` green on PR.

## Zero-Code Findings

None.
