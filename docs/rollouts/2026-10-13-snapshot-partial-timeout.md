# Mobile snapshot partial timeout

## Context

Production ops snapshot on 2026-10-13 took about 17s, and the iOS client gives `/api/mobile/snapshot` one 30s attempt.  Broker reads on the dashboard path could still stack a 16s call plus an 8s retry, then another 16s quotes wait, and blow that budget.  This change caps the snapshot path only.  The global broker probe timeouts stay where the inflight-deadline tests require them.

Review on PR #4608 asked for four follow-ups: pause Owner Approve only when the broker book is missing, leave time for post-processing inside the 20s cap, keep a specific cached reason, and make the cold shell survive a throwing DB read without calling a connected account "not found".

## Changes

- `getDashboardSnapshot` waits at most 20s.  Each broker or dependency section waits at most 12s, and less when the section budget is already partly spent.  Section waits stop 3s before the outer cap (`SNAPSHOT_POST_PROCESS_RESERVE_MS`) so fills, P&L, scorecards, and the feed can finish.
- On that overall timeout the handler returns the last cached snapshot, including an expired one, with `partialData: true`.  An existing `partialReason` is kept.  The generic budget sentence is used only when the cached snapshot has none.
- A cold start with no cache returns a DB-only shell and lets the in-flight compute fill the cache for the next poll.  `getPolicy`, `listConnectedAccounts`, `getActiveConnectedAccount`, `isAdminEmail`, `accountReadinessForSnapshot`, and `weeklyMarketDigestForScan` each fall back on throw.  The shell passes the active connected account into readiness, and a missing active row is reported as the timeout rather than "account was not found".
- Inside a finished compute, `partialData` is set only when `gateway.getAccounts`, `gateway.getOptionPositions`, or `portfolio/positions/orders` times out.  News, macro, signals, quotes, and the SPY benchmark can miss their deadline without pausing Owner Approve.
- `GET /api/mobile/snapshot` copies `partialData` and `partialReason` into the JSON.
- iOS treats a server `partialData` flag like a decode drop, so Owner Approve stays paused.  The banner uses the server reason when no items were dropped.

Touched files:

- `src/lib/dashboard.ts`
- `test/dashboard-snapshot-budget.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-10-13-snapshot-partial-timeout.md`

## Decisions

Global `GET_ACCOUNTS_FIRST_MS` and the portfolio and quote constants are unchanged.  Lowering them would fail `test/inflight-deadline.test.ts` and would change health probes that are not the phone timeout.

The 20s cap does not abort the underlying broker promise.  It stops waiting.  A later poll can still receive the finished compute from the 10s snapshot cache.

Quote and benchmark timeouts do not set `partialData`.  The phone already allows Owner Approve on a stale snapshot because the server re-checks the proposal.  Pausing on a news or macro miss would block a complete book.

An event-loop stall (a strategy run of several minutes on the same thread) can still delay timers.  This bound covers hung I/O, which is the phone-timeout case.

## Verification

- npm run lint -> ok (0 errors; existing warnings only)
- npx tsc --noEmit -> ok
- npm test -> fail on one untouched case.  `test/egress-guard.test.ts` calls real DNS for discord.com.  This sandbox resolved it to `198.18.0.1`, which the SSRF guard rejects, so `result.ok` was false.  9263 passed, 51 skipped, 1 failed.  A re-run of that file failed the same way.  Snapshot budget tests passed, including the review regressions.  Hosted `verify` is the gate for that DNS case.
- npm run build -> ok

Swift was not compiled here.  Hosted `ios-build` is the compile gate.  This review pass does not change Swift.

## Next

Ready for review.  Label `do-not-automerge` because the snapshot reads broker accounts, positions, and orders.  Do not merge from this lane.
