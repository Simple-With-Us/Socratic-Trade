# 2026-06-21 — Full-filing RAG ingestion (10-K / 10-Q bodies)

## Summary

Implements the "analytical body" layer of the SEC filing RAG pipeline: fetches 10-K and 10-Q
primary documents from EDGAR, strips them to plain text, chunks them through the existing
`storeDocument` → `chunkDocument` → `storeContexts` path, and de-dups via a new
`ingested_accessions` SQLite table. Companion admin backfill route at
`POST /api/admin/reindex-10k`.

The 8-K "catalyst flag" path in `sec8k.ts` is completely unchanged. Free-tier operators
(default `VECTOR_EMBED_BATCH_DELAY_MS=21000`) see no behavior change — the body ingest gate
is off until a paid Voyage key is set (delay ≤ 5000ms). The `isFilingIngestDue` check runs
on a weekly TTL so a free-tier scheduler tick is always a cheap no-op.

## Why

Design doc `docs/design/full-filing-rag.md` + owner decisions (2026-06-21):
- Build the body ingest path so paid operators can trigger a backfill immediately.
- Use the existing dead `storeDocument` scaffolding rather than a new write path.
- De-dup at the accession level to prevent multi-minute re-embedding on scheduler retries.
- Gate all writes behind `scope:'shared'` (userId='local') — app-funded corpus, no per-user identity needed.
- Enforce 1-filing/tick cap on free tier to prevent hour-long scheduler stalls.

## Owner-resolved decisions applied verbatim

1. No auto-backfill on first run — incremental, newest-first, 1 filing/tick on free tier.
2. Free-tier cap of 1 filing/tick: confirmed.
3. Recency window: 1 most-recent 10-K + 2 most-recent 10-Qs per symbol (limitPerType=2 default).
4. `loadCikMap` exported from `sec8k.ts` as a named export (single character change).
5. `scope:'shared'` forced on all corpus writes (userId='local' → `cleanMetadata` → `scope:'shared'`).
6. Gate body ingest behind paid Voyage key signal; free-tier default leaves 8-K path untouched.
   Bodies route through existing `storeDocument`/`chunkDocument`. `ingested_accessions` table added.
   `acceptance_datetime` / `doc_type` / `section` carried by `chunkDocument` automatically.
   Point-in-time test for `isWithinAsOf` added and passing.
   Slice lands WITHOUT a Voyage key — skips body ingest until one is provided.

## Files touched

| File | Change |
|------|--------|
| `src/lib/web-sources/sec8k.ts` | Export `loadCikMap` (was private) |
| `src/lib/db.ts` | Add `ingested_accessions` table to `migrate()` block; add `hasIngestedAccession`, `insertIngestedAccession`, `listIngestedAccessions` helpers |
| `src/lib/web-sources/sec-filings.ts` | **New.** `FilingRef`, `parseRecentFilings`, `padCik`, `normalizeAccession`, `accessionNoDashes`, `fetchRecentFilings`, `fetchFilingHtml`, `extractFilingText`, `ingestFiling`, `isFilingIngestDue`, `refreshFilingBodies` |
| `src/lib/web-sources/index.ts` | Import + re-export `refreshFilingBodies`, `isFilingIngestDue`, `FilingRef`, `IngestResult`, `RefreshFilingBodiesResult` |
| `src/lib/scheduler.ts` | Import `listWatchlistSymbols`, `symbolsForPolicyUniverse`, `isFilingIngestDue`, `refreshFilingBodies`; wire weekly filing ingest into `tick()` |
| `app/api/admin/reindex-10k/route.ts` | **New.** `GET` (status + recent accessions) and `POST` (backfill trigger) admin route |
| `test/sec-filings.test.ts` | **New.** 25 tests: parsers, de-dup (real SQLite), ingest paths, free-tier cap, `isWithinAsOf` point-in-time guard |
| `docs/rollouts/2026-06-21-full-filing-rag.md` | This file |

## Verification

```
cd /Users/jay/apps/wt-rag2

npx tsc --noEmit
# → no output (clean)

npm test
# → 72 test files, 618 tests, all passed
# sec-filings.test.ts: 25/25 passed
```

## Follow-ups / deferred

- **Voyage paid key required for backfill**: set `VECTOR_EMBED_BATCH_DELAY_MS=0` and call
  `POST /api/admin/reindex-10k` with `{ "symbols": ["AAPL", ...] }` to trigger.
- **XBRL viewer fallback**: if the primary document is an iXBRL viewer wrapper rather than
  raw HTML, `extractFilingText` returns < 100 chars and `ingestFiling` returns an error.
  A fallback to the filing index `.htm` is a follow-up (flagged in design doc risk §4).
- **8-K body ingest** (design doc §3.4 "later" label): deferred — separate decision needed
  since it widens scope significantly.
- **Chunk-level content_hash dedup**: deferred by owner decision; filing-level de-dup is sufficient.
- **`runRateLimited` wrapping for filing body fetches**: currently uses `sleep()` between filings
  inside `refreshFilingBodies`; EDGAR CIK-submissions fetches already use `runRateLimited`. Both
  respect the 300ms polite cadence — no throttle risk at the 1-filing/tick free-tier cap.
