# 2026-06-25 — P0/P1 Learning-loop fixes + LLM usage per-model/context + masked-key UI

## Summary

Five concrete improvements from the expert framework analysis (P0–P2 priority):

1. **P0 — `getLlmUsageSummary()` now groups by model + context** — previously the SQL GROUP BY omitted
   both columns so per-model cost was impossible to compute despite the data existing in every row.
2. **P1 — `ingestLearned()` moved off the chat hot-path** — the semantic gate runs 3+ sequential LLM
   calls; awaiting it blocked every chat turn by 1–3 s.
3. **P1 — `retrieveLearnedContext()` wired into chat system prompt** — advisory facts stored in
   `learned_context` were only injected into strategy runs, never into chat responses.
4. **P1 — `strategy.ts` now calls `retrieveContextDetailed` instead of `retrieveContext`** — the old
   back-compat wrapper discarded chunk_id, as_of, score, and url provenance from every RAG chunk.
5. **P2 — `/admin/llm-usage` admin page** — new client component with masked key display, per-model/
   context breakdown, time-window selector, and cost summary cards.

## Why

- Per-model cost tracking was a user requirement: compare actual costs between models across chat and
  autonomous strategy runs.
- The blocked chat hot-path was a latency regression introduced when the semantic gate was added
  without decoupling the write path.
- Advisory facts in `learned_context` were invisible to the chat assistant — a silent RAG gap.
- The `retrieveContext` wrapper stripped provenance needed for point-in-time filtering and citation.

## Files changed

- `src/lib/llm-usage.ts` — `LlmUsageRow` + `KeyDescriptor` interfaces; `getLlmUsageSummary()` query;
  `describeUsageKey()` + new `maskApiKey()` utility.
- `src/lib/chat/orchestrator.ts` — fire-and-forget `ingestLearned()`; import + call
  `retrieveLearnedContext()`; pass `learnedContextSummary` to `buildSystem()`.
- `src/lib/chat/prompt.ts` — `buildSystem()` accepts optional `learnedContext` param; bumped
  `PROMPT_VERSION` to `agentic-chat@0.6.0`.
- `src/lib/strategy.ts` — `retrieveContextDetailed` import + `.map(c => c.text)` result mapping.
- `app/api/admin/llm-usage/route.ts` — propagates `keyMasked` from `describeUsageKey()`.
- `app/admin/llm-usage/page.tsx` — new page wrapper.
- `app/admin/llm-usage/llm-usage-client.tsx` — new client component.
- `test/key-resolution-tiering.test.ts` — updated `describeUsageKey` test assertions to include `masked`.
- `test/persistence-notification.test.ts` — added `retrieveContextDetailed` to the `vector-db` mock.

## Verification

```
npx tsc --noEmit   # clean
npm test           # 1198/1198
npm run build      # green
```

## Follow-ups / deferred items

- P2 (not done): Pinecone namespace isolation (separate namespace per user rather than metadata filters)
- P2 (not done): `buildExtraFilters()` section filter — no callers set the `section` field yet
- P3: `reflection_summary` blob in strategy.ts (line 926) is injected with no PII screen or classifier
- P3: `cleanMetadata()` in `vector-db.ts` strips `regime`/`sector`/`industry` — these are valid filter fields
- P4: Kelly sizing / bandit adaptive strategy selection (Mistral 2.1–2.4) — risk-touching, needs explicit owner sign-off
- P4: Counterfactual learning improvements (Mistral 3.4) — deferred
