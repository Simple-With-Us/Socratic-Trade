# Qdrant write backend: fail closed when QDRANT_URL is missing

## Context & Objective

Board item `8215e304aca64e8f` (Pinecone park P0, claimed GROK): production uses Qdrant for vector writes, but `vectorWriteBackend()` still silently returned `"pinecone"` when `QDRANT_URL` was unset (default Qdrant-on path).  That could resume exhausted-Pinecone ingest without operator visibility.  Make the missing-URL case loud; do not change `RAG_MAX_DAILY_INGEST_POINTS`.

## Changes Made

- `vectorWriteBackend()` in `src/lib/vector-store/qdrant-write.ts` throws with a `console.error` when Qdrant is selected (default or explicit) and `qdrantConfigured()` is false, instead of silently falling back to Pinecone.
- Updated knob catalog copy in `src/lib/server-knobs.ts` for `RAG_VECTOR_WRITE_QDRANT`.
- Tests: `test/qdrant-write.test.ts` asserts fail-closed behavior; `test/sec-ingest-worker.test.ts` restores suite default after the Qdrant fuse case; `vitest.config.ts` sets `RAG_VECTOR_WRITE_BACKEND=pinecone` for the suite (same posture as `vector-db.test.ts`).

**Files touched**

- `src/lib/vector-store/qdrant-write.ts`
- `src/lib/server-knobs.ts`
- `test/qdrant-write.test.ts`
- `test/sec-ingest-worker.test.ts`
- `vitest.config.ts`
- `docs/rollouts/2026-10-05-qdrant-write-loud-missing-url.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`

## Decisions & Trade-offs

- **Throw vs audit-only:** Fail closed at backend resolution so ingest/store paths cannot reach Pinecone without an explicit opt-in env/knob.  Explicit Pinecone (`RAG_VECTOR_WRITE_BACKEND=pinecone` or `RAG_VECTOR_WRITE_QDRANT=off`) still works without `QDRANT_URL`.
- **Read path unchanged:** `vectorReadBackend()` still warns once and falls back to Pinecone; scope was write-path debt only.
- **Vitest default:** Suite-wide Pinecone write backend avoids hundreds of tests needing individual pins; production default remains Qdrant-on.

## Verification State

```bash
npm run lint          # 0 errors
npx tsc --noEmit      # clean
npm test -- test/qdrant-write.test.ts test/sec-ingest-worker.test.ts test/vector-db-qdrant-retrieval.test.ts test/vector-db-qdrant-index-metric.test.ts test/connection-health-routing.test.ts  # 112/112
npm run build         # clean
```

Full `npm test` (9105 tests) may report unrelated notify/server-metrics flakes in this cloud VM; the Qdrant write path regressions above are green.

## Next Steps & Blockers

- Merge PR; mark board row `8215e304aca64e8f` addressed with PR link.
- Optional follow-up: align read-path missing-URL behavior (separate effort).

## Zero-Code Findings

None.
