# 2026-07-19 — Usage-compliance Wave 2 (ST lane): telemetry ingestion gaps + OpenRouter classifier metadata

**Agent:** CLAUDE (branch `claude/usage-compliance-st`, worktree
`/Users/jay/apps/socratic-trade-claude-usage-compliance`; MONET-handoff credit)
**Design authority:** `/Users/jay/apps/DESIGN-usage-compliance-classifier.md` §1 (WS1 gaps) + §2 (ST
section), including the RESOLVED 2026-07-18 correction: OpenRouter enrichment is classifier keys
**flat under `trace`** (no `metadata` sub-object), `user`/`session_id` ≤128 chars, pass `undefined`
never `""`, push `response.id || undefined` as `providerRequestId`.

## Summary

Wave 2 of the cross-repo usage-compliance initiative. Two deliverables:

1. **WS1 — close the three unmetered paid-call gaps** (every other paid path already metered):
   - `src/lib/market-signals/massive.ts` — the 3 raw `fetch()` calls (grouped-daily ×2 lanes, news)
     now route through `fetchWithRetry` from `data-providers.ts`, inheriting the per-lane circuit
     breaker, secret-scrubbed health rows, and aggregated call-volume telemetry — exactly the
     pattern `MassiveEnrichmentProvider` already used. `retries: 0` on all three because
     `reserveMassiveRestCall()` reserves exactly one call per invocation (fetchWithRetry's own
     documented contract for exact-quota reservers). Key resolution upgraded
     `resolveApiKey` → `resolveApiKeyWithSource` so the telemetry carries the credential lane.
   - `src/lib/rag/query-deconstruct.ts` (gpt-4o-mini) — request now built through
     `buildLlmRequestBody` (json_object response format preserved; gains a 400-token output cap it
     previously lacked + a `LLM_TIMEOUT_MS` abort), records `recordLlmUsage` (context
     `rag-query-deconstruct`) with the OpenRouter generation id, mirroring
     `memory/salience-llm.ts`.
   - `src/lib/rag/search-fusion.ts` `fetchAlternativeEmbedding` — meters via `meterEmbed`
     (provider-correct: `openrouter`/`siliconflow`) mirroring `vector-db.ts`; OpenRouter branch
     additionally gets HTTP-Referer/X-Title + classifier enrichment.

2. **WS3 (ST half) — classifier metadata + generation-id capture:**
   - `src/lib/llm-call.ts`: new `applyOpenRouterClassifierEnrichment` wraps the shared
     `openrouterRequestEnrichment` (congress-trading-shared v1.10.0). `buildLlmRequestBody` now
     takes `keyRef`/`service`/`feature` on the spec and, for OpenRouter, emits top-level `user`
     (≤128, truncated; omitted when absent/blank) + flat `trace{sourceApp, environment, service,
     feature, keyRef, gitSha}`. The old bare `metadata` field is GONE. `gitSha` reuses
     `runtimeReleaseIdentity()`'s existing env probe (APP_RELEASE_SHA/SOURCE_COMMIT/
     COOLIFY_COMMIT_SHA/GIT_COMMIT_SHA/GITHUB_SHA/VERCEL_GIT_COMMIT_SHA) — no new env var; omitted
     when none set. **Fail-open contract:** any enrichment error logs a warning and sends the
     request un-enriched — a paid call can never break over telemetry metadata (tested).
   - All 11 strategy/RAG/memory call sites thread `userId` + `keyRef` + their existing
     `recordLlmUsage` context string as `feature` (service buckets: `strategy`, `rag`, `memory`,
     `chat`): strategy.ts (primary + fallback chain), red-team.ts (primary + fallback),
     outcome-engine.ts, strategy-tuning.ts, learning-review.ts, proposal-revalidation.ts,
     framework-review.ts, post-mortem.ts, memory/salience-llm.ts, rag/multi-query.ts,
     rag/query-deconstruct.ts.
   - `src/lib/chat/llm.ts` Path B (`OpenAILLM`): the duplicated hand-built OR `metadata` object is
     replaced by the same shared enrichment; the dead `(this.usage as any).metadata` access is
     removed. Generation ids are collected per step; the aggregate ledger row carries
     `providerRequestId` only when the tool loop made exactly ONE request (a single id cannot
     verify a multi-step aggregate).
   - `src/lib/vector-db.ts` OpenRouter embed/rerank (`baai/bge-m3` / `cohere/rerank-v3.5`): added
     HTTP-Referer/X-Title + enrichment on the HTTP branches; `meterEmbed`/`meterRerank` gained an
     optional `providerRequestId` param threaded from the response.
   - Generation-id capture: new `providerRequestIdFromPayload(provider, payload)` in
     `llm-usage.ts` — returns the response `id` ONLY for `provider === "openrouter"` (every
     provider envelope has an `id`; only OpenRouter's is verifiable via `GET /api/v1/generation`),
     `undefined` never `""`. Flows `recordLlmUsage` → `pushLlmUsage` → event `providerRequestId`
     (shared schema v1.10.0 accepts it), and `recordRagUsage` → `pushRagUsage` likewise.
     Idempotency-key inputs unchanged.
   - Voyage/SiliconFlow/Pinecone bypass OpenRouter: no request enrichment, but their PUSHED events
     now carry the classifier keys in event `metadata` via `telemetryEventClassifier` (sourced from
     local context in `usage-monitor-push.ts`; fail-open like the request side).
   - Shared pin bump: `@jaywedgeworth22/congress-trading-shared`
     `#fee9937c` (v1.8.3) → `#904ea96ac237b775c54c8e4bb29df0d1a40da125` (v1.10.0). The 1.9.0 delta
     (normalizeCompanyName removal) verified safe: zero references in src/test; tsc clean.

## Empirical OpenRouter acceptance check (Part C — one-time, ~$0.0002)

Key: `ST_OPENROUTER_API_KEY` from the owner-sanctioned secrets handoff file (never printed).

| Probe | Result |
|---|---|
| POST /chat/completions (gpt-4o-mini, max_tokens=1) with `user`+`session_id`+flat `trace` | **HTTP 200** — enrichment accepted; response `id` present (`gen-...`) |
| GET /api/v1/generation?id=… (same key) | **HTTP 200** — cost/usage fields present: `total_cost`, `usage`, `cache_discount`, `upstream_inference_cost`, `tokens_prompt`, `tokens_completion`, `native_tokens_*`; echoes `external_user`, `session_id` |
| POST /embeddings (baai/bge-m3) with the same enrichment fields | **HTTP 200** — accepted; response `id` present |

Consequence: the design's embeddings fallback (omit enrichment if rejected) is NOT needed —
embeddings keep full enrichment.

## Files touched

- `package.json`, `package-lock.json` — shared pin bump to v1.10.0.
- `src/lib/llm-call.ts` — classifier enrichment helper + spec fields; bare `metadata` removed.
- `src/lib/llm-usage.ts` — `providerRequestIdFromPayload`, `providerRequestId` on entry + push.
- `src/lib/usage-monitor-push.ts` — `providerRequestId` on llm/rag events; classifier keys in
  event metadata (`telemetryEventClassifier`, fail-open).
- `src/lib/rag-metering.ts` — `providerRequestId` through `recordRagUsage`/`meterEmbed`/`meterRerank`.
- `src/lib/llm-request.ts` — `LLM_OUTPUT_TOKEN_CAPS.queryDeconstruct` (400).
- `src/lib/market-signals/massive.ts` — 3 fetches → `fetchWithRetry` (WS1 #1).
- `src/lib/rag/query-deconstruct.ts` — metered + enriched (WS1 #2).
- `src/lib/rag/search-fusion.ts` — metered + enriched (WS1 #3; fn exported for tests).
- `src/lib/chat/llm.ts` — Path B dedup + generation-id capture.
- `src/lib/vector-db.ts` — OR embed/rerank headers + enrichment + generation ids.
- 10 call-site files (strategy, red-team, outcome-engine, strategy-tuning, learning-review,
  proposal-revalidation, framework-review, post-mortem, memory/salience-llm, rag/multi-query) —
  one-line-ish classifier tags + `providerRequestId` capture.
- `test/usage-compliance-classifier.test.ts` — 19 new tests.
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification

- `npx tsc --noEmit` — clean.
- New suite: `npx vitest run test/usage-compliance-classifier.test.ts` — 19/19.
- Related suites (llm-call, usage-monitor-push, rag-metering, search-fusion, chat-llm,
  salience-llm, red-team, post-mortem, proposal-revalidation, framework-review, rag-hyde,
  rag-multi-query, strategy-llm-failover, market-signals, usage-monitor-replay,
  llm-usage-labels, llm-cache-usage) — 246/246.
- Full serialized gate (lint → tsc → full vitest → build) run before push; results in the PR body.

## Follow-ups / risks

- The monitor-side verification worker (design §3c) consumes `providerRequestId` — Wave 4
  (Usage-Monitor lane), not this PR.
- Chat Path B multi-step tool loops intentionally push NO generation id (aggregate row); if
  per-step verification is ever wanted, the ledger would need per-step rows first.
- OpenRouter rerank responses' `id` field presence was not empirically probed (rerank endpoint
  costs more); `providerRequestIdFromPayload` degrades to `undefined` if absent.
- NO merge by this lane: merging auto-deploys production. Adversarial review lands it.
