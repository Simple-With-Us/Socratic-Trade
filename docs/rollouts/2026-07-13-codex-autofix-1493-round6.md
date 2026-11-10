# Codex Autofix Round 6 — PR #1493

**Date:** 2026-07-13
**Branch:** `ag/troubleshoot-sentry`
**PR:** #1493 — Add clearCache option to admin reindex endpoint

## Summary

Addressed 1 P2 Codex finding from the round-5 review:

1. **Restrict sec_filings reset to refetched filings** — Previously, when `clearCache` was used, it would clear all metadata/chunks for a ticker. However, since the subsequent ingest only fetches the latest 10 filings per type, any older filings for that ticker would remain marked as `discovered` but never re-ingested, leaving them permanently missing from the vector database. We updated the `clearCache` logic in `app/api/admin/reindex-10k/route.ts` to identify and target only the latest 10 filings of each form type (10-K and 10-Q) per symbol, matching the SEC Edgar recent window retrieval limit.

## Change

**File:** `app/api/admin/reindex-10k/route.ts`

- Updated the `clearCache` block to query the latest 10 accession IDs per type from both legacy `ingested_accessions` and new `sec_filings` tables.
- Scoped the `DELETE FROM ingested_accessions`, `DELETE FROM document_chunks` (using `chunk_id LIKE`), and `UPDATE sec_filings` statements to target only these specific accession IDs.

**File:** `test/reindex-10k-clear-cache.test.ts` [NEW]

- Added a comprehensive integration test ensuring that only the latest 10 completed filings of each form type are downgraded/cleared, and older completed filings/chunks remain intact.

## Verification

```bash
npx tsc --noEmit                                    # clean (0 errors)
npx vitest run test/reindex-10k-clear-cache.test.ts # passed (1 test)
npm run lint                                        # clean (0 errors, 450 warnings)
```

## Files Touched

- `app/api/admin/reindex-10k/route.ts` — scoped cache clearing to the latest 10 filings of each type per symbol
- `test/reindex-10k-clear-cache.test.ts` — new test verifying the cache-clearing scoping logic
- `docs/rollouts/2026-07-13-codex-autofix-1493-round6.md` — this note

## Resolved Threads

One P2 thread resolved:
- "Restrict sec_filings reset to refetched filings" (`PRRT_kwDOS7mOVM6Qbx-8`)
