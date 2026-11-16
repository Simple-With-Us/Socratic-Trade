# Rollout Note: Exact RAG Prompt-Consumption Receipts

## Summary

- Added a pure RAG consumption helper that classifies retrieved chunks as consumed, substantively truncated, or retrieved-but-not-consumed from the final serialized prompt fields.
- Added text-free empty, failed, skipped, and duplicate-retrieval outcomes so an empty receipt is not misread as successful evidence use.
- Moved strategy decision-case RAG attribution behind prompt containment and evidence budgeting.
- Added stable `rag_*` evidence references to strategy attributions and chat KB tool/citation payloads.
- Required a substantive body prefix before a prompt-tail fragment is called truncated; a metadata-header-only fragment is not consumed.
- Restricted outcome/usefulness attribution to complete consumption. Chat KB results are recorded as tool-result assembly, not model consumption, until a later provider request actually uses them.
- Expanded legacy evidence identity with immutable content/document coordinates and fixed sibling-parent dedupe to use parent rather than child identity.

## Why

The previous strategy path credited every final retrieval result before the final prompt budget was
applied. A chunk omitted or truncated before the model call could therefore be recorded as used and
later receive retrieval-usefulness credit. The new receipt is identifier/count-only and treats
retrieval selection as diagnostic, not consumption.

## Files

- `src/lib/rag/evidence-consumption.ts`
- `src/lib/strategy.ts`
- `src/lib/socratic-runtime.ts`
- `src/lib/types.ts`
- `src/lib/chat/orchestrator.ts`
- `src/lib/chat/llm.ts`
- `src/lib/chat/types.ts`
- `src/lib/rag/candidate-pool.ts`
- `test/rag-evidence-consumption.test.ts`
- `test/strategy-rag-quickwins-wiring.test.ts`

## Verification

- `npx vitest run test/rag-evidence-consumption.test.ts test/strategy-rag-quickwins-wiring.test.ts test/retrieval-usefulness.test.ts` — 14/14 passed.
- `npx eslint src/lib/rag/evidence-consumption.ts src/lib/socratic-runtime.ts src/lib/strategy.ts src/lib/chat/orchestrator.ts src/lib/chat/llm.ts src/lib/chat/types.ts src/lib/rag/candidate-pool.ts src/lib/types.ts test/rag-evidence-consumption.test.ts test/strategy-rag-quickwins-wiring.test.ts` — 0 errors, 39 pre-existing warnings in `strategy.ts`.
- `npx tsc --noEmit` — passed.
- `git -c core.fsmonitor=false diff --check` — passed. The regular Git fsmonitor IPC check was unavailable in this worktree.

The shared host is saturated, so the full suite and production build are intentionally deferred to
the umbrella integration/landing gate.

## Follow-ups

- Land only after the umbrella RAG lane reviews its integration ordering; no provider, corpus, broker, or production writes occurred here.
- Keep retrieval-stage candidate-pool diagnostics separate from prompt-consumption/usefulness data.
