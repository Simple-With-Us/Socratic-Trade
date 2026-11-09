# Codex Autofix Round 3 — PR #1493

**Date:** 2026-07-13
**Branch:** `ag/troubleshoot-sentry`
**PR:** #1493 — Add clearCache option to admin reindex endpoint

## Summary

Addressed 2 remaining P2 Codex review findings from the latest `chatgpt-codex-connector[bot]` review on PR #1493.

## Changes

### 1. Skip empty fundamentals cards before embedding

**File:** `src/lib/web-sources/sec-filings.ts` (function `ingestFundamentalsCard`)

Added a `hasRealField` check after fetching enrichment data. When the enrichment cascade returns an object with no usable fields (all `N/A`) — e.g. for an unsupported ticker or when every provider was skipped by quota/circuit breaker — `CascadingEnrichmentProvider` still returns an object for that symbol. Previously the truthiness check `if (!data)` passed and code embedded a full "Fundamentals" card whose metrics were all `N/A`, wasting embedding budget and polluting RAG with empty factual content.

The check now verifies at least one of `companyName`, `sector`, `industry`, `peRatio`, `eps`, or `price` is non-null before proceeding to `storeContexts`. If all are null, the function returns `{ skipped: true, error: "Empty fundamentals data ..." }`.

**Decision:** The check is scoped to fields that are commonly populated even with minimal provider data. `companyName` alone covers most real enrichments; the other fields provide a safety net for edge cases where the cascade returns a real object but the company name field happens to be empty.

### 2. Clear `sec_filings` completion rows during `clearCache`

**File:** `app/api/admin/reindex-10k/route.ts`

When `clearCache` is used after a Pinecone reset, the previous code deleted only from `ingested_accessions` and `document_chunks`. However, `hasIngestedAccession()` (in `src/lib/db-learning.ts`) checks `sec_filings WHERE status = 'complete'` *before* falling back to the legacy `ingested_accessions` table. So after a Pinecone reset + clearCache, the operator could not reindex the same filings because `hasIngestedAccession` returned `true` due to the still-extant `sec_filings` completion rows.

The fix adds an `UPDATE sec_filings SET status = 'discovered'` for the affected symbols' rows where `form IN ('10-K', '10-Q') AND status = 'complete'`. This reverts the status to the initial state, allowing the next `refreshFilingBodies` run to treat those accessions as un-ingested.

## Verification

```
npx tsc --noEmit    → clean (0 errors)
npm test             → 350 files / 3930 tests passed
npm run build        → compiled successfully, no errors
```

## Files Touched

- `src/lib/web-sources/sec-filings.ts` — added empty-fundamentals guard in `ingestFundamentalsCard`
- `app/api/admin/reindex-10k/route.ts` — added `UPDATE sec_filings` in the `clearCache` block
- `STATUS.md` — added this round's entry
- `docs/rollouts/2026-07-13-codex-autofix-1493-round3.md` — this note

## Follow-ups

- PR #1495 (`agent/ag-rag-backfill-p0`) still has 1 unresolved Codex thread (parse numeric budget envs before reporting).

## Resolved Threads

Both P2 threads from the latest Codex review (2026-07-13T04:05:40Z) resolved:
- "Skip empty fundamentals cards before embedding"
- "Clear sec_filings completion rows too"
