# 2026-08-12 — iOS parity wave 1 (MONET)

## Context & Objective

First implementation wave of the iOS parity roadmap from the 2026-08-12 expert-panel review.
Every item is zero-backend: render data the app already decodes (or that the server snapshot
already sends) and dispatch command types the backend already accepts.  Stacked on
`monet/ios-customizable-tabs` (PR #2647, the customizable tab shell) in a dedicated worktree
(`~/apps/trading-monet-ios-wave1`, branch `monet/ios-parity-wave1`).

## Changes Made

1. **Proposal cards render decision-critical decoded fields** (`ProposalsView.swift`):
   - Price drift line: `proposalReferencePrice` → `proposalCurrentPrice` with the signed %
     computed from the two prices (shown only when both decode and reference > 0).
   - Last revalidation time: `lastRevalidatedAt` as a "Checked" detail line.
   - Red Team failure kind: when `redTeamVerdict.available == false` and `failureKind` is
     present, the panel title becomes "Red Team failed (provider error)" etc., mirroring the
     console's `describeRedTeamFailureKind` wording (new `AppFormat.redTeamFailureKindLabel`).
   - Wash-sale note: **skipped** — no wash-sale field is decoded on `PendingProposal`/`Proposal`
     in `MobileModels.swift`, and this wave adds no new snapshot-key decoding beyond the one
     verified field below.
2. **Protective strategy controls** (`HomeView.swift` StrategyControlsCard): Close Only and
   Wind Down buttons beside the existing Stop, submitting `strategy.close_only` /
   `strategy.liquidating` through the exact CommandButton/`store.submit`/busy pattern Stop
   uses.  `MobileStore.protectiveCommands` already whitelists both.  No new confirmation
   ceremony (owner philosophy: protective actions get the same ceremony as existing controls).
3. **Market-aware run state** (`MobileModels.swift`, `AppComponents.swift`, `HomeView.swift`,
   `ActivityView.swift`): `PolicySummary` now decodes `policy.runDuringExtendedHours`
   (`Bool?`; verified present in `app/api/mobile/snapshot/route.ts`).  New pure
   `deriveRunStateWord(systemState:runDuringExtendedHours:marketSession:)` mirrors the
   console's `deriveStateInfo` vocabulary (`Running`, `Paused · market closed`, `Exit-only`,
   `Winding down`, `Stopped`), using the server-computed `marketSession` instead of a client
   clock.  `nil` policy bool or unknown session keeps the plain "Running" claim (console's
   "undefined ≠ false" rule).  The ReadyHomeHero pill, AgentOverviewCard pill, and the
   Activity scheduler pill all use it now.
4. **Swipe actions** (`AppComponents.swift`, `ProposalsView.swift`, `MarketsView.swift`): new
   `swipeRevealAction` modifier (drag-left reveal; SwiftUI `.swipeActions` is List-only and
   these screens are ScrollView stacks).  Proposals: swipe-to-REJECT only — approval is
   deliberately impossible via swipe; the same `reject()` handler as the button.  Alerts:
   swipe opens the existing delete confirmation dialog (same ceremony as the trash button).
   Watchlist: **skipped** — the watchlist renders as an adaptive capsule-chip grid, not rows;
   a per-chip horizontal swipe reveal fights the grid layout and the chip already removes with
   one tap through the same `watchlist.remove` path.
5. **Triggered alert details** (`MarketsView.swift` AlertRow): triggered alerts now show
   "Triggered at $X · date" from the decoded `triggeredAt` / `triggeredPrice`.
6. **Account sheet capability surface** (`HomeView.swift` ConnectedAccountSettingsRow): quiet
   caption line from `ConnectedAccount.capabilities` (account type, margin, shorting, options
   level) and a warning caption when `isDraining == true`.
7. **Admin portal** (new `ios/SocraticTrade/AdminPortalView.swift`): "Admin Portal" row in the
   Account & Settings sheet, rendered only when `snapshot.currentUser?.isAdmin == true`.  Opens
   a sheet hosting a WKWebView on `https://socratictrade.com/admin`.  Before first load the
   app's `HTTPCookieStorage.shared` cookies for the domain are copied into the web view's
   `httpCookieStore`.  Navigation fence: https + host `socratictrade.com` + path under
   `/admin` (plus `/login` and `/api/auth` for the session-expiry bounce); anything else is
   cancelled.  Landing on `/login` swaps the sheet to a plain "Session Expired" message with a
   Close button.

Touched files:

- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/ProposalsView.swift`
- `ios/SocraticTrade/MarketsView.swift`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTrade/AdminPortalView.swift` (new)
- `ios/SocraticTradeTests/RunStateDerivationTests.swift` (new)
- `ios/Socratic Trade.xcodeproj/project.pbxproj` (xcodegen regen + objectVersion 100 re-applied)
- `STATUS.md`, `docs/EFFORT-LOG.md`, `docs/rollouts/2026-08-12-ios-parity-wave1.md`

## Decisions & Trade-offs

- **No new snapshot decoding beyond `runDuringExtendedHours`** (explicitly verified in
  `app/api/mobile/snapshot/route.ts`).  Wash-sale note skipped for that reason.
- **Swipe = protective/destructive only.**  Approve is button + (for live) typed confirmation
  only; a swipe can never place money at risk.
- **Custom swipe modifier instead of List refactor.**  Rewriting the ScrollView stacks as Lists
  to get native `.swipeActions` would have destroyed the AppCard visual system; the ~90-line
  `SwipeRevealAction` keeps vertical scrolling (plain `.gesture`, mostly-horizontal filter).
- **Run-state derivation uses server `marketSession`**, not a client clock — the phone's clock
  and TZ never affect the word, and the pure function is trivially testable.
- **`AdminPortalWebView` is internal (not private)** solely so the unit suite can pin the
  navigation fence (`Coordinator.isAllowed`).

## Verification State

```bash
cd ios && xcodegen generate   # then re-applied objectVersion/preferredProjectObjectVersion = 100
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project "Socratic Trade.xcodeproj" -scheme SocraticTrade \
  -destination 'platform=macOS,variant=Designed for iPad' test
```

Result: **TEST SUCCEEDED — 28 tests, 0 failures** (21 pre-existing: 13 MobileModelsTests +
8 TabPreferencesTests; 7 new RunStateDerivationTests covering the run-state matrix, the
`runDuringExtendedHours` decode/nil default, and the admin-portal URL fence).  Web `npm` gates
not run — no web-side files changed.

## Next Steps & Blockers

- Orchestrator review, then land via the normal flow once PR #2647 (the base branch) merges —
  this branch must be rebased or retargeted onto `main` at that point.
- Wave 2+ items from the parity review (not in scope here) remain unclaimed.
- Manual device pass on the swipe gesture feel and the admin portal cookie handoff is worth a
  minute on TestFlight; unit tests cannot exercise WKWebView cookie copying.
