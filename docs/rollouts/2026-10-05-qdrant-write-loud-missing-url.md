# Qdrant write backend: fail closed when QDRANT_URL is missing

## Context & Objective

Board item `8215e304aca64e8f` (Pinecone park P0, claimed GROK): production uses Qdrant for vector writes, but `vectorWriteBackend()` still silently returned `"pinecone"` when `QDRANT_URL` was unset (default Qdrant-on path).  That could resume exhausted-Pinecone ingest without operator visibility.  Make the missing-URL case loud; do not change `RAG_MAX_DAILY_INGEST_POINTS`.

## Changes Made

- `vectorWriteBackend()` in `src/lib/vector-store/qdrant-write.ts` throws with a `console.error` when Qdrant is selected (default or explicit) and `qdrantConfigured()` is false, instead of silently falling back to Pinecone.  The message names an unset `QDRANT_URL` and a remote URL missing `QDRANT_API_KEY` / `QDRANT_ALLOW_ANONYMOUS`.  `vectorWriteBackendOrNull()` is the non-throwing probe.
- `src/lib/vector-db.ts` uses that probe on the read path, vector-store stats, and the reconcile rate-limit catch.  `app/api/health/route.ts` records `ragVectorWriteBackend=misconfigured` without skipping the rest of the RAG block.
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
- **Read path unchanged:** `vectorReadBackend()` still warns once and falls back to Pinecone.  Read, health, and stats probes call `vectorWriteBackendOrNull()` so a missing endpoint does not fail retrieval or swallow the health check.  Write entry points still use throwing `vectorWriteBackend()`.
- **Vitest default:** Suite-wide Pinecone write backend avoids hundreds of tests needing individual pins; production default remains Qdrant-on.

## Verification State

```bash
npx vitest run test/qdrant-write.test.ts test/sec-ingest-worker.test.ts test/vector-db-qdrant-retrieval.test.ts test/vector-db-qdrant-index-metric.test.ts test/connection-health-routing.test.ts
npx eslint src/lib/vector-store/qdrant-write.ts src/lib/vector-db.ts app/api/health/route.ts test/qdrant-write.test.ts test/connection-health-routing.test.ts --quiet
npx tsc --noEmit
```

114 tests passed.  eslint on those TypeScript files: 0 errors.  `npx tsc --noEmit` exit 0.  `npm run build` and full `npm test` were not run on this seat; CI `verify` is the merge gate.

## Next Steps & Blockers

- Block merge until CI `verify` is green, then mark board row `8215e304aca64e8f` addressed with the PR link.
- Optional follow-up: align read-path missing-URL behavior (separate effort).

## Zero-Code Findings

None.
