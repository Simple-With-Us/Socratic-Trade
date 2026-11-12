# ST-4620 — Stop the /api/dashboard request storm

## Context & Objective

Sentry SOCRATIC-TRADE-3H recorded one Safari session on 2026-11-05 (release 9d4e45c5) with about ten overlapping GET /api/dashboard requests.  Each request ran near the 20s snapshot budget and called finnhub.io, data.alpaca.markets, paper-api.alpaca.markets, query1.finance.yahoo.com, and api.roic.ai on its own.  Trace a830aa309d034ccf93fda672e7c19e13 shows 1,378 spans and 644 outbound http.client spans.  This change keeps one dashboard fetch in flight per tab and one snapshot computation per user and selected account.

## Changes Made

- `src/lib/dashboard-coalesce.ts` — per-user and selected-account single-flight, plus an 8s memo of a finished snapshot.  The store lives on `globalThis` so duplicate module instances in one process share one compute.  A thrown compute is not memoized.  A snapshot whose `partialReason` starts with `Dashboard snapshot exceeded ` is not memoized, because that shell is the 20s budget result and the inner compute may still finish.
- `src/lib/dashboard-snapshot-cache.ts` — `onDashboardSnapshotInvalidated` notifies the outer memo.  Existing cache behavior is unchanged.  `src/lib/dashboard.ts` is not edited.
- `app/api/dashboard/route.ts` — GET wraps `getDashboardSnapshot` with `coalesceUserDashboardSnapshot`.  `force-dynamic` stays.  The response does not grow a shared `max-age`.
- `app/api/mobile/snapshot/route.ts` — the same wrap.  No iOS change.
- `app/console/lib/dashboard-request.ts` — one shared dashboard fetch per tab.  The last subscriber abort aborts the fetch.  A response that takes 8s or longer backs the next poll off by the elapsed time, capped at 30s.
- `app/console/lib/api.ts` — `fetchDashboard` goes through that gate.
- `app/console/lib/useConsoleData.tsx` — an explicit refresh joins the in-flight request instead of aborting it and starting another.  A poll tick is skipped while a request is in flight or while the backoff is active.  Unmount still aborts.
- Tests: `test/dashboard-coalesce.test.ts`, `test/dashboard-request.test.ts`.

## Decisions & Trade-offs

The outer coalescer does not reuse the map inside `getDashboardSnapshot`.  Wrapping that map deadlocks, because the outer call would wait on its own in-flight promise.  The 8s TTL sits inside the requested 5–10s window.  Invalidation is a listener on `invalidateDashboardSnapshotCache`, so policy writes, order actions, and key changes drop the memo without editing those call sites.  An in-flight compute that started before the invalidation is still shared, and it is not stored if the generation changed.  Concurrent callers share the first `getDashboardSnapshot` return, including a budget shell.  The next call after that promise settles computes again.  `await refresh()` during an in-flight request waits for that attempt plus one follow-up.  It does not abort and replace the request.  Poll backoff does not apply to an explicit refresh or to the SSE refresh.  No order, sizing, or risk-gate change.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npx tsc --noEmit` is clean.  `npm run lint` exits 0 with 869 warnings and 0 errors.  Focused vitest (`test/dashboard-coalesce.test.ts`, `test/dashboard-request.test.ts`) passed, 17 tests.  Full `npm test` is 10245 passed, 41 skipped, and 18 failed across 12 files.  Those failures are outside this change.  They expect a missing provider key or an unconfigured local host, and this VM already has keys or host metadata.  None of them import the dashboard coalescer.  `npm run build` completed with `NODE_OPTIONS=--max-old-space-size=4096` after the default heap aborted.  The local Node is v22.23.4. Node 26 from `.nvmrc` is not installed on this VM.

## Next Steps & Blockers

Open the PR against `main`.  Do not merge and do not enable auto-merge.  GB-Trader already holds the Linear claim.  This seat is that worker and did not take the claim.  Kody is requested once if a review has not started on its own.

## Zero-Code Findings

The inner 10s snapshot cache did not stop the 2026-11-05 storm.  The client refresh path aborted an in-flight GET and started another, and the server kept computing the aborted request.  PR #5138 owns `src/lib/dashboard.ts` and the console files listed in the issue, so this change wraps the snapshot from the route.
