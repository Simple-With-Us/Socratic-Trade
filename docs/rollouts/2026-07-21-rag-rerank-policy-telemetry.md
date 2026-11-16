# RAG rerank policy and retrieval-stage telemetry foundation

## Summary

Added two pure, production-inert foundations for the RAG strategic-performance program:

- independent rerank provider/model resolution with truthful missing-credential behavior;
- default-off adaptive candidate-depth planning for scout, deep, exact, and general queries;
- text-free per-stage retrieval receipts carrying duration, route, model/provider, namespace,
  cache, candidate, and drop counts.

The central retrieval path is intentionally unchanged. A later integration PR will wire these
modules only after the managed-ingestion regression, production-path PIT evaluator, and corpus-wide
lexical candidate module are reviewed.

## Why

Embedding and reranking currently share one provider selector, which prevents clean model
experiments. Retrieval also lacks a complete per-stage trace, so fixed latency/cost claims cannot be
validated and scout fan-out cannot be tuned independently from deep dossiers. These pure modules
create explicit contracts without changing production ranking behavior prematurely.

## Files

- `src/lib/rag/rerank-policy.ts`
- `src/lib/rag/retrieval-stage-telemetry.ts`
- `src/lib/rag/env-flag.ts`
- `test/rag-env-flag.test.ts`
- `test/rag-rerank-policy.test.ts`
- `test/rag-retrieval-stage-telemetry.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/chat-assistant-rag-learning.md`
- `docs/rollouts/2026-07-21-rag-rerank-policy-telemetry.md`

## Verification

Executed:

```bash
npx vitest run test/rag-env-flag.test.ts test/rag-rerank-policy.test.ts test/rag-retrieval-stage-telemetry.test.ts
npx eslint src/lib/rag/env-flag.ts src/lib/rag/rerank-policy.ts src/lib/rag/retrieval-stage-telemetry.ts test/rag-env-flag.test.ts test/rag-rerank-policy.test.ts test/rag-retrieval-stage-telemetry.test.ts
npx tsc --noEmit
npm run lint
npx tsc --noEmit
npm test
npx vitest run test/data-providers.test.ts test/order-confirmation-status.test.ts test/outcome-engine.test.ts test/policy.test.ts test/strategy-active-protection-wiring.test.ts test/strategy-money-path-f-g.test.ts test/usage-budget-strategy-integration.test.ts --reporter=verbose --pool=forks --maxWorkers=1
npm run build
```

Results: 3 files / 28 tests passed; scoped ESLint returned zero errors; TypeScript returned zero
errors. Full lint returned zero errors (597 grandfathered warnings); the ordered TypeScript check
passed; the production build passed. The full suite completed 4,923/4,931 tests across 423 files.
Two timeouts (`order-confirmation-status`, `strategy-active-protection-wiring`) passed in the focused
rerun. Six deterministic failures remained in unrelated existing areas: one Yahoo fixture, one
outcome re-index fixture, two bracket-policy fixtures, and two budget-status fixtures that expect
`completed` while current runtime returns `skipped`. The seven-file isolated rerun was 186/192 and
confirmed those six; none of the failing files or their production modules changed in this commit.

## Follow-ups

- Wire route resolution and stage receipts through `retrieveContextDetailed` only after the P0
  managed-ingestion fix lands.
- Union current-schema FTS5 candidates with dense candidates before exactly one rerank.
- Keep `RAG_ADAPTIVE_RERANK` default off until the production-path evaluator establishes quality,
  latency, and cost thresholds.
- Do not start a corpus re-embed or purge from this lane; that production operation has a separate
  active owner and requires independent count/receipt verification.
