# Broker call bounds and protective-lane isolation

## Context & Objective

Linear ST-2570.  A broker call with no deadline could run forever, and the protective scheduler lanes (stops, stale exits, halts) shared that wait.  One hung read latched an account's in-flight guard, or held up the next account's protection, and a strategy run could stay `running`.  This bounds every broker call and splits protection from the awaited health probe.

## Changes Made

- Shared helpers in `src/lib/inflight-deadline.ts`: `brokerAbortSignal` (30s, composed with a caller signal), `BROKER_ORDER_PAGE_CAP` (50), `BROKER_ORDER_LIST_CAP` (500), `BROKER_QUOTE_SYMBOL_CAP` (25), `scopeBrokerOrders`, `chunkBrokerSymbols`, `rejectIfAborted`, and `STRATEGY_BROKER_SNAPSHOT_DEADLINE_MS` (45s).
- Alpaca, Tradier, Public, eToro, Robinhood, and Kalshi fetches abort on that deadline.  Order listings are page-capped and then row-capped (live orders kept; old terminal rows dropped unless `fullHistory`).  Quote batches, and eToro eligibility, are chunked.  Kalshi already aborted at 10s and now also paginates orders under the page cap.  Webull stays fail-closed with no live HTTP.
- `launchIsolatedProtectiveLane` releases the stop and stale-exit guards when the deadline wins and no broker write has started, and aborts that lane's signal so a late read cannot remediate.  Pending-fill reconcile sets the write flag immediately so a hung book cannot double-book.  The scheduler launches those lanes for every eligible account, then awaits health and halts.
- In-run safety maintenance aborts the stop monitor on a deadline when no exit order has been sent.  `runSyntheticStopMonitor` checks the signal immediately before `placeEquityOrder`.  If the stop was already claimed, that check calls `revertSyntheticStopClaim` (the attempt id stays) and returns, so a breached stop does not sit `triggered` with no exit until the 15-minute re-arm grace.
- A strategy run wraps `checkBrokerHealth` in `withLaneDeadline` and the pre-decision snapshot in `withDeadline`.  Either timeout throws into the run's catch, which finishes the row `failed`.

**Files**

- `src/lib/inflight-deadline.ts`
- `src/lib/alpaca.ts`
- `src/lib/tradier.ts`
- `src/lib/public-broker.ts`
- `src/lib/etoro.ts`
- `src/lib/robinhood.ts`
- `src/lib/kalshi-broker.ts`
- `src/lib/scheduler.ts`
- `src/lib/safety-maintenance.ts`
- `src/lib/synthetic-stops.ts`
- `src/lib/strategy.ts`
- `test/scheduler-stale-exit-inflight-guard.test.ts`
- `test/robinhood-orders-error-throws.test.ts`
- `test/protective-lane-isolation.test.ts`
- `test/synthetic-stops.test.ts`
- `test/etoro-boundary-schema.test.ts`
- `docs/phase-1-autonomy-loop.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-10-15-broker-call-bounds.md`

## Decisions & Trade-offs

- Aborting a place or cancel stops the client wait.  It does not prove the broker rejected the order.  Placement still goes through the existing idempotency key (`refId` / client order id).  The lane guard stays held once `writeStarted` is set, so a deadline cannot start a second sell while the first write is in flight.
- Pending-fill reconcile is not released on a hung read.  That lane books fills.  Releasing it would allow a second pass to book the same fill.
- A health-probe timeout is still not a first-strike halt.  The existing streak logic is unchanged.  The new behavior is that the probe cannot pin later accounts' stops and exits, and an in-run probe timeout fails that run instead of leaving it `running`.
- The stale-exit in-flight test used to require the guard to stay held past the deadline.  That contract was for a cancel-replace already in flight.  A read that never reaches remediation now releases the guard.  The test matches that.
- Sentry review on the abort check: returning after `claimSyntheticStop` without `revertSyntheticStopClaim` left the row `triggered` until `REARM_CONFIRM_GRACE_MS` (15 minutes).  The abort path now reverts the claim and keeps `last_attempt_ref_id`.  It does not continue the loop, so a later symbol is not sold after the lane has aborted.
- Kody rules [18] and [29] on the eToro rates and eligibility bodies: those two responses now go through Zod (`passthrough`, nullish lists) before a row is read.  A body that is not an array or the documented envelope throws.  The four schemas are exported (`EtoroRateRowSchema`, `EtoroRatesResponseSchema`, `EtoroEligibilityRowSchema`, `EtoroEligibilityResponseSchema`) so a test can parse the envelope directly.  Other eToro casts were already on `main` and are not part of this pass.

## Verification State

```bash
npm run lint          # exit 0, 0 errors, 848 warnings
npx tsc --noEmit      # exit 0
npm test              # 9374 passed, 51 skipped, 26 failed
npm run build         # exit 0
```

Focused vitest (`test/protective-lane-isolation.test.ts`, `test/scheduler-stale-exit-inflight-guard.test.ts`, `test/broker-io-deadlines.test.ts`, `test/scheduler-pending-fill-inflight-guard.test.ts`, `test/scheduler-halt-cause-tick.test.ts`) was 16 passed.  After the full suite, `test/robinhood-orders-error-throws.test.ts` was 4 passed.  `npx vitest run test/synthetic-stops.test.ts -t "re-arms a claimed stop"` was 1 passed.

After merging `origin/main` through `e3ba1507` (2026-10-15 shepherd): `npx tsc --noEmit` exit 0, `npm run lint` exit 0 (0 errors, 849 warnings), focused vitest on this diff (`etoro-boundary-schema`, `protective-lane-isolation`, `synthetic-stops`, `scheduler-stale-exit-inflight-guard`) was 83 passed, full `npm test` was 9382 passed / 51 skipped / 23 failed (failures match `origin/main` baseline in this sandbox, not this PR).  Prior merges through `df7e6d10` and `2075c857` are documented above.

The full-suite Robinhood failure was a populated-list fixture dated 2026-07-10.  The default order listing now drops terminal rows outside the since-window, so that fill was omitted.  The fixture uses `new Date().toISOString()`.  The other 25 failures are outside this diff: LLM key routing (`chat-llm`, `llm-provider`, `framework-review`, `openrouter-credits`, `red-team`), notify credentials, `server-metrics` host detection, `cpuprofile-summary`, and TwelveData cache tests.

## Next Steps & Blockers

- `origin/main` through `16285744` is merged with merge commits.  Runtime merges were clean.  Inherited conflict markers in rollout docs (`2026-10-15-st-4531-retire-slack-callers.md`, this file's Next Steps block) were cleaned after shepherd merges.  The chain includes bridge removal (`3c74cd81`), Congress inbound push receipt (`df7e6d10`), honest approve (`3f4ef5e5`), Slack-to-Zulip retirement (`2075c857`), iOS ASC env fix (`e3ba1507`), Congress webhook receipt (`49a76da4`), Congress fundamentals nightly push (`12702bd9`), storage-hygiene forever retention (`4a245d8d`), and ops performance parked flag (`16285744` / #4712).  The deleted bridge writer is gone from `src/lib/scheduler.ts`.  The strategy snapshot deadline is still in place next to the approve placement change.
- PR #4715 stays ready with `do-not-automerge`.  Do not enable auto-merge.
- Jay squash-merges.  Do not mark ST-2570 completed until it is on `main`.
