# 2026-07-21 - Production-path RAG evaluation framework

## Summary

Added `npm run eval:rag-production` and a versioned SQLite case table for evaluating the production
`retrieveContextDetailedWithStatus` path. It does not use the evaluation-only FTS fusion helper.

## Why

The previous harness measured `retrieveFusedContext`, while strategy retrieval uses the Pinecone/RAG production
path. Model selection requires real vector ids, authoritative point-in-time query timestamps, and receipts that
make relevance, leakage, duplicates, coverage, latency, status, and spend observable together.

## Design

- Golden cases are either frozen JSON (`--source file --input cases.json`) or enabled rows in
  `rag_production_eval_cases`.
- Every case requires `authoritativeAsOf` and `expectedEvidenceIds`. The DB stores the equivalent fields as
  `authoritative_as_of` and JSON `expected_evidence_ids`; optional expected source/section arrays make coverage
  assertions explicit.
- The CLI requires `--allow-live` before it imports and calls `retrieveContextDetailedWithStatus`. It performs
  retrieval reads only; it never writes embeddings or vectors. Native retrieval metering/audit receipts may still
  be emitted by the production function and are reported best-effort.
- `--profile`, `--embedding-*`, and `--rerank-*` are output labels only. They do not alter environment or
  production defaults, so shadow comparisons remain explicit and externally controlled.

## Files

- `src/lib/db.ts` - migration 55: `rag_production_eval_cases`.
- `scripts/eval/rag-production-eval.ts` - CLI, loaders, production adapter, machine-readable report/scoring.
- `test/rag-production-eval.test.ts` - hermetic evaluator mechanics.
- `package.json` - `eval:rag-production` script.
- `PLAN.md`, `STATUS.md`, `docs/EFFORT-LOG.md`, `docs/chat-assistant-rag-learning.md` - state and operating guidance.

## Verification

```bash
node node_modules/vitest/vitest.mjs run test/rag-production-eval.test.ts
node node_modules/typescript/bin/tsc --noEmit
git diff --check
```

Focused tests passed (3/3), TypeScript passed, and diff check passed. No live provider, Pinecone, corpus, or
production calls were made.

## Follow-ups

1. Curate source-anchored EDGAR cases with real committed vector ids; do not treat synthetic fixtures as model evidence.
2. Run each candidate embedding/reranker configuration as a separately labeled, read-only shadow run and compare
   the emitted JSON receipts.
3. Keep usage receipt interpretation scoped to the run window; concurrent same-user production retrieval can share
   that ledger window.
