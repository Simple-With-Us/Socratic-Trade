# 2026-08-12 — iOS watchlist wrap + account switch + admin portal + P&L

## Context & Objective

Owner screenshot + follow-up: Assets watchlist chips wrap mid-ticker
(`SPCX` → `SP`/`CX`, `XOM` → `XO`/`M`); Admin Portal sheet looks stuck;
tapping Use on another account does nothing for a while then snaps;
Tradier Sandbox shows $0 realized/unrealized despite many positions;
Alpaca Paper appears unswitchable while Tradier Sandbox is active.

## Changes Made

1. **Watchlist chips** — `FlowSymbols` used `LazyVGrid(.adaptive(minimum: 92))`.
   Logo + ticker + 44pt remove is wider than 92pt, and `Text` had no
   `lineLimit`, so symbols wrapped.  Replaced with content-sized
   `WrappingHStack` and `lineLimit(1)`.
2. **Account switch feedback** — `submit` cleared the Use spinner as soon as
   `account.activate` returned, then `load()` fetched a slow snapshot.  The
   sheet sat idle until the new book arrived.  Pending-account id now flips
   the Active/Switching pill immediately and keeps the row busy until the
   snapshot reports the new account.
3. **Stale snapshot after switch** — `setActiveConnectedAccount` did not
   invalidate the 10s dashboard snapshot cache.  An in-flight Tradier
   compute could make the next read look like Alpaca Paper never took.
   Activate now drops every cached snapshot for that user.
4. **P&L $0 on Tradier Sandbox** — iOS rendered fill-ledger
   `paperUnrealizedPnl` / `paperRealizedPnl`.  With no marks (or no fills)
   those are `$0.00`.  Unrealized now prefers broker mark − cost from the
   live position list.  Realized shows "—" when the fill history is empty
   instead of a fake zero.
5. **Admin Portal stuck** — WKWebView had no loading UI, could hang forever
   on `setCookie`, and the navigation fence cancelled same-host `/_next`
   and `/api` if they came through as navigations.  Added a loading/error
   overlay, a 2s cookie-copy timeout, and a main-frame vs subframe fence.

Touched files:

- `ios/SocraticTrade/MarketsView.swift`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/AdminPortalView.swift`
- `ios/SocraticTradeTests/WrappingHStackTests.swift`
- `ios/SocraticTradeTests/AccountMetricsTests.swift`
- `ios/SocraticTradeTests/RunStateDerivationTests.swift`
- `src/lib/db-api-keys.ts`
- `test/mobile-view-scope.test.ts`
- `STATUS.md`, `docs/EFFORT-LOG.md`
- GitHub issue #2657

## Decisions & Trade-offs

- Intrinsic-width wrap instead of bumping the adaptive minimum.
- Account switch stays a view-pointer flip (PR #7); we only invalidate
  cache + keep the spinner, we do not mutate per-account run-state.
- Position-derived unrealized is broker truth for open lots.  Realized
  still comes from the fill ledger; we refuse to print `$0.00` when that
  ledger is empty.
- Admin main-frame still cannot leave `/admin` (Back to Console stays
  cancelled).  Same-host subframes are allowed so the shell can paint.

## Verification State

- `xcodebuild test -scheme SocraticTrade -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.5' -only-testing:SocraticTradeTests/WrappingHStackTests -only-testing:SocraticTradeTests/AccountMetricsTests -only-testing:SocraticTradeTests/RunStateDerivationTests -only-testing:SocraticTradeTests/MobileModelsTests` — **TEST SUCCEEDED** (9 new + existing suites)
- `./node_modules/.bin/vitest run test/mobile-view-scope.test.ts test/dashboard-snapshot-cache.test.ts` — 2 files / 10 tests
- Full `scripts/land.sh` gate at push

## Next Steps & Blockers

Land via `scripts/land.sh`.  Next TestFlight ship picks up the native
changes; the cache-invalidate is live on the web deploy.  No blockers.

## Zero-Code Findings

Tradier Sandbox `$0` realized with only open positions can be honest if
the app never booked closed lots.  Unrealized `$0` with a full position
list is not.
