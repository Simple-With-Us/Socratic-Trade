# 2026-08-18 — rag-embed DeepInfra batch-window 400

## Context & Objective

After the 2026-08-18 2:12pm CT deploy, `rag-embed` hard-failed on `embed documents`.  Live `VECTOR_EMBED_BATCH_SIZE` is 32 (code default 8).  DeepInfra sums the **whole** OpenRouter `baai/bge-m3` `input[]` against 8192.  A 32-text ingest hit 8193 and 400'd.  That is a batch-sum, not one unchunked 10-K.  Hybrid producer order stays (#2820): `chunkDocument` → `persistLocalComplete` → highlights/abstract → `storeSignalSectionDocuments` → full-body `storeDocument` only if `writesFullBodyToPinecone()`.  Token-pack is after that condense/process step, not instead of it.  Jay wants those batches to embed without violating hybrid.  The #2812 health 503 gate stays.

## Changes Made

Pack already-condensed texts only.  Hybrid still trims to `VECTOR_CONTEXT_MAX_CHARS` (tables stay whole).  `storeContexts` then packs those texts so each embed lane stays under ~7500 `approxTokens` (plus an 18,750-byte cap).  Each packed group is its own `embedDocumentsLaneOrSkip` call, so a singleton that still 400s skips only that document — companions in the count-32 batch still upsert.  Local archive / store-more is not on this path and is not dropped.  `embedWithRetry` still packs as defense for query / cache-miss reuse.  No second filing chunker, no extra ContextDocuments, no extra table vectors, no mean-pooled split records.  Infisical can keep `VECTOR_EMBED_BATCH_SIZE=32`.  Did not revert #2812 / #2829 / #2800.  Did not flip `RAG_PINECONE_WRITE_CLASS` or `--apply` prune.  Did not re-clamp the #2800 fuse.  Did not rewrite `test/vector-db-chunk-cap.test.ts` to accept new Pinecone table chunks.

Touched files:

- `src/lib/rag/embed-request-pack.ts`
- `src/lib/rag-metering.ts`
- `src/lib/vector-db.ts`
- `test/embed-request-pack.test.ts`
- `test/query-embedding-cache.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-18-rag-embed-batch-window.md`

## Decisions & Trade-offs

- Pack after hybrid condense, inside `storeContexts` + `embedWithRetry`.  Do not change `chunkDocument` (480) or `selectSignalChunks`.
- Isolate an over-budget singleton instead of splitting it.  If that singleton 400s, do not fail the rest of the count-32 batch.  Item 8 / `is_table` metadata and content_hash stay whole.
- Dual budget (7500 tokens + 18,750 bytes) because token-only packing of max-char texts can still exceed 8192 if DeepInfra is denser than bytes/4.
- Integrity stays atomic per embed POST.  A poisoned multi-text response still rejects that group, not the later packed groups.
- Did not add an ingest LLM.  Did not touch `DO_NOT_TOUCH_DOC_TYPES`.  Did not clamp the #2800 trial WU.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/embed-request-pack.test.ts test/vector-db-embedding-integrity.test.ts test/vector-db-chunk-cap.test.ts test/query-embedding-cache.test.ts
npm run build
```

lint: 0 errors (grandfathered warnings only).  tsc clean.  Focused packer + integrity + chunk-cap + query-embed-cache tests.  `npm run build` clean (Next 16.3.1).  Linux VM: no xcodebuild.  Do not claim an iOS compile.

## Next Steps & Blockers

- **MERGED #2840** `5674dfaf`.  Confirm live `rag-embed` `ok=1` on 32-count ingest batches, not only 17–59-token probes.
- Leave Infisical `VECTOR_EMBED_BATCH_SIZE=32`.
- Do not reclassify this as an account-miss.  Do not drop rag-embed from health.

## Zero-Code Findings

First five hard fails after 19:12:31Z were the same 8193 `input_tokens` body (19:12:49Z, 19:12:59Z, 19:14:10Z, 19:14:18Z, 19:15:29Z).  Twelve hard fails through 19:31:57Z.  Then ok=1 from 19:33:40Z on tiny baai/bge-m3 probes.  Same 8193 body again at 20:03:58Z after the #2812 swap.  Path is ingest `embed documents`, not the health probe.
