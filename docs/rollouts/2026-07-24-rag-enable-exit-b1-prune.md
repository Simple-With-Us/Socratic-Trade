# 2026-07-24 — RAG enablement, Exit Contract B1, branch prune (CURSOR)

## Summary

Owner-directed pass to finish RAG enablement, carefully advance exit-strategy Phase B,
evaluate leftover Wave-2 branches, prune stale no-PR origin tips, and keep the effort board
aligned with GitHub Issues (`effort-issues-sync` section headings).

## Why

- RAG Priority A flags had landed default-off after #1892; owner asked to turn dormant features on.
- Exit Phase B was only partially done (B3 interim via #1786); B1 Exit Contract substrate was missing.
- `claude/w2-coaching-durable` / `claude/w2-reflection-decompose` (closed PRs #1911/#1909) looked like
  unfinished work but regime ranking is already on main; coaching durability superseded.
- Dozens of origin branches with no open PR and no unique value were noise for triage.

## Decisions

- **Enable (code default ON):** `RAG_RETRIEVAL_TELEMETRY`, `RAG_RETRIEVAL_STAGE_TELEMETRY`,
  `RAG_RUN_BUDGET_ENABLED`, `RAG_APPLY_DEFAULT_FLOORS`, `RAG_CORPUS_WIDE_LEXICAL`,
  `RAG_PARENT_CONTEXT_EXPANSION`, `RAG_ADAPTIVE_RERANK`, `RAG_CITATION_STALENESS`,
  `VECTOR_ASOF_SERVER_FILTER`.
- **Keep OFF:** `RAG_MULTIQUERY`, `RAG_HYDE`, `RAG_PERSIST_CANDIDATE_POOL*`, `VECTOR_ASOF_STRICT`,
  `HYBRID_RETRIEVAL`, FMP transcript dual-gate, `WEB_SOURCE_SEC8K_FULL_BODY`, legacy vector purge,
  `VECTOR_EMBED_CLEAN_TEXT`, `RAG_EMBED_DISCLOSURES`.
- **Exit B1:** nullable contract columns + fill writes + proactive/synthetic
  `persistedOrFallbackStopPct`. Deferred: corporate-action re-key, B4–B6, Phase C.
- **w2:** DISCARD — delete branches; no salvage beyond what main already has.
- **Prune:** 19 origin branches deleted in batches of 5 (GitHub rule GH013).

## Files

- `src/lib/vector-db.ts`, `src/lib/rag-metering.ts`, `src/lib/rag/run-budget.ts`,
  `src/lib/rag/rerank-policy.ts` — default ON for safe flags
- `.env.example`, `docs/FEATURE-ENABLEMENT-BACKLOG.md`
- `src/lib/db.ts` (migration v60), `src/lib/db-api-keys.ts`, `src/lib/performance.ts`,
  `src/lib/strategy-execution.ts`, `src/lib/strategy.ts`, `src/lib/synthetic-stops.ts`
- Tests: `test/position-stop-plans-db.test.ts`, RAG default-assumption tests
- `docs/EFFORT-LOG.md`, `STATUS.md`, `PLAN.md`, this rollout

## Verification

```bash
npx vitest run test/rag-run-budget.test.ts test/vector-db-staleness-and-clean-text.test.ts \
  test/vector-db-asof-server-filter.test.ts test/position-stop-plans-db.test.ts \
  test/rag-env-flag.test.ts
# plus previously-failing suites after pin helper + v60 bump: 131/131
npm run lint   # 0 errors
npx tsc --noEmit  # clean
npm test       # 5312/5312
npm run build  # clean
```

Pruned 19 origin branches (batched deletes for GH013 max-5 rule).
## Follow-ups

- Mirror ON values into Infisical prod if operators prefer explicit env over code defaults.
- Exit B4 short buy-stop lane before live shorts; B5 `exit_events`; B6 eval → Phase C.
- Corporate-action re-key/alert for Exit Contract (design Rec 3b).
- Issues API is 403 for this cloud token — board section moves drive `effort-issues-sync` on merge.
- Further prune of ahead-of-main unique-src tips only after per-branch salvage review.
