# 2026-08-20 — Cancel what you time out, and stop launching duplicates on top of live orders

## Context & Objective
Production had not completed a strategy run in ~44.5 hours, and a fresh process served `/api/health` in 0.61s while a 5-hour-old one took 55.4s and once >120s.  Something accumulates over process lifetime.  A 13-agent investigation identified `withDeadline` never cancelling its timed-out work as the highest-leverage available change and the leading candidate for that accumulator.

This is **not** the fix for the run stall itself — see the honest scoping below.

## The three fixes

**1. `withDeadline` now aborts on timeout.**  `src/lib/inflight-deadline.ts` was a pure `Promise.race`: on timeout the caller proceeded while the underlying promise kept running with its socket open, for the life of the process.  It now takes an optional `AbortController` and calls `controller.abort(error)` on the **timeout branch only** — a promise that settles in time is never aborted, and existing 3-argument callers keep pure-race semantics unchanged.

`awaitWithFirstCallRetry` was worse: it issued a second `start()` at 16s and never aborted the first, doubling outstanding Alpaca REST calls on every slow poll.  It now runs one `AbortController` per attempt and aborts the loser; on final timeout it aborts both.  A `trackSettled()` helper doubles as a rejection handler so aborting a loser can never surface as an unhandled rejection.

**2. In-flight guards are released by the real work, not the race loser.**  `src/lib/scheduler.ts` attached `.finally` to the **raced** promise with a 15s `BROKER_TIMEOUT_MS`.  The repo's own measurements (`inflight-deadline.ts:5-13`) record 191/500 Alpaca calls at ≥6s, max 14,416ms — so any lane slower than 15s got a fresh duplicate launched on top of it every 60s tick, forever, none aborted.  On the stale-exit lane that meant **duplicate remediation attempts against live orders**.

**3. The tick has a re-entrancy guard.**  `setInterval(tick, 60_000)` awaited multi-minute LLM runs with no guard, while `rag/sec-ingest-worker.ts:44` has carried one and documented why.  `tick()` is now a thin globalThis-pinned wrapper around `tickInner()`, released in `finally`.  Overlapping ticks never duplicated trades (`lastRunAt` advances before launch) — the harm was re-running both sweep lanes and ~60 synchronous SQLite writes per pass, which feeds the event-loop freeze.

## Money-path decisions — what is and is not abortable

**Abortable (idempotent GETs only):** `alpaca.getAccount`, `getPositions`, `getOrders`, `getLatestQuotes`.  These are the only four sites that pass a signal into `trackHealth`.

**Deliberately NOT abortable:** `createOrder`, `cancelOrder`, `replaceOrder`.  An aborted placement may still have reached the broker, and both #2960's HTTP-409 → reconcile-by-refId path and `reconcilePlacementError`'s "absent from list ⇒ not_placed" inference depend on the call actually completing.

This is enforced **structurally** — no signal parameter exists on those paths, so the guards are unreachable there — rather than by a flag someone can later flip.  Also left alone: the `safety-maintenance.ts` and `scheduler.ts` lane wrappers, which contain live-order cancels and replacements.

**A regression this fix would otherwise have introduced:** abandoned attempts were about to write `logApiHealth({ ok: false })`.  That row feeds the consecutive-failure streak that auto-halts autonomy, so a slow-but-healthy broker would have started reading as an outage.  Abandoned attempts now write no health row.

## Where the investigation's premise did NOT hold

**There is no fetch in the Alpaca gateway.**  The instruction was "thread the signal into the broker gateway's fetch."  It uses `axios` inside `@alpacahq/alpaca-trade-api`, whose `httpRequest` accepts no signal.  The obvious workaround is a trap: our `import axios` resolves the ESM build while the SDK's `require("axios")` resolves the CJS build — **different module instances with different interceptor managers**, verified at runtime (`same default object: false`).  And the SDK is not in `serverExternalPackages` (`next.config.mjs:32`), so Next bundles it and any `createRequire` escape hatch would diverge again in the production bundle.

**This was deliberately not shipped.**  A money-path change that silently does nothing in production is worse than no change.  So abandoned Alpaca reads still hold their sockets at the transport layer.  What is fixed is everything above that line: no duplicate connection per abandoned attempt, no transient retry, no false health-failure row.  Filed as #2970 with the real fix (add to `serverExternalPackages`, GET-only interceptor, verified end-to-end against a hanging server **in a production build**).

**Tradier and Robinhood never leaked sockets.**  Both already pass `AbortSignal.timeout` on every fetch (`tradier.ts:347`, `robinhood.ts:636`).  Alpaca's SDK is the only unbounded broker transport in the process — a useful narrowing of the accumulator hunt.

**An existing test encoded the bug as the contract.**  `test/broker-io-deadlines.test.ts` asserted `expect(host.__stopMonitorInFlight.has(key)).toBe(false)` after the deadline while the work was still pending — precisely the duplicate-launch behaviour.  Rewritten to assert the inverse for both lanes.

## Verification State
`tsc --noEmit` exit 0.  `eslint` exit 0 on all 7 changed files (30 warnings, all pre-existing `any`/unused).  52 tests across the 9 affected files.  Separate regression runs, all exit 0: alpaca/broker/tradier 126 tests, dashboard consumers 71, placement + order-path 136, all 9 pre-existing scheduler files 41.

Failing-first proven per fix by reverting real code, unpiped, `$?` checked directly:

| Fix | Reverted result |
|---|---|
| `withDeadline` abort | `expected false to be true` — 1 failed / 14 passed |
| loser abort | 2 failures, both `expected false to be true` |
| Alpaca abandoned-read guard | `expected 4 to be 2` |
| Scheduler guard release | `expected 2 to be 1` — `getEquityOrders` called **twice**, the duplicate cancel-replace |
| Tick re-entrancy | `Test timed out in 60000ms` — the second tick genuinely re-entered |

The Alpaca one is worth recording: the first revert attempt **passed**, because only one of the two guards had been removed and the other still did the work.  Removing both produced `expected 4 to be 2` — each abandoned attempt was opening a fresh connection.

**Honestly flagged:** the second tick test (guard clears via `finally` when `tickInner` throws) is **not** independently failing-first-provable — there was no flag to fail to clear before the fix.  It is a supplementary check, not a proven regression guard.

## Honest scoping — this is not the run-stall fix
The stall's cause is still unsettled and needs one production query (see #2967 and the stall investigation).  This change removes a leaked-work accumulator and a duplicate-launch path against live orders.  Both are real defects worth fixing on their own terms; neither is proven to be what stopped runs completing.

## Next Steps
- #2970 — the Alpaca transport-layer socket fix, unclaimed.
- Future scheduler tests should reset `__tickInFlight` in `beforeEach` (both new test files do) — a test that abandons a pending tick promise would otherwise leave it set for its worker.
