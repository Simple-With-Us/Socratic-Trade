# 2026-07-06 — Server-side point-in-time (as-of) filtering in Pinecone (server-asof-filter)

Agent: CLAUDE. Worktree `~/apps/trading-wt-asof-server`, branch
`claude/server-asof-filter` off `origin/main@b76b11ae`.

## Summary

Push the point-in-time (`asOf`) constraint INTO the Pinecone query so `topK` is filled with
ELIGIBLE (pre-`asOf`) candidates, instead of the previous behavior where the pure-vector top-K is
fetched with NO date filter and the post-fetch `isWithinAsOf` guard then decimates it.

Three additive pieces, all gated so default behavior is byte-identical to before:

1. **Ingest epoch write** — `cleanMetadata` (`src/lib/vector-db.ts`) now additively derives a NUMERIC
   `as_of_epoch_ms` (integer ms) from the SAME precedence the post-fetch guard uses
   (`acceptance_datetime -> published_at -> as_of -> timestamp`, via a shared `resolveAsOfEpochMs`
   helper), and writes it to every newly-upserted vector's metadata. Written ONLY when a date
   resolves — undated docs leave the field ABSENT (NaN-safe). Absence is the fail-open signal. A
   caller-supplied `as_of_epoch_ms` is ignored (skip-list) so the derivation stays authoritative.

2. **Query server-side filter** — when `options.asOf` is set AND `VECTOR_ASOF_SERVER_FILTER=on`, a
   server-side epoch clause (`buildAsOfEpochFilter`) is AND-combined (`mergeAsOfEpoch` -> `$and`)
   with the existing symbol/scope/docType filter, on BOTH the shared-tier and user-tier queries.
   - FAIL-OPEN (default): `$or: [{as_of_epoch_ms:{$lte:X}}, {as_of_epoch_ms:{$exists:false}}]` — keep
     epoch'd-and-eligible OR un-epoch'd vectors, so an un-backfilled corpus is NOT dropped.
   - FAIL-CLOSED (`VECTOR_ASOF_STRICT=on`): `{as_of_epoch_ms:{$lte:X}}` (no `$exists` branch) — drop
     un-epoch'd server-side, for leakage-certified backtests.
   - INVARIANT: the post-fetch `isWithinAsOf` guard in `rankPool` STAYS as the backstop regardless of
     server filtering (defense in depth). `asOf` unset OR flag off -> no epoch clause added ->
     filter byte-identical to today.

3. **Idempotent backfill** — `backfillAsOfEpoch()` (+ pure `computeBackfillEpochUpdate`) in
   `src/lib/vector-db.ts`, driven by the thin operator entrypoint `scripts/backfill-asof-epoch.ts`.
   Iterates the whole index via Pinecone `listPaginated` (ids) + `fetch` (metadata), recomputes the
   epoch from each vector's OWN date metadata, and partial-updates (`index.update({ id, metadata })`)
   those lacking it. Idempotent: vectors that already have a finite epoch are skipped; genuinely
   undated vectors are left absent. Per-id update failures are counted, not thrown. `BACKFILL_DRY_RUN=1`
   reports would-be updates without writing. Emits a `vector_asof_epoch_backfill` audit record.

## Why

`retrieveContextDetailed` over-fetches `overFetchK`/`rerankOverFetchK` (~15 non-rerank / ~150 rerank)
candidates from Pinecone by pure vector similarity with NO date filter, then `rankPool` applies
`isWithinAsOf` POST-fetch to drop chunks dated after `options.asOf`. In a backtest (`asOf` in the
past) the top-K nearest neighbors are dominated by too-recent filings that then get dropped, leaving
a tiny or empty pool — **even though the correct older filings exist in the corpus**, just ranked
below the fetch window and therefore never fetched. This is the "empty/small pools in backtests"
problem. Pushing the date constraint into the Pinecone query fills `topK` with eligible candidates so
the older filings that should win are actually retrieved.

FAIL-OPEN is the owner-approved default so the feature can be turned on safely before the metadata
backfill has run: un-epoch'd (un-backfilled) vectors still pass the server clause, and the existing
post-fetch guard remains the real leakage gate. `VECTOR_ASOF_STRICT` escalates to FAIL-CLOSED for
leakage-certified backtests.

## Pinecone `$exists` finding (STEP 0)

Verified against the INSTALLED client, not assumed:

- `@pinecone-database/pinecone@8.0.0` (per `package.json` `^8.0.0` and `node_modules`).
- The query `filter` parameter is typed as an opaque `object` in the generated types
  (`QueryRequest.filter?: object`, and `UpdateOptions.filter?: object`), and the client forwards it
  verbatim to the data-plane API. So TypeScript imposes NO constraint on filter operator shape —
  `$or` / `$lte` / `$exists` all typecheck and are passed straight through.
- `$exists` is a documented Pinecone metadata-filter operator. Combined with the opaque-`object`
  typing, the fail-open `$or`/`$exists` mechanism works with NO design compromise — I did NOT have to
  fall back to a flag-gated two-behavior or a two-query union. `VECTOR_ASOF_SERVER_FILTER` still
  exists (default OFF) purely so enabling server filtering is an explicit operator choice, not because
  `$exists` was unavailable.
- `index.update({ id, metadata })` (partial metadata update by id) and `index.listPaginated` /
  `index.fetch({ ids })` are all present in v8 and drive the backfill.

Merge subtlety worth recording: the shared-tier base filter ALREADY carries a top-level `$or`
(scope/userId coexistence), and the fail-open epoch clause is itself an `$or`. A naive spread would
silently drop one `$or` (a JS object can't hold two identical keys), so `mergeAsOfEpoch` promotes to
`$and: [base, epoch]` whenever an epoch clause is present. This is covered by a test asserting the
scope `$or` survives inside the `$and`.

## Files

- `src/lib/vector-db.ts` — `AS_OF_EPOCH_FIELD` const; `resolveAsOfEpochMs` (ingest+backfill shared
  derivation); `as_of_epoch_ms` write in `cleanMetadata`; `asOfServerFilterEnabled` flag;
  `buildAsOfEpochFilter` + `mergeAsOfEpoch`; wired into both query tiers in `retrieveContextDetailed`;
  `computeBackfillEpochUpdate` (pure decision) + `backfillAsOfEpoch` (orchestrator).
- `scripts/backfill-asof-epoch.ts` — NEW thin operator entrypoint over `backfillAsOfEpoch`.
- `test/vector-db-asof-server-filter.test.ts` — NEW, 10 tests (filter shape fail-open/strict, asOf
  unset + flag-off byte-identical, fail-open + post-fetch backstop, ingest epoch write, backfill
  pure fn + orchestrator + dry-run).
- `.env.example` — documented `VECTOR_ASOF_SERVER_FILTER=off` and `VECTOR_ASOF_STRICT=off`.
- `STATUS.md`, `docs/EFFORT-LOG.md` — this effort.

## Flags & defaults

- `VECTOR_ASOF_SERVER_FILTER` — NEW, default **OFF**. When OFF, retrieval is byte-for-byte today's
  post-fetch-only behavior. Safe to turn ON at any time on the fail-open default (un-epoch'd vectors
  still pass); running the backfill first just makes the topK-fill improvement effective for older
  vectors too.
- `VECTOR_ASOF_STRICT` — EXISTING, default **OFF**. Previously governed only the post-fetch
  undated-drop; now ALSO escalates the server-side clause to fail-closed when server filtering is on.

## Verification

Exact commands run (in the worktree):

```
npx tsc --noEmit                                   # EXIT 0 (clean)
npx vitest run test/vector-db-asof-server-filter.test.ts \
               test/vector-db-asof-strict.test.ts \
               test/rag-retrieval-regression.test.ts   # 34 passed (3 files)
npx vitest run test/vector-db.test.ts test/vector-db-scope.test.ts \
               test/vector-db-retrieval.test.ts test/vector-db-rerank-floor.test.ts \
               test/vector-db-hybrid.test.ts test/vector-db-provenance.test.ts \
               test/vector-db-chunk-cap.test.ts test/rag-retrieval-eval.test.ts \
               test/rag-doc-type-coverage.test.ts       # 114 passed (9 files)
```

Did NOT run full `npm test` / `npm run build` — central `scripts/land.sh` does that.

## Follow-ups

- **Run the backfill in prod before enabling the flag.** `npx tsx scripts/backfill-asof-epoch.ts`
  (dry-run first: `BACKFILL_DRY_RUN=1 npx tsx scripts/backfill-asof-epoch.ts`). Idempotent, safe to
  re-run. Only after it completes does `VECTOR_ASOF_SERVER_FILTER=on` improve topK-fill for the
  existing (pre-epoch) corpus; before it completes, fail-open keeps those vectors so nothing breaks.
- The backfill iterates the DEFAULT namespace (the Index has no namespace configured, matching how
  `storeContexts`/retrieval use it). If namespaces are ever introduced, the backfill needs a
  per-namespace loop.
- Metering: the backfill's `update` calls are NOT charged against `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY`
  (that budget only wraps `storeContexts` upserts). A large one-time backfill is a deliberate
  operator action; if this becomes routine, wiring a write-unit estimate through `backfillAsOfEpoch`
  is the follow-up.
