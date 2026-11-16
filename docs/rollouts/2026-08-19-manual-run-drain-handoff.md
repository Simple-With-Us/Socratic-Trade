# 2026-08-19 — Manual Run once drain must resume a claimed worker

## Context & Objective

#2848 is live (`c55c2e64`, `processStartedAt` 2026-08-19T00:51:39Z).  Roth Manual Run once `9d71dda4-1383-4a27-814c-fd80fa44e314` wrote at 00:58:57Z, sat `running` with llm=0, then sweep-failed 01:29:44Z `stalled_no_progress` (honest same-process label, ~31m).  Background ROIC/FTS/embed were already skipped.  Green never started.

This is why gather/Green never ran after the click: the HTTP kick claimed `queued` → `running` and started gather (Robinhood `too many symbols (max 10, got 250)` at 00:59:15Z; congress.trade HTTP 404 at 01:01:53Z).  `strategy-run-drain` then selected only `queued`, so every later tick journaled skipped (1372/1372, avg 8ms).  After the request-scoped `void` kick died or hung, nobody resumed the claimed id.  The 30m sweep failed the row.  Quote-chunk (#2852) is a sibling gather-pricing fix and is not this PR.

## Changes Made

Drain now treats a `running` request with no live in-process heartbeat as an orphan and **resumes the same run id** (the 202 UUID Activity polls).  A live heartbeat is left alone so a healthy worker is not double-started.  `insertStrategyRun` is a no-op when that id is still `running`.  The route kicks immediately and again via `after()` so Next request teardown cannot leave a claimed row with no worker.  Pre-Green Alpaca positions/orders use the 16s+8s first-call budget; the strategy broker snapshot has a 45s deadline; scan + quote cascade has an 8m deadline so gather cannot sit until the 30m sweep.

- `src/lib/strategy-run-requests.ts`
- `app/api/strategy/run/route.ts`
- `src/lib/db-execution.ts`
- `src/lib/scheduler.ts`
- `src/lib/strategy.ts`
- `src/lib/alpaca.ts`
- `test/strategy-run-drain-handoff.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-19-manual-run-drain-handoff.md`

## Decisions & Trade-offs

Same-id resume, not fail-and-mint-a-new-id.  A new id would write `llm_usage` on a row Activity is not polling, which hid Green from the click.  Do not only add another background skip (embed/ROIC/FTS were already skipped on this process).  Do not shrink the 250-name universe.  Robinhood max-10 chunking stays on #2852.  Do not reopen #2840 or #2848.  Do not merge / deploy / bounce.

An in-process heartbeat can lie if Next kills the `await` but leaves the interval.  The 8m gather deadline is the belt for that hung-gather case: the worker fails honestly instead of sitting until the 30m sweep.  Drain resume covers a dead kick (empty heartbeat map after restart, or no beat after teardown).

## Verification State

```bash
npx vitest run test/strategy-run-drain-handoff.test.ts test/strategy-run-once-async-route.test.ts test/stale-running-runs.test.ts
npx tsc --noEmit
```

Full `npm run lint` / `npm test` / `npm run build` run after the PR opens.  Do not merge.  Do not deploy.  Do not bounce Coolify.

## Next Steps & Blockers

Do not merge this PR.  Production is still `c55c2e64`.  The next Manual Run once click after `9d71dda4` is a new request (sweep closed the orphan via #2847) and will hit the same claim-then-skip hole until this lands.  #2852 still needed for the live Robinhood 250-name reject.  Do not bounce Coolify.

## Zero-Code Findings

`strategy-run` journal last fire 2026-08-18T19:39:39Z is the scheduled autonomy lane, not Manual Run once.  No `strategy-run` fire for `9d71dda4` is expected.  `strategy-run-drain` 1372 skipped / avg 8ms is `processed=0` because the selector was `status = 'queued'` after the kick had already claimed the row.
