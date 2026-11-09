# RAG review remediation — 2026-07-22

## Summary

Implemented PR #1892 review fixes without enabling any RAG production flags. Round 1 closed the
budget-degradation / 8-K filter / chat-ref / golden-selector / duplicate-text set. Round 2 (GROK)
closes the remaining open connector threads on the current PR head.

## Why

Round 1: local FTS recall was disabled with paid-stage budget degradation; source-backed 8-K FTS
rows could not satisfy an 8-K doc-type filter without a `sec_filings` row; chat evidence refs dropped
immutable coordinates for id-less chunks; golden evaluation accepted content-hash-only selectors; and
identical serialized text could credit more than one distinct retrieved occurrence.

Round 2: invalid `RAG_RERANK_PROVIDER` aborted entire retrieval; production-eval omitted `runId` from
retrieval options (breaking candidate-pool join); content-hash + source-only goldens still matched
loosely; 8-K lexical candidates lacked `doc_type` for strategy revalidation; FTS bare SEC accessions
could not join managed composite `chunk_occurrences.accession` keys; ordinal `0` was dropped from
fallback evidence refs; prompt-consumption matched pre-containment text after sanitization.

## Files

Round 1:

- `src/lib/vector-db.ts`
- `src/lib/rag/corpus-wide-lexical.ts`
- `src/lib/chat/orchestrator.ts`
- `src/lib/rag/evidence-consumption.ts`
- `scripts/eval/rag-production-eval.ts`
- Focused regression tests in `test/corpus-wide-lexical.test.ts`,
  `test/vector-db-backlog-c-integration.test.ts`, `test/chat-orchestrator-search-knowledge.test.ts`,
  `test/rag-evidence-consumption.test.ts`, and `test/rag-production-eval.test.ts`

Round 2:

- `src/lib/rag/rerank-policy.ts` — invalid explicit provider → unavailable route receipt
- `scripts/eval/rag-production-eval.ts` — pass `runId`; tighten content-hash coordinate errors
- `src/lib/rag/corpus-wide-lexical.ts` — accession join + 8-K doc_type on candidates
- `src/lib/web-sources/sec-filings.ts`, `src/lib/rag/sec-ingest-worker.ts` — FTS uses managed doc keys
- `src/lib/rag/evidence-consumption.ts` — preserve ordinal zero; `promptSource` field
- `src/lib/strategy.ts` — match consumption against post-containment sanitized text
- Tests: `test/rag-rerank-policy.test.ts`, `test/rag-production-eval.test.ts`,
  `test/rag-evidence-consumption.test.ts`, `test/corpus-wide-lexical.test.ts`
- `STATUS.md`, `docs/EFFORT-LOG.md`

## Verification

Round 1:

- Focused 5 files / 60 tests passed; `git diff --check`; `npx tsc --noEmit`; `npm run lint` 0 errors.

Round 2 (Node 24):

- `npx vitest run --maxWorkers=1 test/corpus-wide-lexical.test.ts test/rag-evidence-consumption.test.ts test/rag-production-eval.test.ts test/rag-rerank-policy.test.ts` — 4 files / 37 tests passed.
- `git diff --check` — passed.
- Full `npm test` / `npm run build` / required hosted `verify` remain the merge gate.

## Follow-ups

Push to PR #1892 branch `codex/rag-retrieval-integration-20260722`, resolve the remaining review
threads with file:line evidence, re-arm auto-merge if needed, and wait for hosted `verify` before
production exact-SHA verification. All RAG activation flags remain off.
