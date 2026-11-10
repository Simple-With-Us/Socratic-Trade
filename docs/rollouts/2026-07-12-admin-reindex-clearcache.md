# 2026-07-12 — Add clearCache support to admin reindex endpoint (Antigravity)

## Summary
Added support for a `clearCache: true` option in the `POST /api/admin/reindex-10k` request body. When set, this option deletes all records in the local SQLite `ingested_accessions` and `document_chunks` cache tables. This allows a clean backfill run into a fresh Pinecone database without the local cache incorrectly skipping filings.

## Why
The new `socratic-trade` Pinecone database was empty of filings, but the local SQLite database had grandfathered `112` document chunks recorded from previous test runs. Because of content-hash and accession-level de-duplication, the backfill was falsely skipping these records. Clearing the cache aligns the database metadata with the empty state of the new Pinecone index.

## Files
- `app/api/admin/reindex-10k/route.ts` [MODIFY]
- `docs/rollouts/2026-07-12-admin-reindex-clearcache.md` [NEW]

## Post-hoc fix (2026-07-12, codex-autofix PR #1493)

Codex review flagged two P2 issues:

1. **Unscoped DELETE**: The `clearCache: true` code was `DELETE FROM ingested_accessions` and `DELETE FROM document_chunks` (full table truncation), even when only a few symbols were requested. Scoped to `DELETE FROM ingested_accessions WHERE ticker IN (?)` and `DELETE FROM document_chunks WHERE symbol IN (?)` using the same placeholder list.

2. **Unnormalized symbols**: The raw request-body symbols were used directly. Since `refreshFilingBodiesUnlocked` silently skips tickers not in the CIK map (e.g. lowercase "aapl"), an invalid/typo ticker could clear unrelated cache entries without repopulating. Added `normalizeSymbol()` (`.trim().toUpperCase()`) and dedup (Set) when parsing the `symbols` array.

## Second codex-autofix round (2026-07-12, three more P2 threads)

Codex review flagged three more P2 issues after the first autofix round:

1. **Use chunk canonicalization when clearing chunks** — `normalizeSymbol` keeps hyphens (`BRK-B`), but `canonicalTicker` strips them (`BRKB`), and `insertDocumentChunks` stores the canonical form. `DELETE WHERE symbol IN ('BRK-B')` missed rows stored under `BRKB`. Fix: also include the hyphen-free (canonical) form when deleting from `document_chunks`.

2. **Restrict clearCache deletes to 10-K/10-Q artifacts** — the deletes were symbol-scoped but not doc-type/source-scoped, so `clearCache: true` on `AAPL` also purged `8-K-body` accessions and `sec-8k` chunks. Fix: add `AND (doc_type = '10-K' OR doc_type = '10-Q')` on `ingested_accessions` and scope `document_chunks` to `source = 'sec-edgar'`.

3. **Clear globally owned content hashes for the target filing** — `document_chunks` is dedup-keyed by `content_hash` globally. A content_hash first recorded under another symbol's filing (e.g. shared boilerplate) survived a symbol-scoped DELETE, so `filterNewDocumentChunks` skipped the chunk on reindex after a Pinecone reset. Fix: use a subquery — find all content_hashes belonging to the target symbols' sec-edgar chunks, then delete every `document_chunks` row with those hashes regardless of the symbol on the individual row.

### Files
- `app/api/admin/reindex-10k/route.ts` [MODIFY]

### Verification
- `npx tsc --noEmit`: clean
- `npm test`: 350 files, 3927 tests passed
- `npm run build`: clean
- `npm run lint`: 0 errors
- All three Codex threads resolved
