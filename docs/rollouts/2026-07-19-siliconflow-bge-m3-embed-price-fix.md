# 2026-07-19 — Fix SiliconFlow bge-m3 embed price 10x undercount (MONET)

## Summary

One-constant correctness fix in `src/lib/rag-metering.ts`. The SiliconFlow embed price
for `BAAI/bge-m3` was coded as `0.00001 / 10` (= `0.000001`), 10x smaller than its own
comment's stated `$0.01 per 1M tokens = $0.00001 per 1K tokens`. Corrected the literal to
`0.00001` and pinned the exact cost in `test/rag-metering.test.ts` so it can't drift again.

## Why

- `SILICONFLOW_PRICE_PER_1K_TOKENS["BAAI/bge-m3"].embed` feeds `estimateRagCost()`, which
  writes `rag_usage.cost_est_usd` and backs the local $/day dispatch fuse
  (`maxEstimatedCostUsdPer24h`). At `0.000001` it undercounted SiliconFlow bge-m3 embed spend
  by 10x whenever SiliconFlow is the active RAG embed provider.
- The intended rate is corroborated three ways: (1) the line's own comment; (2) the parallel
  `OPENROUTER_EMBED_PRICE_PER_1K_TOKENS["baai/bge-m3"] = 0.00001` (same model, same
  `$0.01/1M` rate, confirmed on openrouter.ai and already unit-tested); (3) SiliconFlow's
  published bge-m3 embed price (~$0.01/1M tokens). The `/ 10` was a typo — removed.
- Pre-existing: introduced in `74958124f` (2026-07-17); the later bge-m3-metering-gate work
  (`39ca9ad6`) left the line untouched. No live billing/budget-fuse discrepancy has occurred
  because OpenRouter — not SiliconFlow — is prod's active RAG embed provider as of the
  2026-07-18 bge-m3 flip; this fix hardens the SiliconFlow path before it is ever activated.

## Files

- `src/lib/rag-metering.ts` — `BAAI/bge-m3` embed rate `0.00001 / 10` → `0.00001`; comment
  clarified to cross-reference the OpenRouter table.
- `test/rag-metering.test.ts` — the SiliconFlow embed test now pins the exact
  `costEstUsd` (`toBeCloseTo((tokens * 0.00001) / 1000, 12)`) instead of only asserting
  `> 0` (which could not catch a 10x error), mirroring the OpenRouter embed test.
- `STATUS.md` — snapshot entry.

## Verification

- `npx tsc --noEmit`: clean (exit 0).
- `npx vitest run test/rag-metering.test.ts`: 11/11 pass with the fix.
- **Regression guard proven**: temporarily reverting the constant to `0.00001 / 10` makes the
  new assertion FAIL (`expected 8e-9 to be close to 8e-8, difference 7.2e-8`) — i.e. it
  catches exactly the 10x error; restoring `0.00001` passes.
- `npx eslint src/lib/rag-metering.ts test/rag-metering.test.ts`: 0 errors (2 pre-existing
  warnings in the test file, unrelated to this change).
- Full `npm test` + `npm run build` run in the required `verify` CI gate; a pricing constant +
  test change cannot affect the build.

## Follow-ups

- None. If SiliconFlow bge-m3 pricing changes, update the single table entry + the pinned test.
