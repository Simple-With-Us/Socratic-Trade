# 2026-11-23 — Console data-layer split, phone tab capacity, and the web quick wins (ZC)

Seat: ZC (ZCode) · Lane: `zc-web-perf` (branch `zc/4642-web-perf`) · Linear: ST-4642 (C1, C4), ST-4645 web half (C2, C3)

## Context & Objective

This lane implements the web half of the 2026-11-21 audit findings `docs/audits/2026-11-21-zc-web-ux-perf.md` (#1, #2, #3, #4, #5) and `docs/audits/2026-11-21-zc-ios-ux.md` (W3, W4).  The objective is to stop the console re-rendering and re-fetching its whole world for data the screen in front of the owner does not use, to give the phone tab bar the same adaptive capacity the native app has, and to remove the duplicate surfaces the audit found.  Parent lane: ST-4662.

Everything here is client-side.  `src/**` and `app/api/**` were out of this lane's ownership, so the server-side half of audit #5 (a `fields=` parameter on `/api/dashboard`) is explicitly NOT done — see "Decisions and trade-offs".

## Changes Made

### C1 — the console data layer is split into per-slice subscriptions (ST-4642, audit #1)

One `ConsoleDataContext` value used to bundle the snapshot, the SSE stream health, the freshness flags and the actions.  Every SSE push minted a fresh stream object, so the bundled value's identity changed and every consumer of the console re-rendered, including the twenty-odd files that only ever read `snapshot`.  The provider now publishes a small store and each consumer subscribes to the one slice it reads.

- NEW `app/console/lib/console-store.ts` — the store, the pure slice selectors, and `ConsoleSliceReader` (the rule React's `useSyncExternalStore` applies to decide whether to re-render: the selected value must change identity).
- REWRITTEN `app/console/lib/useConsoleData.tsx` — the provider now writes into the store instead of holding state, and exposes `useConsoleSnapshot()`, `useConsoleStatus()`, `useConsoleStream()`, `useConsoleActions()`, plus `useConsoleSnapshotOptional()` and `useHasConsoleData()` for the surfaces mounted outside the console shell (`/admin`, the route smoke tests).  `useConsoleData()` still exists and still returns everything; it subscribes to every slice, so the shell chrome (which genuinely needs all of them) keeps using it.
- MIGRATED 27 consumer files from `useConsoleData()` to the narrow hooks (`app/console/**`).
- The memoised cards keep stable props: `ApprovalCard` already took the narrow `pending` proposal and `EquityChart` already took the narrow `points` array, and with the split their PARENT no longer re-renders on a stream push at all, so the memo is reached far less often.

### C4 — the poll is route-aware (ST-4642, audit #5)

- NEW `app/console/lib/route-data-profile.ts` — which SSE event types can change what a route shows, and how often that route is polled.
- A route that displays no market data (`/console/settings`, `/console/strategy`, `/console/connections`, `/console/lessons`, `/console/decisions`) ignores `market-data` pushes and polls every 30s instead of 15s.  Every other event type still refreshes everywhere, so the pending-proposal badge and the notification counts are exactly as live as before.

### C2 — the phone tab bar adapts (ST-4645 web half, audit W4)

- REWRITTEN `app/console/lib/mobile-tabs.ts` — the native `TabBarCapacity` / `TabPreferences` rules are ported: width decides how many slots exist, one slot is always reserved for "More" (which absorbs the rest), a set that does not fit falls back to the defaults without touching the stored choice, and the bar auto-fills to what fits until the owner expresses a preference.  `tabBarCapacity(390)` returns 5, so a phone shows five destinations beside More.
- `app/console/components/nav.tsx` — the bar measures itself (ResizeObserver) and passes the capacity to the hook.

### C2 — one canonical destination for the unread count (ST-4645 web half, audit W3)

- REWRITTEN `app/console/components/notification-inbox.tsx` — the bar bell is now a link to the Alerts Center (`/console/activity?tab=alerts`) carrying the unread count.  The count rides the Activity destination (desktop rail item and phone tab) whose default tab IS the Alerts Center.  One count, one destination.  The quick eight-item preview panel is gone; it was a strict subset of the Alerts Center, which shows up to a hundred rows with filters, search, per-row acknowledge and acknowledge-all, and Activity's second tab is the full Notifications ledger.  The parallel iOS lane is pointing the native bell at the same Alerts Center, so both apps point at one place.

### C3 — the web quick wins (ST-4645 web half, audit #2, #3, #4)

- NEW `app/console/lib/use-media-query.ts` — a media-query hook that answers in a layout effect, so the swap happens before the browser paints.
- `app/console/scan/scan-table.tsx` (audit #2) — the desktop virtualized table and the phone card list are now gated in JavaScript instead of by `hidden lg:block` / `lg:hidden`.  The CSS twin kept BOTH trees in the DOM, so a 250-symbol scan mounted 250 phone cards AND the whole desktop table.  The phone list is also capped at 40 cards with an honest "Showing N of M candidates" line and a Show More button.
- `app/console/assistant/chat.tsx` (audit #3) — on a coarse pointer, Enter inserts a newline and the visible Send button sends; on a keyboard Enter still sends and Shift+Enter adds a line break.  The hint is no longer hidden below `sm` and it says what the keyboard actually does.
- `app/console/ui/primitives.tsx` + `app/console/console.css` (audit #4) — the tooltip's 150ms opacity/translate was a `motion` (framer-motion) animation, which shipped the whole animation runtime in the shared console bundle to animate one element.  It is a CSS transition now (`.con-tooltip` / `.con-tooltip-open`), and the `motion` import is gone from the console tree.

### Tests

- NEW `test/console-context-split.test.tsx` — the slice contract, including "a snapshot-scoped consumer does not re-render when only the stream changes" and a real React render of a consumer inside the published store.
- NEW `test/console-route-data-profile.test.ts` — the route profile rules.
- NEW `test/console-mobile-tabs.test.ts` — the capacity and membership rules.
- `test/console-brokers-account-visibility.test.tsx` — the module mock updated to the new hook names.

## Decisions and Trade-offs

- **The server half of audit #5 is not done.**  The audit's first suggestion was a `fields=` parameter on `/api/dashboard`; that lives in `app/api/**` and `src/**`, which this lane does not own.  The client-side half is done instead: a route that shows no market data stops re-fetching the whole snapshot on every `market-data` push (the audit's "during an active scan, market-data events fire continuously" case) and polls half as often.  No screen displays different data; the trade-off is that an out-of-band change on one of those five routes can take up to 30s instead of 15s to appear, while the owner's own changes still land immediately because every mutation calls `refresh()`.
- **Guardrails is NOT a light route.**  The audit called Guardrails and Settings "read only policy/accounts"; Guardrails actually reads `snapshot.positions` and `snapshot.portfolio` for the unmanaged-shorts notice, so market data genuinely can change what it shows.  It keeps the full profile.
- **The auto-filled tab bar keeps the defaults first.**  The native bar re-sorts an auto-filled set into canonical destination order, which would push "Orders" off a five-slot phone bar (the web's defaults are Home, Proposals, Activity, Orders, and "Orders" is eighth in canonical order).  The web keeps the owner-decided defaults in their own order and fills the extra slot from the canonical remainder, so "Orders" never silently disappears.
- **The `motion` package stays in `package.json`.**  The console no longer imports it, so it is out of the console bundle; removing the dependency touches the lockfile and the Renovate toolchain, which is not this lane's file to churn.  Flagging it for the parent.
- **The tooltip's exit fade survives; the node is kept mounted for 160ms** so the CSS transition can finish.  The `motion` runtime is gone.
- **The C1 test is not a jsdom render.**  This repo's vitest setup is node-only (no jsdom, no testing-library — the same constraint already bit `app/console/lib/console-load-state.ts`).  `ConsoleSliceReader` is the rule React applies, the hook drives a reader like it, and the test drives the same class, so the asserted contract is the shipped one.

## Verification State

Run in the lane (`/mnt/fleet-extra/apps/lanes/Socratic-Trade/zc-web-perf`), in this order:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

- `npm run lint` — PASS.  0 errors. (62 warnings, all pre-existing `react-hooks/set-state-in-effect` style warnings already in the tree.)
- `npx tsc --noEmit` — PASS.  No type errors.
- `npm test` — PASS with two PRE-EXISTING, unrelated failures on this box:
  `test/cpuprofile-summary.test.ts` (2) fails because `scripts/ops/summarize-cpuprofile.mjs` imports a
  TypeScript module directly, which needs the Node 26 the repo pins (`.nvmrc`); this box runs Node 22,
  so `ERR_UNKNOWN_FILE_EXTENSION` is raised.  Neither the script nor its test is touched by this lane.
  Everything else is green (10904 passed, 42 skipped) and the three new files are part of that.
- `npm run build` — PASS.  `next build --webpack` plus the CSP static-hash stamp.
Node on this box is v22.22.1; the repo pins Node 26 in `.nvmrc` and CI, which is the only
difference the two `cpuprofile-summary` failures turn on.  The `lint`, `tsc` and `build` gates
are unaffected by the Node version.

Playwright visual baselines were NOT regenerated: the desktop chrome renders identically (the tooltip animation is hover-only, the scan table's desktop tree is the same table, and the tab bar is a phone-only surface).

## Kody review

Kody reviewed PR #5454 and raised three findings.  All three are fixed in the same branch:

- **The light-route cadence could leak a stale snapshot into a full route.**  Leaving Settings for
  Scan did not refetch, so the chrome (market session state, scan stamps) could be up to one poll
  interval out of date.  The provider now refetches on a transition INTO a shorter cadence
  (app/console/lib/useConsoleData.tsx).
- **The first-load slow timer wrote its flag even after a snapshot had landed**, notifying every
  status subscriber with a value the load state only masked.  The timer now checks that no
  snapshot has arrived before it writes.
- **togglePin capped the stored set at the absolute ceiling instead of the width-derived pin
  limit**, so a set the bar could not render could be stored and then silently fall back to the
  defaults.  It now uses the same pinLimit as canToggle, which is the native rule.

## Next Steps and Blockers

- The PARENT lane merges this PR and owns `STATUS.md`.
- `STATUS.md` was not touched (the parent integrates it).
- `docs/EFFORT-LOG.md` was not touched (archived, read-only).
- The server-side half of audit #5 (a `fields=` slice on `/api/dashboard`) is still open and needs a lane that owns `app/api/**` and `src/**`.
- The `motion` dependency can be dropped from `package.json` in a follow-up that owns the lockfile.
- The parallel iOS lane owns the native half of ST-4645 (the native bell pointing at the Alert Center).  This lane changed the web only.
- The `Orders` and `Watchlist` pages still render their desktop table and their mobile cards simultaneously (audit #9).  Out of this lane's brief; it needs the same one-tree-per-breakpoint treatment as the scan table.

## Zero-Code Findings

- **The audit's claim that Guardrails reads only policy/accounts is wrong.**  `app/console/guardrails/page.tsx` reads `snapshot.positions` and `snapshot.portfolio.totalMarketValue` for the unmanaged-shorts notice, so a price move can change what Guardrails shows.  It is deliberately excluded from the light-route list.
- **The console is not server-rendered with a snapshot.**  The shell shows its load screen until the first `/api/dashboard` fetch lands (an effect, so client-side only), which is why the scan table's breakpoint gate can flip in a layout effect without a hydration mismatch.
- **The phone tab bar's items are `flex: 1`**, so the slot width is the bar width divided by the item count.  64px per slot is what makes 390px fit five destinations plus More; below 64px the labels stop being legible.
