# Codex Autofix Round 7 — PR #1493

**Date:** 2026-07-14
**Branch:** `ag/troubleshoot-sentry`
**PR:** #1493 — Add clearCache option to admin reindex endpoint

## Summary

Addressed 4 remaining P2 Codex findings from the round-6 review.

## Changes

### 1. Preserve `filed_at` in `insertIngestedAccession`

**File:** `src/lib/db-learning.ts` (function `insertIngestedAccession`)

Previously, `insertIngestedAccession` always called `insertSecFiling({ filedAt: now, acceptedAt: now, ... })`, which `ON CONFLICT DO UPDATE` would overwrite the real SEC filing date with the ingest timestamp. The `clearCache` query in the admin route orders `sec_filings` by `filed_at DESC LIMIT 10` to match the set `refreshFilingBodies` will refetch from SEC — but with `filed_at` set to `now` for every row, the query would pick the wrong accessions, leaving cleared-but-not-rebuilt filings permanently missing from the vector store.

Fixed by checking for an existing `sec_filings` row first. If present, only `status` and `chunk_count` are updated (preserving the scraper's original `filed_at`). If absent, a new row is created with the ingest timestamp as before.

### 2. Batch chunk-cache deletes

**File:** `app/api/admin/reindex-10k/route.ts` (clearCache block)

The `DELETE FROM document_chunks` and related operations built one `OR` term per accession. With 51+ tickers × ~20 accessions each, this could exceed SQLite's expression-depth limit (~1000). All accession-based operations (`DELETE FROM ingested_accessions`, `DELETE FROM document_chunks`, `DELETE FROM chunk_occurrences`, `UPDATE sec_filings`) now iterate in batches of 50.

### 3. Limit clears to rebuild capacity

**File:** `app/api/admin/reindex-10k/route.ts` (clearCache block)

When `clearCache` was used with a small explicit `limit` (e.g. `limit: 1`), `accessionsToClear` would contain 20 accessions per symbol but `refreshFilingBodies` would only process `limit` total filings. The extra cleared accessions would remain absent until a later backfill. Added a cap: if `limit` is explicitly set and smaller than `accessionsToClear.size`, only the first `limit` accessions are cleared.

### 4. Clear `chunk_occurrences`

**File:** `app/api/admin/reindex-10k/route.ts` (clearCache block)

`storeDocument` records chunks in both `document_chunks` and `chunk_occurrences`, but the `clearCache` block only deleted from the former. Coverage diagnostics read `chunk_occurrences` and would report stale "present" data after a cache reset. Added `DELETE FROM chunk_occurrences WHERE accession IN (...)` to the clear sequence.

## Verification

```
npx tsc --noEmit    → clean (no errors outside test/ — pre-existing)
npm test             → 360 files / 4024 tests passed
npm run build        → compiled successfully, no errors
```

## Files Touched

- `src/lib/db-learning.ts` — `insertIngestedAccession` preserves existing `filed_at`/`accepted_at`
- `app/api/admin/reindex-10k/route.ts` — batched deletes, limit capping, `chunk_occurrences` cleanup
- `STATUS.md` — added round 7 entry
- `docs/rollouts/2026-07-14-codex-autofix-1493-round7.md` — this note

## Follow-ups

- All P2 findings on this PR are now addressed. PR can proceed to squash-merge after CI passes.

## Resolved Threads

All 4 remaining P2 threads from the latest Codex review resolved:
- "Select cache-reset filings from the actual SEC window"
- "Batch chunk-cache deletes for broad reindexes"
- "Limit clears to filings this run can rebuild"
- "Clear chunk occurrences with the chunk ledger"
