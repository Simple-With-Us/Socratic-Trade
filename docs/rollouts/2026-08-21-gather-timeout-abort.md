# 2026-08-21 — Abort abandoned strategy gather + last-good tape

## Context & Objective

Owner asked why every strategy run failed today.  The production ops snapshot at 2026-08-21T19:18Z showed Roth IRA and Alpaca Paper failing all morning and afternoon with `strategy gather timeout` after both completed the prior close.  This change stops abandoned gathers from stacking and lets Green start from the last completed tape when a live scan cannot finish in 8 minutes.

## Changes Made

The 8-minute gather deadline was a pure `Promise.race`.  When it fired, `runStrategyOnce` marked the run failed and the next account started another full `scanMarket` + quote cascade while the abandoned Nasdaq/enrichment/broker walk kept its sockets and the event loop.  Roth and Paper cadence overlap turned that into an all-day pile-up.  `market-scan-freshness` (avg 115s, max 66m on the same process) is the same scan competing for the loop.

`gatherStrategyMarket` now passes an `AbortController` into `withDeadline`, threads that signal through `scanMarket` enrichment and `fetchFreshQuotesCascade` levels, and if the live scan still times out reuses `newestPersistedMarketScan` (real last tape) plus a 45s quote refresh.  No last-good row still fails the run.  The run audits `strategy_gather_used_last_good`.

The first revision dropped the signal on the keyed/scarce enrichment waves (`paidContext` / `scarceContext` were `{ coveredFields }` only).  That is the Finnhub wave — 5 paced free-tier calls per symbol at ~1.2s — so an 8-minute abort left the queue running and the next account stacked another scan.  Keyed/scarce now keep `signal`, Finnhub `getJson` combines it with the 6s per-call timeout, and `scanMarket` rethrows an aborted enrich instead of swallowing it as "Enrichment failed."  Wave B is keyed (has an API key).  Owner has no paid Finnhub account; Finnhub stays on the free 60/min key, paced at 50/min.

- `src/lib/strategy-gather.ts` (new)
- `src/lib/strategy.ts`
- `src/lib/quotes-cascade.ts`
- `src/lib/market.ts`
- `src/lib/data-providers.ts`
- `test/strategy-gather.test.ts` (new)
- `test/enrichment-abort.test.ts` (new — keyed-wave signal)
- `src/lib/data-catalog.ts` (Finnhub notes: keyed Wave B, not a paid plan)
- `test/quotes-cascade.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-21-gather-timeout-abort.md`

## Decisions & Trade-offs

Did not raise the 8-minute cap.  A longer deadline would let zombies run even longer.  Did not skip connected brokers in cascade 1b (Robinhood/Tradier/Public still contribute market data).  Last-good is yesterday's completed scan, not a fabricated book; the scan warning names the seed timestamp.  Did not HOTFIX during regular hours — Coolify stays on the RTH latch; this lands after the cash close with the rest of `main`.  Did not rename the `costTier: "paid"` enum (that still means "has an API key"); owner-facing copy for Wave B is now "keyed".

Live sha at diagnosis was `e0a4959a73a7` (process start 19:06Z), already containing #2852 and #2854.  Those fixes were not the miss.  Weekly screens (#3009) are on `main` and not live yet.

## Verification State

```
npm run lint                          # 0 errors (774 grandfathered warnings)
npx tsc --noEmit                      # clean
npx vitest run test/strategy-gather.test.ts test/quotes-cascade.test.ts test/inflight-deadline.test.ts test/enrichment-abort.test.ts
                                      # 37 passed
npm run build                         # Next.js production build succeeded
```

Full `npm test` in this Cloud VM still hits pre-existing env flakes: `rag-doc-type-coverage` wants `emptyDocTypes === ["10-k"]` but the earnings-transcript producer is on here; `usage-compliance-classifier` Massive telemetry when `MASSIVE_API_KEY_ALT` is set; `strategy-held-position-retrieval-scope` 30s budget around a live `scanMarket` enrich.  None of those are the gather-abort contract.  CI `verify` is the merge gate.

Owner rematch of `origin/main` (`2e2c3286`, #3008 / #3019) committed leftover `<<<<<<< HEAD` markers in this Verification block.  Resolved to the recorded local-gate commands (no fabricated `npm test` pass).

## Next Steps & Blockers

1. Do not HOTFIX or bounce Coolify during weekday RTH.  After-close drain should move live sha past this merge.
2. After deploy, confirm the next Roth/Paper run is `completed` or `strategy_gather_used_last_good` rather than another gather timeout.
3. `market-scan-freshness` max 66m is still a load smell.  Separate from this gather abort.

## Zero-Code Findings

Ops snapshot (no code required to see this):

- Scheduler last tick 19:17:03Z, age 76s — autonomy is ticking.
- LLM keys configured; models `__rotate__` / OpenRouter.
- Last completed: Roth 2026-08-20T20:16:11Z, Paper 2026-08-20T20:22:57Z.
- Today: every listed run `failed · strategy gather timeout` except process-restart stale-run sweeps at 15:11Z, 15:40Z, 17:06Z, 18:05–18:06Z.
- Paper `consecutiveFailedRuns` 27, Roth 12, `tradingLivenessDegraded` true.
- Dependencies including OpenRouter/Yahoo/congress.trade all `ok`.
- Pinecone trial still active; WU breaker not latched.
