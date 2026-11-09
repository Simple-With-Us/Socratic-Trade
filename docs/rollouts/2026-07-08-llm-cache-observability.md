# 2026-07-08 — LLM prompt-cache observability + cache-aware cost accounting (MONET)

## Summary
Owner suggested "add a cache_control block to reuse expensive context". Audit found the
Anthropic transport ALREADY sends the system prompt as an ephemeral `cache_control`
block (`llm-call.ts` — "Chat A item 3"), and the other providers (OpenAI, DeepSeek,
Gemini) cache automatically server-side with our prompts already cache-friendly (stable
system prefix, no timestamps; volatile evidence lives in the user turn). What was
MISSING: the app could not SEE cache hits, and `estimateLlmCostUsd` billed every prompt
token at the full input rate — overstating cost on cached calls (gpt-5.5 cached input is
$0.50/M vs $5.00/M).

## Changes (src/lib/llm-usage.ts + test/llm-cache-usage.test.ts)
- `extractLlmUsage` now surfaces `cachedPromptTokens` (OpenAI/Gemini-compat
  `prompt_tokens_details.cached_tokens`, DeepSeek `prompt_cache_hit_tokens`, Anthropic
  `cache_read_input_tokens`) and `cacheCreationTokens` (Anthropic), and normalizes
  Anthropic `promptTokens` to the FULL prompt (its `input_tokens` excludes cache tokens).
- `estimateLlmCostUsd` prices cache reads at 0.1x input and Anthropic cache creation at
  1.25x input, with clamping so malformed provider usage can never go negative.
  Signature extended additively (no external callers; call sites spread
  `...extractLlmUsage(...)` so the fields flow automatically).
- `recordLlmUsage` uses the discounted cost and writes an `llm_cache_usage` audit row
  when a call had cache activity — cache hit rates + savings are now queryable per
  provider/model/context with NO schema migration (deliberately avoided taking migration
  v15, which the unlanded single-adversary branch claims).

## Honest economics note (recorded for the owner)
At the current ~hourly strategy cadence (observed 61–66-minute gaps), inter-run cache
hits are unlikely: Anthropic's ephemeral TTL is 5 minutes and OpenAI auto-cache eviction
is typically 5–60 minutes. Caching pays today WITHIN a run (failover retries, Bear after
Bull, debate), in chat sessions, and in the model benchmark (back-to-back rounds); the
50–90% headline applies to high-frequency workloads. This change makes whatever caching
DOES fire visible and correctly priced.

## Verification
- `npx tsc --noEmit` 0 errors; new test file 10/10 + adjacent usage tests green
  (llm-cache-usage, key-resolution-tiering, llm-usage-per-account = 40 tests).
- Full gate runs via land.sh + CI.

## Follow-ups
- Benchmark harness (separate branch) should report cachedPromptTokens per round —
  rounds 2+ hit provider caches and are cheaper/faster than cold calls.
