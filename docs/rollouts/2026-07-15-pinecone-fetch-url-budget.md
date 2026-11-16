# Pinecone fetch: batch by URL length, not just id count

**Date:** 2026-07-15
**Seat:** CLAUDE (Fable)
**Branch:** `claude/pinecone-fetch-url-budget`

## Summary

Fixed a production RAG error — `Pinecone connection failed … inventory fetch: An unexpected error
occurred while calling the …/vectors/fetch?ids=occ%3Av3%3A…` — caused by oversized fetch request
URLs.

## Why

`index.fetch({ ids })` issues an HTTP **GET** with every id URL-encoded into the query string
(`?ids=…&ids=…`). The fetch batch size defaulted to **100 ids** (`options.batchSize ?? 100`). That
was fine for the short ids in the default Pinecone namespace, but the **managed occurrence ids**
(`occ:v3:<ledger>:<provider>:<tenant>:<source>:<64-char hash>`) are ~150 chars each — ~180 chars
once URL-encoded. A batch of 100 managed ids builds an ~18 KB request URL, which Pinecone (or its
edge) rejects, surfacing as the opaque "unexpected error".

This only began firing after the 2026-07-15 ledger-authority fix (`951fe45c`): before that the
managed vector ledger authority could never mint, so no `occ:v3:` managed vectors existed to be
listed and fetched. Once the authority minted and managed vectors were written, the inventory /
reconcile / stability-verify paths started fetching them by id and hit the URL-length ceiling.

## Fix

`src/lib/vector-db.ts`:
- Added `fetchIdChunks(ids, maxCount)` — chunks fetch ids by an **encoded-URL-length budget**
  (`PINECONE_FETCH_ID_URL_BUDGET = 3500` chars, headroom under a ~4 KB URL) **and** the existing
  count cap, so both short and long ids stay under the limit. A single unavoidably-long id still
  yields its own batch (never an empty batch).
- Switched all four `index.fetch({ ids })` call sites to `fetchIdChunks` (the metadata fetch, the
  "inventory fetch", the committed-record existence check, and the private-vector stability
  verify). Upsert/delete loops keep `chunks` — they send ids in the POST body, not the URL, so
  they were never affected.

## Verification

- `npx tsc --noEmit` clean.
- New `test/vector-fetch-id-chunks.test.ts` (5 tests): every multi-id batch stays under the URL
  budget; long managed ids batch far below the count cap; short ids still honour the count cap;
  order preserved / no ids lost; single oversized id and empty input handled.
- Adjacent vector suites green (52 tests across fetch-chunks, ledger-authority, document-receipts,
  scope).

## Files

- `src/lib/vector-db.ts`
- `test/vector-fetch-id-chunks.test.ts`

## Follow-ups

- None. The budget is conservative (3.5 KB of ids under a ~4 KB URL). If Pinecone's URL limit is
  ever confirmed higher, the budget can be raised, but there is no need.
