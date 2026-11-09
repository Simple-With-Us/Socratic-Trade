# 2026-08-08 — Review-fixes wave D: mobile (#2559 PWA market session + iOS SSE indicator, #2551 PWA collapsed receipts)

Branch: `monet/review-fixes-d`. Part of the 2026-08-06 full-product-review fix waves
(issues labeled `product-review-2026-08-06`).

## 1. Context & Objective

The 2026-08-06 product review found the mobile surfaces lying about live state: the PWA's
Market metric always said "Closed" and the iOS stream indicator never turned green on a
healthy idle stream (#2559), and PWA proposal cards dumped the raw audit-annotated
rationale instead of the console's Wave-A2 collapsed receipt (#2551). This wave makes the
PWA and iOS mobile surfaces truthful and scannable without touching any approve/reject
behavior.

## 2. Changes Made

### #2559 — PWA `marketSession` type drift (always "Closed")

`/api/mobile/snapshot` sends `marketSession` as the raw `MarketSession` union
(`"closed" | "regular" | "pre" | "post"`, from `currentMarketSession()` in
`src/lib/market-hours.ts` via `getDashboardSnapshot`). The PWA client had drifted to
`marketSession?: { label?: string; isOpen?: boolean }`, so both `.label` and `.isOpen`
were always `undefined` and the Market metric rendered the `"Closed"` fallback in every
session. Fixed the type to `marketSession?: string` and added an exported
`marketSessionLabel()` that capitalizes the token like the iOS home card does
(`snapshot.marketSession.capitalized`): "Regular" / "Pre" / "Post" / "Closed", `"-"` when
missing (never a fabricated "Closed"). Grep confirmed the only `app/mobile` consumers were
the type declaration and the single Metric render.

### #2559 — iOS SSE connected indicator stuck false

`MobileAPIClient.events` only fired its callback on complete payload frames
(`SSEFrameAccumulator` deliberately ignores `: ping` comment heartbeats, sent every 25s),
so `MobileStore.isStreamConnected` stayed `false` on a healthy idle stream. Added an
`onConnect` closure (default no-op, so the signature stays source-compatible) that fires
once after the response is established (`requireSuccess`) and again on every received line
including comment heartbeats. `MobileStore.startEvents` flips `isStreamConnected = true`
in `onConnect`; `onEvent` semantics (payload frames → `scheduleReload()`) are unchanged,
as is the `SSEFrameAccumulator` contract and its unit test.

### #2551 — PWA collapsed proposal receipts (console Wave-A2 / PR-A2 port)

New exported `MobileProposalReceipt` component replaces the inline attribution/est-P/L/
rationale block in each PWA proposal card. Default collapsed: side/symbol/notional + env
stay in the existing card header, then the critic/model line (`modelAttributionLine`),
est. exit P/L, and a `line-clamp-3` thesis summary. "Show full reasoning" expands to the
proposal's full rationale text (`whitespace-pre-wrap`), audit blocks and red-team notes
included. The summary comes from a new exported `proposalThesisSummary()` which reuses the
console's `splitThesisRationale` (from `app/console/lib/thesis.ts`) to cut at red-team
markers, then strips the app-appended `\n\n[Sizing] …` / `\n\n[Risk] …` paragraphs
(`src/lib/strategy-risk.ts`, `src/lib/strategy.ts`) and the inline
`[Stale quote backup: …]` note (`src/lib/policy.ts`). Approve/reject buttons, typed live
confirmation, and command feedback are byte-for-byte untouched.

### Files touched

- `app/mobile/mobile-pwa-client.tsx` — marketSession type + `marketSessionLabel`;
  `proposalThesisSummary`; `MobileProposalReceipt`; card body swap; exported
  `PendingProposal` type (+ `greenTeamRationale` field) for tests.
- `ios/SocraticTrade/MobileAPIClient.swift` — `events(onConnect:onEvent:)`.
- `ios/SocraticTrade/MobileStore.swift` — wire `onConnect` → `isStreamConnected = true`.
- `test/mobile-pwa-client.test.tsx` — marketSession label/type tests; summary-stripping
  tests; collapsed/expanded receipt render tests (renderToStaticMarkup).
- `docs/rollouts/2026-08-08-mobile-review-fixes-d.md`, `STATUS.md`, `docs/EFFORT-LOG.md`.

## 3. Decisions & Trade-offs

- **`marketSession` typed as open `string`, not the 4-token union.** The server union can
  grow; an unknown token still renders capitalized instead of breaking the client. Missing
  value renders `"-"` per the repo's "never fabricate data" convention (the old code
  fabricated "Closed").
- **Reused `splitThesisRationale` (string-signature) rather than `proposalGreenRationale`**
  — the latter takes a full `TradeProposal`, which the PWA's narrower local proposal type
  cannot satisfy. Added `greenTeamRationale` to the local type so the exact-persisted-green
  path works (the snapshot serializes the full proposal, so the field is already on the
  wire).
- **Bracket-stripping is a local minimal helper** (two regexes) rather than a new shared
  console helper: the console's expanded card intentionally shows those blocks, so there
  was no existing "strip" helper to import. The regex also matches a block at string start
  because `splitThesisRationale` trims its result.
- **`MobileProposalReceipt` takes `defaultExpanded`** so the node-environment test suite
  (renderToStaticMarkup, no jsdom/testing-library in this repo) can assert both states;
  runtime always mounts collapsed, matching the console PR-A2 default.
- **iOS `onConnect` fires on every line** (not just once) — idempotent flag set; keeps the
  indicator truthful if a proxy re-establishes mid-stream, at the cost of one no-op
  MainActor task per heartbeat line (~2/25s, negligible).
- Deliberately NOT changed: `SSEFrameAccumulator` payload semantics, approve/reject
  submission paths, typed live-confirmation contract, and the unrelated pre-existing
  attribute-less "Delete app account…" button in the danger-zone section (out of scope;
  flagged for a follow-up).

## 4. Verification State

```
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npx tsc --noEmit
# exit 0, no errors

PATH=… npx vitest run test/mobile-pwa-client.test.tsx test/mobile-api.test.ts
# Test Files  2 passed (2) / Tests  24 passed (24)

PATH=… npx vitest run test/mobile-pwa-client.test.tsx
# Test Files  1 passed (1) / Tests  18 passed (18)

PATH=… npx vitest run test/console-thesis.test.ts test/console-red-team-labels.test.ts
# Test Files  2 passed (2) / Tests  26 passed (26)

PATH=… npm run lint
# 728 problems (0 errors, 728 warnings)  — all grandfathered warnings, 0 errors

cd ios && xcodebuild -project "Socratic Trade.xcodeproj" -list
# Schemes: SocraticTrade
xcodebuild -project "Socratic Trade.xcodeproj" -scheme SocraticTrade \
  -destination "generic/platform=iOS Simulator" build CODE_SIGNING_ALLOWED=NO
# ** BUILD SUCCEEDED **
```

Full `npm test` / `npm run build` deliberately left to the landing operator per the wave
protocol.

## 5. Next Steps & Blockers

- Landing operator: full gate (`tsc` → `npm test` → `npm run build`) + `land.sh` → PR
  referencing #2559 and #2551.
- iOS change ships with the next TestFlight build (`scripts/ios-ship-testflight.sh`) — the
  simulator build is verified; no upload was attempted from this wave.
- Follow-up candidate (separate, not in this wave): the PWA danger-zone
  "Delete app account…" collapsed button in `app/mobile/mobile-pwa-client.tsx` renders
  with no className/onClick (pre-existing), so the danger zone cannot be opened from the
  PWA.

## 6. Zero-Code Findings

- Confirmed the only `marketSession` consumers in `app/mobile` were the two lines fixed;
  iOS consumers (`AppFormat.marketSessionBannerLabel`, `HomeView`) already handle the raw
  token correctly.
