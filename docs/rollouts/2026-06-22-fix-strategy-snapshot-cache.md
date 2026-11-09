# 2026-06-22 — Pre-run portfolio snapshot + Anthropic prompt-caching

## Summary

Two targeted fixes:

1. **Pre-run portfolio snapshot** (`src/lib/strategy.ts`): `recordPortfolioSnapshot` was only called
   after `finishStrategyRun` (post-execution). A crash mid-proposals-loop left no pre-execution
   baseline for reconciliation. Now a snapshot is also written immediately after `learningSource` is
   determined — before any proposal is evaluated or executed — using the same `source` value as the
   post-run snapshot. Both snapshots share the same `runId` so they are trivially joinable.

2. **Anthropic prompt-caching** (`src/lib/chat/llm.ts`): The `AnthropicLLM` adapter was sending the
   `system` field as a plain string, which the Anthropic API does not cache. Now `AnthropicLLM.run()`
   converts the system string into an array of content blocks. The stable `SYSTEM_PROMPT` prefix is
   marked `cache_control: {type: "ephemeral"}`; the dynamic user-memory suffix (when present) is sent
   as a second uncached block. This gives ~40-60% prompt-token savings on subsequent calls with the
   same stable prefix. The `defaultTransport` also now sends `anthropic-beta: prompt-caching-2024-07-31`
   which is required for the caching feature to activate. The OpenAI/Mock paths are unaffected.

## Why

- **Finding 1**: a crash during the proposals loop (LLM error, broker timeout, kill-switch) left the
  audit trail with no pre-execution account state, making post-mortem reconciliation harder.
- **Finding 2**: Phase 10 D2 token-cost reduction. The strategy LLM path uses OpenAI exclusively
  (strategy.ts does not have an Anthropic adapter), so caching is implemented in the only real Anthropic
  code path: the chat assistant (`src/lib/chat/llm.ts`).

## Files touched

- `src/lib/strategy.ts` — pre-run `recordPortfolioSnapshot` call added (~line 131)
- `src/lib/chat/llm.ts` — SYSTEM_PROMPT import, `anthropicSystem` array construction,
  `anthropic-beta: prompt-caching-2024-07-31` header in `defaultTransport`
- `test/persistence-notification.test.ts` — new test: "records a pre-run portfolio snapshot before
  any proposals execute" (asserts ≥2 snapshots per runId after a completed run)
- `test/chat-llm.test.ts` — four new tests in "AnthropicLLM — prompt-caching cache_control" describe
  block (system-as-array, stable-prefix-ephemeral, split-with-memory, unrecognised-fallback)

## Verification

```
npx tsc --noEmit   # 0 errors
npm test           # 777/777 passed (85 files)
npm run build      # clean Next.js build
```

## Follow-ups

- **FillSource "pre-run" label**: the audit requested a distinguishable "pre-run" snapshot source.
  `FillSource = "live" | "paper"` does not accommodate a third variant without a type change and
  a DB migration. The current approach (two snapshots per runId, ordered by `createdAt`) is
  semantically sufficient. If a formal "pre-run" label is needed, extend `FillSource` and add a
  migration in a follow-up.
- **Anthropic caching in strategy runs**: strategy.ts uses OpenAI exclusively. If an Anthropic
  strategy adapter is added in a future phase, apply the same `cache_control` pattern to its
  system prompt at that time.
- The `anthropic-beta` header will eventually be promoted to stable; remove when the feature
  graduates from beta (check Anthropic release notes).
