# RAG shadow benchmarks — 2026-07-22

## Summary

Added a default-off, read-only shadow-probe harness for two provider questions:

1. Local Turso/libSQL vector capability inspection.
2. Context retrieval from an already-configured Pinecone Assistant.

## Why

Turso's vector capability and Pinecone Assistant can be useful comparison
baselines, but neither should silently become a production dependency or cause
corpus/provider writes before measured retrieval evidence exists.

## Files

- `scripts/eval/rag-shadow-benchmarks.ts`
- `test/rag-shadow-benchmarks.test.ts`
- `docs/rag-shadow-benchmarks.md`
- `package.json`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-22-rag-shadow-benchmarks.md`

## Safety and capability limits

- Turso: this checkout has `better-sqlite3` but no direct `@libsql/client`
  dependency. The harness probes an in-memory local SQLite instance for
  `vector32` and `vector_distance_cos`; it never contacts a Turso database.
  A local `unsupported` receipt therefore describes this checkout, not Turso
  service capability.
- Pinecone Assistant: requires `RAG_SHADOW_BENCHMARK_LIVE=1`,
  `PINECONE_ASSISTANT_NAME`, `PINECONE_API_KEY`, and an external JSON case file.
  It invokes only `Assistant.context` (not chat or any file/control/index API),
  runs serially, caps at 100 queries, clamps individual timeouts to 30 seconds,
  and aborts the underlying SDK fetch when a timeout fires.
- Receipts contain only case IDs, latency, citation count and hashed file IDs,
  token usage, and normalized error kinds. Prompts, snippets, answers, file
  names, raw errors, and keys are neither written nor printed.

## Verification

- `npm test -- test/rag-shadow-benchmarks.test.ts` — 1 file / 4 tests passed.
- `npm run eval:rag-shadow-benchmarks` — safe default receipt: local SQLite
  3.53.2, no direct `@libsql/client`, neither vector function available, no
  network probe; Assistant skipped with `live_gate_off`.
- `npx eslint scripts/eval/rag-shadow-benchmarks.ts test/rag-shadow-benchmarks.test.ts` — passed.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.

No live provider invocation, corpus/index/file write, or production mutation
was run while creating or verifying this harness.

## Follow-ups

These are capability/context probes, not provider-selection evidence: Turso has no remote vector
query here, and Assistant has no frozen-golden relevance mapping. Run the live Assistant probe only with a pre-created assistant containing
an approved benchmark corpus and an external ephemeral case file. Add a
dev-only libSQL adapter only if the local capability receipt and a defined
remote same-corpus shadow target justify that measurement. Production adoption requires the
separate PIT/evidence/tenant-erasure acceptance gates.
