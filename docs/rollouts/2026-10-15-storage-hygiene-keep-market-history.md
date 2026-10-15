# Storage hygiene: keep market-data history forever

## Context & Objective

PR #4666 merged a storage-hygiene lane that deleted `history_cache_eod` rows older than 400 days.  Owner policy forbids deleting any price or market-data history by age.  This change removes market-data tables from hygiene retention targets and adds a hard guard so they cannot be pruned by this lane.

## Changes Made

- `MARKET_DATA_HISTORY_TABLES` plus `isMarketDataHistoryTable()` refuse DELETE on price, fundamentals, filings, transcripts, SEC facts, and document-chunk tables (including `document_chunks_fts*`).
- Removed `history_cache_eod` and `symbol_field_latest` from `RETENTION_TARGETS`.
- Tests assert market-data tables are never retention targets and `assertPruneTableAllowed` rejects them.

**Files**

- `src/lib/sqlite-storage-hygiene.ts`
- `test/sqlite-storage-hygiene.test.ts`
- `docs/rollouts/2026-10-15-storage-hygiene-keep-market-history.md`
- `STATUS.md`

## Decisions & Trade-offs

- `embed_stage` and `sec_ingest_task_attempts` stay on retention (operational staging/logs, not corpus content).
- `enrichment_coverage_*` stays on retention (operational coverage reports, not fundamentals snapshots).

## Autofix round 1 (2026-10-15) — `categoryFor` mislabeling

Kody flagged on #4683 that the market-data-history branch in `categoryFor` was hoisted ahead of
`CATEGORY_BY_TABLE` and forced `"quote_bar_cache"` on SEC filings/facts, fundamentals, transcripts,
and `document_chunks*` — stripping the retrieval-corpus tables of their existing `"embeddings"`
label and filing filings under a price-cache bucket they do not belong to.

Fixed by consulting `CATEGORY_BY_TABLE` first (so `document_chunks` stays `"embeddings"` and
`history_cache_eod`/`symbol_field_latest` stay `"quote_bar_cache"`), then falling back to a new,
distinct `"market_data_history"` member of the `StorageCategory` union rather than reusing the
price-cache label.  Kody's alternative suggestion — deleting the branch outright — was rejected: it
would have dropped the market-data distinction from the report instead of correcting it.

The category is display-only (it reaches the ops snapshot as JSON and has no UI label map), so this is
a reporting correction with no effect on what the hygiene lane deletes.  Regression assertions now
pin all six labels in `test/sqlite-storage-hygiene.test.ts`.

## Verification State

```bash
npx tsc --noEmit                       # ok
npm run lint                           # 0 errors, 854 warnings (known backlog)
npx vitest run test/sqlite-storage-hygiene.test.ts   # 15/15
npm test                               # 9383 passed, 51 skipped, 13 failed
npm run build                          # ok
```

The 13 failures are in `test/llm-provider.test.ts`, `test/openrouter-credits.test.ts`,
`test/chat-llm.test.ts`, and `test/framework-review.test.ts`, and are pre-existing and unrelated to
this diff: they reproduce identically with these changes stashed (verified on a clean tree).  This
sandbox resolves an `OPENROUTER_API_KEY` into the LLM-provider tests, so the "no OpenRouter key"
fixtures do not hold.  Hosted CI `verify` is green on the branch.

## Next Steps & Blockers

- Owner: squash merge with `do-not-automerge` (touches prod delete path semantics).  No data restore for rows already deleted by #4666 unless a separate backfill is planned.
