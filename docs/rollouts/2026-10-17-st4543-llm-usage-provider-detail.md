# 2026-10-17 - st4543-llm-usage-provider-detail

## Summary

- The Usage Monitor LLM push now carries the canonical `ai` block (shared v2.8.1, UM-1592) with cache reads, cache writes (5m/1h), reasoning tokens, served vs requested model, latency and cost source.
- OpenRouter-billed spend (`usage.cost`) is sent as `billingMode: "actual"` / `confidence: "actual"`; price-table spend stays `estimated`.
- The chat tool loop threads cache, reasoning, served model and billed cost from the provider response into `recordLlmUsage` (summed across steps; billed only when every step reported a cost).
- Migration 99 `llm_usage_provider_detail` adds six nullable columns to `llm_usage`: `cached_prompt_tokens`, `cache_creation_tokens`, `cache_creation_1h_tokens`, `reasoning_tokens`, `served_model`, `request_count`.

## Why

- Audit 2026-10-15 found the push dropped fields the ledger already had and mislabelled billed spend as estimated.
- `usage-monitor-replay.ts` rebuilds events from ledger rows and the monitor 409s a changed idempotency payload, so the detail must live in the ledger for replay to match the live event.

## Files changed

- `src/lib/llm-usage.ts`, `src/lib/chat/llm.ts`, `src/lib/usage-monitor-push.ts`, `src/lib/usage-monitor-replay.ts`, `src/lib/db.ts`
- `test/usage-monitor-llm-ai-block.test.ts`, `test/chat-llm-usage-detail.test.ts`, `test/persistence-hardening.test.ts`
- `package.json`, `package-lock.json` (shared v2.7.1 to v2.8.1)

## Verification

- `npm run lint` (eslint on every changed file) -> ok, no new warnings
- `npx tsc --noEmit` -> ok
- `npm test` -> ok in CI (`verify-hosted` green on the PR head); locally the usage, replay, chat-llm and persistence suites pass, including a test that a live event and its replay serialise identically
- `npm run build` -> not run locally; the change is typechecked TypeScript only
- Migration is additive and idempotent (`columnExists` guards); it runs at process start through `applyVersionedMigrations`, and there is no separate admin migrate route in this repo.
- Production: read-only query of `ExternalUsageEvent` for `sourceApp = 'socratic-trade'` after deploy, checking `_aiSource = 'block'`, `_aiTokensCacheRead` and `billingMode`.

## Follow-ups

- `providerRequestId` is still not stored on `llm_usage`, so a replayed event omits it (pre-existing; the replay 409 self-heal covers a collision).
- Rows written before migration 99 have no detail and replay with prompt/completion tokens only.
