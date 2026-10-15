# 2026-10-15 Honest approve and retryable broker errors

## Context & Objective

ST-2582: Approve was able to look successful when the broker had not accepted an order, and some broker failures that can be retried were not classed as retryable.  The goal is an honest success signal, no second order after a lost response, and compatibility with the Tradier sandbox 400 handling in #4668 and the 16-minute sandbox wait in #4685.

## Changes Made

- `classifyPlaceOrderError` treats timeouts, HTTP 5xx, HTTP 429, Tradier's HTTP 400 "Unexpected server error", and the sandbox open deferral as `retryable`.  Plain HTTP 400 / 403 / 422 stay `rejected_terminal`.
- Timeouts, HTTP 408, HTTP 5xx, and the Tradier sentence must reconcile by refId before `not_placed`.  HTTP 429 and the open deferral still book `not_placed` immediately because nothing reached a live order.
- `isTradierTransientServerError` is unchanged, so a 5xx with the same sentence is not the sandbox-400 adapter retry and broker-health can still halt.
- `POST /api/proposals/[id]/approve` returns HTTP 200 only for a placed / filled / paper outcome.  Every other resolved outcome is HTTP 409 with the structured body.  The console client reads that 409 so a busy lock still retries and the toast stays honest.
- Bulk approve attaches the same `outcome` on each row.  The batch HTTP status stays 200 because the request was processed.

Touched files:

- `src/lib/placement-outcome.ts`
- `src/lib/strategy-execution.ts`
- `src/lib/strategy.ts`
- `app/api/proposals/[id]/approve/route.ts`
- `app/api/proposals/bulk-approve/route.ts`
- `app/console/lib/api.ts`
- `test/placement-outcome.test.ts`
- `test/placement-reconcile.test.ts`
- `test/route-proposals-approve.test.ts`
- `test/console-api-html-error.test.ts`
- `docs/phase-7-strategy.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-10-15-honest-approve-retryable.md`

## Decisions & Trade-offs

HTTP 5xx is retryable for placement booking and still an infrastructure failure for broker-health.  Folding 5xx into `isTradierTransientServerError` would have retried a 500 as the sandbox 400 and would have stopped the halt.  That was not done.

A timeout or 5xx whose order list still shows the refId is booked `placed`.  Booking `not_placed` first would let the next Approve mint a new refId on top of a live order.

The 16-minute sandbox deferral stays a local skip.  It does not consult the broker list.

Price and market-data history is not pruned.

## Verification State

```
npx vitest run test/placement-outcome.test.ts test/placement-reconcile.test.ts test/route-proposals-approve.test.ts test/console-api-html-error.test.ts test/broker-health-auto-pause.test.ts test/mobile-placement-command.test.ts
```

6 files, 64 tests, all passed.

```
npm run lint
```

Exit 0.  0 errors, 854 warnings (the existing grandfathered backlog).

```
npx tsc --noEmit
```

Exit 0.

```
npm test
```

Exit 1.  9385 passed, 51 skipped, 24 failed.  The failures are outside this diff: LLM key resolution (`chat-llm`, `llm-provider`, `framework-review`, `openrouter-credits`, `red-team`) sees a sandbox OpenRouter key, plus `alpha-vantage-key-pool`, `data-providers`, `cpuprofile-summary` (Node 22 loading a `.ts` script), `notify-body-tiers`, `notify-user-creds`, `persistence-notification`, and `server-metrics` (`usesLocalHost`).  None of those files were edited.

```
npm run build
```

Exit 0.

## Next Steps & Blockers

Open the PR ready for review with `do-not-automerge`.  Do not enable auto-merge.  Jay squash-merges.  If a Kody thread cannot be fully addressed, reply `defer` and leave it open.

## Zero-Code Findings

Agent-Sync MCP Linear tools are not enabled for the CURSOR seat (`LINEAR_SEATS`).  The claim and the PR link use the `board` CLI as the CURSOR Linear app, which is the same workspace identity.
