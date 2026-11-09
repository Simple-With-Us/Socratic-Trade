# RAG parent-context expansion — 2026-07-22

## Summary

Added a pure bounded parent-context helper and a narrow default-off retrieval integration.
`RAG_PARENT_CONTEXT_EXPANSION=true` keeps dense/lexical fusion and reranking on child chunks, then
attaches parent context only to already-selected final survivors.

## Why

`chunkDocument()` stores `parent_text` for every child, but the legacy retrieval mapper substituted
that entire parent for every returned child. That can repeat sibling context and escape a predictable
prompt budget. The new opt-in path retains the child as the retrieval identity and adds at most one
parent attachment per provenance key, with per-parent and global character caps.

## Behavior

- Default/unset behavior is unchanged.
- `RAG_PARENT_CONTEXT_MAX_CHARS` defaults to 6,000 characters per unique parent.
- `RAG_PARENT_CONTEXT_MAX_TOTAL_CHARS` defaults to 12,000 characters across the final list.
- Repeated sibling parents are attached once in final ranked order; an exact selected-child passage
  is removed from its parent attachment so prompt text is not duplicated. Missing parents and exhausted
  budgets leave the child unchanged.
- With a valid strict point-in-time boundary, future or undated parent metadata is not attached.
- Parent context preserves the child's existing id, score, relevance score, metadata, source, and
  position. It does not create/rerank/inflate another candidate.

## Files

- `src/lib/rag/parent-context.ts`
- `src/lib/vector-db.ts`
- `test/rag-parent-context.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/chat-assistant-rag-learning.md`

## Verification

- `npx vitest run test/rag-parent-context.test.ts`
- `npx eslint src/lib/rag/parent-context.ts src/lib/vector-db.ts test/rag-parent-context.test.ts`
- `npx tsc --noEmit`
- `git diff --check`

Results: 7/7 focused tests pass; ESLint reports 0 errors and 64 existing warnings in the large
`vector-db.ts` module; TypeScript and the whitespace/error diff check pass. Full suite/build are
intentionally owned by the umbrella integration lane.

## Follow-ups

Enable only after the production-path retrieval evaluator can compare prompt-consumed evidence and
PIT fidelity with the legacy mapping. This lane did not change chunking, filing parsing, ingestion,
provider configuration, re-embedding, Pinecone, or production state, and deliberately avoids the
open SEC parser/re-embed work around PRs #1776/#1777.
