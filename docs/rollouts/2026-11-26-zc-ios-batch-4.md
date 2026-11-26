# 2026-11-26 — ST-4688 iOS batch 4: decision receipt, Home day P&L, settings subpages, Intelligence hub, iPad split

## 1. Context & Objective

Child issue ST-4688 (of the ST-4668 roadmap) collects the owner-approved iOS trader-workflow redesigns from OD-10a/OD-10c/OD-10e that had no other home.  This lane implements the batch-4 scope list exactly as the lead handed it over: R2h, R2k, R2a, R2o, R1a, P14e, R2e, R2d, R1d and R2m, all inside `ios/SocraticTrade/**`  No server, shared TypeScript, web console, or `ios/project.yml` change was needed; iOS never compiles on the Linux host, so the hosted `verify-ios` job is the compile gate for this batch.

## 2. Changes Made

### R2h — Live watchlist prices

- The watchlist chips show a live price and intraday percent change.  The source is one batched read of the existing `GET /api/watchlist` route (broker snapshot first, quote cascade fallback server-side, optional paper delay stamp), not a per-symbol cascade.
- `MobileStore.refreshWatchlistQuotes(force:)` loads on Assets appearance and after every newer snapshot, throttled to 20 s, silent on failure; a symbol with no quote renders "—" and never a guess.
- Files: `ios/SocraticTrade/MobileModels.swift` (`WatchlistQuote`, `WatchlistQuotesResponse`), `MobileAPIClient.swift` (`watchlistQuotes()`), `MobileStore.swift` (state + refresh + account-scoped clear), `MarketsView.swift` (trigger + chip layout + delayed-price caption).

### R2k — Star, Set Alert and Ask Coach in the symbol sheet

- New `SymbolActionsCard` at the top of the symbol sheet: Watch/Watching (star, `watchlist.add` / `watchlist.remove`), Set Alert (pushed `PriceAlertComposer` over the existing `alert.create` command, new to the phone), and Ask Coach (pushes `CoachView` with an editable seeded draft — never auto-sent).
- `PriceAlertDraft` is a pure value type that parses the prefilled formatted quote, enforces the server's `{ symbol, op, price, note }` contract and its $0.01 minimum / 500-char note cap.
- Files: `ios/SocraticTrade/SymbolInfoSheet.swift`, new `ios/SocraticTrade/PriceAlertDraft.swift`, `CoachView.swift` (`init(seedDraft:)`).

### R2a — Equity and open P&L on one card each, plus Today's P&L

- Equity stays once, in the Home hero (the account card); the Portfolio card drops its duplicate Equity tile and keeps Buying Power, Cash, Positions, and the trend chart.
- Open (unrealized) P&L stays once, on the hero; the Performance card drops its duplicate and keeps Realized P&L, Win Rate, Avg.  Return.
- The hero gains a "Today's P&L" tile whose value comes from the server's own `dayPnlHints` (broker prior close plus broker activities flow, or the server's full-ledger inferred flow).  When no verified flow basis exists the tile shows "—" with "cash flow not verified" — an unexplained equity jump is never presented as profit.
- Files: `ios/SocraticTrade/HomeView.swift`, `MobileModels.swift` (`PerformanceSummary.dayPnlHints`), new `ios/SocraticTrade/DayPnl.swift`.

### R2o — Toasts for non-money notices, skeletons for first load

- `successMessage` and ordinary (non-money) errors now arrive as a top-of-screen `ToastBanner` that auto-dismisses in 4 s and can be tapped away.  Money-action results (approve / reject / cancel) and session-level failures ("sign in again") keep the blocking alert.
- The first snapshot load paints `SkeletonWorkspace` — three pulsing placeholder cards plus the loading caption — instead of a lone spinner.  Reduce Motion disables the pulse.
- The notice overlay is hosted both by the authenticated shell and by the symbol sheet, with a same-message guard so two hosts cannot stack one notice.
- Files: `ios/SocraticTrade/AppComponents.swift` (`AppToast`, `ToastBanner`, `StoreTransientAlerts`, `SkeletonWorkspace`, `SkeletonCard`), `MobileStore.swift` (`toast`, `presentToast`, `dismissToast`).

### R1a — Compact decision card with an expandable receipt

- A proposal card now opens compact: symbol, side, notional, execution/confidence/performance pills, the order line, current price, target, stop, then the unchanged Approve/Reject row.  Prices, delays, thesis/regime/model provenance, timestamps, the missing-target note, the revalidation note, the debate panel and the Red Team block live behind a "Show Receipt" disclosure (the disclosure also carries the current Red Team outcome as a pill so the collapsed state is not informationless).
- Approve and Reject never move behind the disclosure.

### R1d — Side-by-side debate and scorecard

- Inside the receipt, `ProposalDebatePanel` puts the Green written case and the Red written case side by side when the width allows and stacks them when it does not.  Each column states plainly when its case is absent.
- The scorecard below shows Ideal Buy / Take Profit / Stop Loss from `proposal.scorecard.sniperPoints`, or says no scorecard was attached.  Per-claim citations are not shown: the payload has no citation field for either case (see section 3).
- Files: `ios/SocraticTrade/ProposalsView.swift`.

### P14e — iPad split panes

- Regular width (iPad, wide Mac window) now renders `NavigationSplitView`: a sidebar listing every screen this login may open (Admin when operator) and a detail pane that reuses the same `destination(for:)` stack, chrome, toolbar, deep-link routing and badges as the phone.  Compact width keeps the existing customizable tab bar unchanged.
- Files: `ios/SocraticTrade/MobileControlView.swift`.

### R2e — Settings grouped into pushed subpages

- The single eleven-section form becomes a five-group index (Account, Alerts & Data, Security, Legal) with pushed subpages: Profile & Accounts, Trading (policy + guardrail edits), Alerts, Daily AI Budget, Data Sources, App Lock, Terms/Privacy, Delete Account.  Sign Out stays on the index footer.
- Files: `ios/SocraticTrade/HomeView.swift` (settings block only).

### R2d — Confirmed stop pill on every tab

- `AppChromeModifier` (the shared chrome on every screen) now carries a compact "Stop" pill beside the alert bell whenever the derived run state is not already Stopped.  It presents a confirmation dialog ("Stop Agent?" / "Keep Running") before submitting `strategy.stop`, and stays available in every state — including stale snapshots — because stopping is a protective command.
- Positions and every other surface therefore have a direct path to the stop control; no surface lost its own controls.
- Files: `ios/SocraticTrade/AppComponents.swift`.

### R2m — Insights becomes the Intelligence hub

- Tab title, icon (`brain.head.profile`), More description and screen title are now "Intelligence".  The first card is `IntelligenceLearningInbox`: a read-only list of `GET /api/learned-context` rows (subject, value, symbol, tier label, origin, relative time), collapsed to six with "Show All N", with loading, empty and retry states.  Approve/reject/delete remain website-only.
- The existing brief, attention items, Coach handoff, run-once pointer and authority card follow unchanged.
- Files: `ios/SocraticTrade/InsightsView.swift`, `MobileModels.swift` (`LearnedContextItem`), `MobileAPIClient.swift` / `MobileStore.swift` (read passthrough), `MobileControlView.swift` (tab naming).

### Tests

- New `ios/SocraticTradeTests/DayPnlTests.swift` (broker flow, nil without a verified basis, curve baseline, inferred-hint matching, helper precedence, equity guards, Chicago day boundary).
- New `ios/SocraticTradeTests/PriceAlertDraftTests.swift` (price parsing, validation, payload shapes, note cap, plus decode tests for `WatchlistQuotesResponse` and `LearnedContextItem`).

## 3. Decisions & Trade-offs

- **Today's P&L is gated on provenance, not availability.** The console's `priorCloseEquity` is documented as never set by server code today, so most accounts will resolve through `todayBrokerFlow` (Alpaca activities) or the server's `todayInferredFlow` hint.  When neither applies the tile shows "—"; we deliberately did not compute day P&L from the mobile `fills` tail, because that tail is display-bounded and could mint a phantom transfer.  If the account has no flow basis, the tile stays honest rather than approximate.
- **R2h reuses a route that already batches.** `GET /api/watchlist` was built for the web console and returns one quote per watched symbol; reusing it avoids N `/api/quote` cascades and avoids a new server field.  Cost: the chips refresh on the snapshot cadence plus a 20 s floor, not on a websocket.
- **Citations (R1d): wire field missing.** Neither `PendingProposal.proposal` nor `RedTeamVerdict` carries per-claim citations/sources, so the debate panel shows the two written cases without implying they are sourced.  Follow-up (batch 5 or a backend slice): add `greenCitations` / `redCitations` (or a shared `citations: [{ label, url }]`) to the proposal payload and render them under each column.
- **R2k alert entry point is deliberately small.** The full alerts list/management UI is P8 (iOS batch 3); this batch only adds creation from a symbol.  Triggered alerts still land in Activity/Alerts Center and push, unchanged.
- **R2d pill is additive.** Home keeps its existing control card; the pill is the always-reachable stop, and it hides once the agent is already stopped so it cannot read as a dead control.
- **P14e keeps the phone bar untouched.** `TabPreferences`, capacity math, deep links and ASC screenshot overrides are unchanged; only the regular-width shell branches.  Sidebar membership ignores pin state because pinning is a tab-bar concept.
- **R2e preserves behaviour.** Subpages render the same section code with the same environment objects and the same keyboard accessory; only the navigation shape changed.  Account deletion still signs out and therefore still dismisses the sheet through the shell swap.
- **R2o scope.** "Non-money" was read as: save confirmations and ordinary command/network errors.  Auth expiry and money-action results stay modal because acting on them requires attention.

## 4. Verification State

No Swift toolchain exists on this Linux host, so nothing was compiled locally.  No TypeScript, server, or `ios/project.yml` file changed, so `npx tsc --noEmit`, `npm run lint`, and the console unit tests were not required and were not run.

Run in this lane:

```bash
git status --porcelain          # 11 modified Swift files + 2 new app Swift files + 2 new test files
python3 -I <bracket-balance scan over ios/SocraticTrade/*.swift>   # all balanced
```

Hosted-CI expectation: `ios-build` (`.github/workflows/ios-build.yml`, GitHub-hosted `macos-latest`) runs `xcodegen generate`, unsigned simulator build, and simulator XCTest, which now includes `DayPnlTests` and `PriceAlertDraftTests`.  A green `verify-ios`/`ios-build` on the PR head is the first real Swift compilation of this batch.

## 5. Next Steps & Blockers

1.  Lead: push `zc/4688-ios-batch-4`, open the PR through the relay (`Fixes ST-4688`), and let hosted `ios-build` compile and test.  Treat any Swift compile error as expected first-pass work, not a surprise.
2.  Follow-up (backend slice): proposal debate citations wire field, then render per-claim sources in `ProposalDebatePanel` (section 3).
3.  Out of scope for this batch, still open: R1f (full-ticket confirm sheet, OD-10c), R2j (interactive history chart with level marks), R2n (learning breakdowns), and the Portal-gated P14a-d extensions.
4.  No owner decision is pending for the work landed here.

## 6. Zero-Code Findings

- `dayPnlHints.priorCloseEquity` exists in the type (`src/lib/types.ts`) and in the console's `deriveDayPnl`, but no server code sets it today (`src/lib/dashboard.ts` sets `todayBrokerFlow` or `todayInferredFlow` only).  The iOS model decodes all three so a future producer starts working without a client change.
- `GET /api/watchlist` already returns `{ items, quotes, priceDelay? }` with cookie auth, which is why R2h needed no server work.
- `PerformanceSummary` reaches the phone through `withMobileEquityCurveCompat(withMobileFillsBound(...))`; both helpers spread the summary, so `dayPnlHints` rides the existing mobile payload untouched.