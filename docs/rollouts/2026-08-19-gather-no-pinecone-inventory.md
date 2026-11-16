# 2026-08-19 — Gather must not inventory Pinecone or latch on 502/429

## Context & Objective

Same Roth Manual Run once `9d71dda4-1383-4a27-814c-fd80fa44e314` as #2852/#2853.  Robinhood `too many symbols (max 10, got 250)` at 00:59:15Z (+18s) remains the first hard fail.  The same window also listed/fetched the whole Pinecone index, 502'd congress.trade, and 429'd Massive.  There was no OpenRouter strategy/completion call — only run-scoped `usage_budget_status` at +10s, then the crash.  Green never started.  Fold in the Robinhood ≤10 chunk; do not replace it.

2026-08-20 rebase: #2854 was CONFLICTING/DIRTY against later `origin/main` while Jay lands open issue PRs.  Rebased onto `eefc4f82`.  The only real conflict was `test/roic-transcripts.test.ts` vs #2813.  Kept this PR's `shouldSkipWholeIndexInventory` test and main's `planRoicSymbolWork` skip-covered test.  Did not absorb #2813 product.  Did not open a second PR.  Did not merge.

## Changes Made

Gather retrieval stays query/id scoped (`retrieveContextDetailed`).  Whole-index Pinecone `listPaginated` + `fetch` is paused while any strategy run/request is queued or running.  Account deletion still inventories so erasure can finish.  congress.trade 502 and Massive 429 fail-open: they must not latch the enrichment wave or skip Green.

- `src/lib/db-execution.ts`
- `src/lib/scheduler.ts`
- `src/lib/vector-db.ts`
- `src/lib/data-providers.ts`
- `src/lib/api-clients/congress.ts`
- `test/scheduler-managed-vector-reconcile.test.ts`
- `test/roic-transcripts.test.ts`
- `test/data-providers.test.ts`
- `test/api-clients-congress.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-19-gather-no-pinecone-inventory.md`

## Decisions & Trade-offs

- Folded in #2852 (`c7b775c5`).  Did not rewrite Robinhood chunking.
- Did not flip `RAG_PINECONE_WRITE_CLASS`.  Did not prune the live index.  Did not reopen #2840.
- Scheduler reconcile does not consume `lastAttempt` when a run is in flight, so the next idle tick can still inventory.
- Inventory aborts between pages if gather starts mid-pass.  Partial inventory is not returned as a complete index (throws / skipped).
- Legacy short-circuit no longer awaits App A alone.  Paid providers on that off-path run without an App A coverage hint (free-first, default ON, still uses the two-wave planner).
- Massive 429: `retries: 0`, suppress health, stop remaining symbols this enrich call.  A 404 stays a miss.
- Did not touch #2850 / #2849 / #2841 / #2856 / #2857.  Did not merge, deploy, bounce, or TF.
- Rebase vs later main: `git merge-tree --write-tree origin/main HEAD` exited 0.  Overlap was `STATUS.md` / `PLAN.md` / `docs/EFFORT-LOG.md` only.  No iOS files.  Rebase onto `ce31c367` applied clean (5/5).

## Verification State

```bash
npx vitest run test/data-providers.test.ts -t "does not latch gather|stops remaining symbols|treats 502|does not fail the free wave"
npx vitest run test/scheduler-managed-vector-reconcile.test.ts test/roic-transcripts.test.ts test/api-clients-congress.test.ts test/robinhood-mcp.test.ts
npx tsc --noEmit
npm run lint
npm run build
```

Focused receipts (re-run after rebase onto `52add2ae`, HEAD `0cb36527`): gather/502/429/404 tests 5/5; scheduler-managed-vector-reconcile + roic-transcripts + api-clients-congress + robinhood-mcp 58/58 (Robinhood ≤10 chunk kept).  `npx tsc --noEmit` clean.  `npm run lint` exit 0 (0 errors, grandfathered warnings).  `npm run build` compiled and finished TypeScript.  `gh pr view 2854` is `MERGEABLE` (no longer CONFLICTING/DIRTY); `verify-hosted` was still in progress at push.  Full `npm test` was started on the pre-rebase tree; it hung after unrelated `notify-body-tiers` / `server-metrics` env misses and 30s `strategy-rationale-collapse-gate` timeouts (those tests hit live HTTP 404s).  Isolated collapse-gate still 30s-times out on this VM; not a write-class or prune change.

## Next Steps & Blockers

- Do not merge / deploy / bounce from this seat.
- Confirm live gather reaches Green/`llm_usage` after this lands.  Robinhood max-10 at +18s was the first hard fail; this PR removes the remaining same-window latches.
- Do not inventory the live index by hand.  Do not flip write-class.

## Zero-Code Findings

`usage_budget_status` at +10s means `runStrategyOnce` passed rotation/budget advisory before scan.  Zero completion `llm_usage` means Green/`proposeTrades` never ran.  The thousands of Pinecone list/fetch were whole-index inventory (`managed-vector-reconcile` / `inventoryVectorRecordsByMetadata`), not gather query retrieve.
