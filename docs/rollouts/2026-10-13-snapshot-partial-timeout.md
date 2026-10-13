# Mobile snapshot partial timeout

## Context

Production ops snapshot on 2026-10-13 took about 17s, and the iOS client gives `/api/mobile/snapshot` one 30s attempt.  Broker reads on the dashboard path could still stack a 16s call plus an 8s retry, then another 16s quotes wait, and blow that budget.  This change caps the snapshot path only.  The global broker probe timeouts stay where the inflight-deadline tests require them.

## Changes

- `getDashboardSnapshot` waits at most 20s.  Each broker or dependency section waits at most 12s, and less when the overall budget is already partly spent.
- On that overall timeout the handler returns the last cached snapshot, including an expired one, with `partialData: true` and `partialReason`.  A cold start with no cache returns a DB-only shell and lets the in-flight compute fill the cache for the next poll.
- A section that times out inside a finished compute also sets `partialData` and names the section.
- `GET /api/mobile/snapshot` copies those two fields into the JSON.
- iOS treats a server `partialData` flag like a decode drop, so Owner Approve stays paused.  The banner uses the server reason when no items were dropped.

## Decisions

Global `GET_ACCOUNTS_FIRST_MS` and the portfolio and quote constants are unchanged.  Lowering them would fail `test/inflight-deadline.test.ts` and would change health probes that are not the phone timeout.

The 20s cap does not abort the underlying broker promise.  It stops waiting.  A later poll can still receive the finished compute from the 10s snapshot cache.

An event-loop stall (a strategy run of several minutes on the same thread) can still delay timers.  This bound covers hung I/O, which is the phone-timeout case.

## Verification

`npx tsc --noEmit` clean.  `npx vitest run test/dashboard-snapshot-budget.test.ts test/dashboard-snapshot-cache.test.ts test/dashboard-halt-cause.test.ts test/dashboard-order-role-api.test.ts test/inflight-deadline.test.ts` passed.  Swift was not compiled here.  Hosted `ios-build` is the compile gate.

## Next

Ready for review.  Label `do-not-automerge` because the snapshot reads broker accounts, positions, and orders.  Do not merge from this lane.
