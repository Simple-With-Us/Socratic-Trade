# RAG review remediation — 2026-07-22

## Summary

Implemented the latest PR #1892 review fixes without enabling any RAG production flags.

## Why

The review found five correctness gaps: local FTS recall was disabled with paid-stage budget
degradation; source-backed 8-K FTS rows could not satisfy an 8-K doc-type filter without a
`sec_filings` row; chat evidence refs dropped immutable coordinates for id-less chunks; golden
evaluation accepted content-hash-only selectors; and identical serialized text could credit more
than one distinct retrieved occurrence.

## Files

- `src/lib/vector-db.ts`
- `src/lib/rag/corpus-wide-lexical.ts`
- `src/lib/chat/orchestrator.ts`
- `src/lib/rag/evidence-consumption.ts`
- `scripts/eval/rag-production-eval.ts`
- Focused regression tests in `test/corpus-wide-lexical.test.ts`,
  `test/vector-db-backlog-c-integration.test.ts`, `test/chat-orchestrator-search-knowledge.test.ts`,
  `test/rag-evidence-consumption.test.ts`, and `test/rag-production-eval.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Verification

- `npx vitest run --maxWorkers=1 test/corpus-wide-lexical.test.ts test/vector-db-backlog-c-integration.test.ts test/chat-orchestrator-search-knowledge.test.ts test/rag-evidence-consumption.test.ts test/rag-production-eval.test.ts` — 5 files / 60 tests passed.
- `git diff --check` — passed.
- `npx tsc --noEmit` — passed.
- `npm run lint` — passed with 0 errors and 615 existing warnings.
- Full `npm test` and `npm run build` remain for the hosted required gate.

## Follow-ups

Push the verified changes to the existing PR #1892 branch ref, resolve the five corresponding
review threads, and wait for the required hosted `verify` check before auto-merge and production
exact-SHA verification.
