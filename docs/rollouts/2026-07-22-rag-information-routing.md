# RAG Information Routing Boundary — 2026-07-22

## Summary

Added a typed, caller-declared information-routing contract and applied it to strategy RAG assembly.
Current market data, portfolio state, orders, SEC company facts, and Form 4 transactions stay on
deterministic paths. Filing and rights-gated earnings-transcript narrative are the only strategy
inputs eligible for semantic retrieval.

## Why

The strategy dossier previously queried the semantic store for `fundamentals` while separately
loading the authoritative normalized facts card from SQLite. That duplicated a structured source,
made the retrieval boundary ambiguous, and left new callers free to infer a path from query text.
The new contract rejects unknown declarations and exposes separate structured and semantic plans.

## Files

- `src/lib/rag/information-routing.ts`
- `src/lib/strategy.ts`
- `test/rag-information-routing.test.ts`
- `test/rag-doc-type-coverage.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/chat-assistant-rag-learning.md`
- `docs/EFFORT-LOG.md`

## Verification

- `./node_modules/.bin/vitest run test/rag-information-routing.test.ts --reporter=verbose` — passed, 4/4.
- `./node_modules/.bin/vitest run test/rag-doc-type-coverage.test.ts --reporter=verbose` — the
  seven pure coverage cases passed; the broker/LLM strategy integration portion was deferred while
  the shared host was saturated.
- `./node_modules/.bin/eslint src/lib/rag/information-routing.ts src/lib/strategy.ts test/rag-information-routing.test.ts test/rag-doc-type-coverage.test.ts` — passed.
- `./node_modules/.bin/tsc --noEmit` — passed.
- `git diff --check` — passed.

## Follow-ups

- Route chat and the evidence-consumption receipt through the same typed contract.
- Do not alter trading verdicts, provider configuration, corpus state, or production as part of this lane.
