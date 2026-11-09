# 2026-08-12 — Symbol taps open the company drawer everywhere + iOS fills-card redesign

## Context & Objective

Owner request (2026-08-12): clicking a ticker or company logo on the fills list, portfolio, or anywhere else should pull up the company info drawer exactly like Market Scan does — "this applies to all aspects of the site anywhere really."  A follow-up screenshot critique of the iOS Activity tab asked for bolder/larger text on fill rows (ticker, date/time) and a denser card design.  Built in the throwaway worktree `~/apps/trading-claude-ui` on branch `claude/ui-symbol-drawer-fills` (own PR), separate from the concurrently running dsa-lessons lanes on `agent/claude`.

## Changes Made

Web (commits `ab5b228a` + fix pass `8e134409`):
- A sweep found most console surfaces already wired to `SymbolButton`/`useSymbolDrawer`; closed the remaining gaps: order cancel/replace confirmation sheets, `LiveApproveSheet`/`BulkLiveApproveSheet` summary lines, `/console/decisions` index rows, and admin (`data-catalog` weakest-tickers, `rag-coverage` per-ticker rows) with `SymbolDrawerProvider` newly mounted in `app/admin/layout.tsx`.
- Decisions rows restructured as a "stretched link" (absolute-overlay Link sibling) because a button cannot legally nest in an anchor and the anchor's native activation ignores `stopPropagation`.  A verify pass then caught that `relative` row-content wrappers painted over the overlay (dead navigation) — fixed by lifting only the SymbolButton and timestamp above the overlay.
- Blocker caught and fixed: `SymbolDrilldownSheet` called `useConsoleData()` unconditionally and crashed under admin (no `ConsoleDataProvider` by design).  Added a non-throwing `useConsoleDataOptional()`; the drawer's exposure section now shows an honest "not available here" state instead of claiming "no position" without a snapshot.
- Mobile PWA deferred (documented, not silent): the drawer is built on `console.css` `--con-*` tokens scoped under `.console-root`, which the PWA does not load; mounting it would restyle the whole PWA.  Recorded as a follow-up.

iOS (commit `6eec3f65` + fix pass `e79024b5`):
- `FillActivityRow` typography per the screenshot critique: ticker `.title3` bold, qty@price `.subheadline`, notional `.title3` semibold, date/time `.footnote`; tighter card padding via a new optional `padding` param on `AppCard` (default unchanged elsewhere).  `CommandActivityRow` bumped one notch to match.
- New `SymbolInfoSheet.swift` — company-info sheet mirroring the web drawer, fetching the same on-demand `/api/quote` cascade via new `MobileAPIClient.symbolQuote(_:)` and `SymbolQuoteInfo` model (price/change, sector/industry, volume, P/E, EPS, dividend yield, beta, 52-week range, analyst rating/targets); honest "-" for missing fields.
- Symbol taps wired: fills (`ActivityView`), positions/orders/watchlist/flow-chips/alerts (`MarketsView`), and proposals (`ProposalsView`, fix pass) — every symbol row in the app now opens the sheet, with accessibility labels/traits.
- Fix pass: FlowSymbols remove control restored to a >=44pt tap target; derived `marketCap` (price x sharesOutstanding) removed per the no-fabrication rule (web omits it deliberately); mid-fetch dismissal no longer flashes an error state.
- Merged `origin/main` (#2647 customizable glass tab bar) mid-lane; only overlap was the xcodegen-generated `project.pbxproj` (regenerable; `project.yml` globs sources).

Files touched: see PR diff (web: 10 files under `app/console`, `app/admin`, `app/console/ui`, 1 test; iOS: `ActivityView`, `MarketsView`, `ProposalsView`, `AppComponents`, `MobileAPIClient`, `MobileModels`, `MobileStore`, new `SymbolInfoSheet.swift`, `project.pbxproj`).

## Decisions & Trade-offs

- PWA symbol taps deferred (styling-system boundary, above).  Escape-closes-both-sheets when the drawer is opened from a confirmation sheet is a pre-existing focus-trap limitation, deferred with a note in `focus-trap.ts` — a dedicated slice should move the shared Sheet onto `useFocusTrap`.
- iOS fill timestamps remain device-local (pre-existing app-wide `AppFormat.dateTime` behavior).  Making only fills CT-labeled would be inconsistent; converting ALL iOS timestamps to CT is flagged to the owner as a follow-up decision per the fleet CT-timestamps rule.
- The decisions-row timestamp keeps its hover tooltip and is therefore a small non-navigating zone over the stretched link (deliberate).

## Verification State

- Web: `npx tsc --noEmit` clean; `npm run lint` 0 errors; touched test `console-decisions-index` 3/3.  Full trio (`tsc`/`npm test`/`npm run build`) runs via `scripts/land.sh` at push; the required `verify` CI gate re-runs everything before merge.  Browser verification on the dev server: clicking AAPL on the watchlist opened the `con-drawer` aside "AAPL details" with live quote/company data; `/admin`, `/admin/data-catalog`, `/admin/rag-coverage`, `/console/decisions`, `/console/orders` all render 200 on this branch (the admin routes exercise the `useConsoleDataOptional` crash fix).
- iOS: `xcodebuild -scheme SocraticTrade -destination "generic/platform=iOS Simulator" build` PASS (re-run post-merge and post-fix-pass: BUILD SUCCEEDED, both simulator slices).
- Adversarial verify passes: web approved (2 documented deferrals), iOS approved (findings fixed in fix pass).

## Next Steps & Blockers

- Follow-ups recorded on the live board: PWA drawer support (needs a con-token-independent drawer skin or PWA token bridge); shared Sheet onto `useFocusTrap`; owner decision on CT-labeling iOS timestamps app-wide.
- iOS changes ride the next TestFlight ship (1.0.N per fleet versioning policy) — not shipped from this lane.
