# 2026-06-22 — Add xAI / Grok as an LLM provider option

## Summary

Grok (xAI) is now a selectable LLM provider for the agentic loop. xAI's API is
OpenAI-compatible, so the design is: **the provider is derived from the model name** —
a `grok-*` model routes to xAI (chat-completions, `api.x.ai`) with the xAI key; any
other model keeps today's OpenAI path. No new provider toggle. **Default behavior is
unchanged** (default model → OpenAI); the "make the cheap Grok the keyless default"
decision is intentionally deferred.

## Why

Grok-4.3 is competitively priced ($1.25/$2.50 per Mtok) with 1M context, reasoning,
function calling, and structured output — and the app already speaks OpenAI-compatible
API with per-user/operator key resolution + failover + a usage ledger, so adding Grok
is low-cost. Good as a cost-failover / alternative to OpenAI for proposal generation,
the bull/bear debate, tuning, revalidation, and post-mortem reflection.

## Changes

- **`src/lib/llm-provider.ts`** (new) — `resolveLlmEndpoint(policy, userId)`: `grok-*`
  model → `{ provider: "xai", url: XAI_API_URL ?? https://api.x.ai/v1/chat/completions,
  key: resolveLlmCredential("xai"), transport: "chat-completions" }`; else the existing
  OpenAI path (preserving `OPENAI_API_URL` + responses-vs-chat-completions logic).
- **`src/lib/db-api-keys.ts`** — `xai → XAI_API_KEY` in `API_KEY_ENV_MAP`; `xai_api_key`/
  `grok`/`grok_api_key`/`xai` aliases; `resolveLlmCredential` service type widened to
  include `"xai"` (per-user key first + operator env failover, same as openai/anthropic);
  `"xai"` added to `LOCAL_ENV_MIGRATION_SERVICES` (operator `XAI_API_KEY` migrates into the
  `local` store at boot).
- **`app/api/keys/route.ts`** — `xai` entry in `API_KEY_CATALOG` (label "xAI (Grok)",
  category "LLM"). The keys settings UI is data-driven off this catalog, so the row
  appears automatically.
- **6 agentic LLM call sites** — `strategy.ts` (Bull + Bear, one shared resolve),
  `red-team.ts`, `strategy-tuning.ts`, `proposal-revalidation.ts`, `post-mortem.ts`: use
  `resolveLlmEndpoint` instead of the hardcoded `resolveLlmCredential("openai")` +
  `OPENAI_API_URL` + `resolveOpenAiModel` trio; pass the resolved `provider` (not literal
  "openai") to `recordLlmUsage` so the cost ledger attributes Grok correctly.
- **`app/dashboard-client.tsx`** — LLM model dropdown gains an `<optgroup>` with
  `grok-4.3` and `grok-build-0.1` (+ hint that a grok model uses the xAI key).
- **`.env.example`** — `XAI_API_KEY`, `XAI_API_URL`.
- **`test/llm-provider.test.ts`** (new) — grok-* → xAI/chat-completions; gpt-* → openai;
  empty policy → openai (default unchanged); `XAI_API_URL` override.

## Transport-default fix (important — caught in verification)

The OpenAI call sites historically defaulted to DIFFERENT endpoints: `strategy` /
`strategy-tuning` / `proposal-revalidation` → `/v1/responses`; `red-team` / `post-mortem`
→ `/v1/chat/completions`. The first cut of `resolveLlmEndpoint` collapsed them to one
chat-completions default, which flipped strategy's transport (`max_output_tokens` →
`max_tokens`) and broke a test. Fix: `resolveLlmEndpoint(policy, userId, defaultOpenAiUrl)`
— default `/v1/responses`; `red-team` + `post-mortem` pass `/v1/chat/completions` to
preserve their original transport. (Also fixed a TDZ where `policy` was used before its
declaration in `post-mortem.ts`.) xAI is always chat-completions.

## Verification

Isolated worktree off `origin/main`:
- `npx tsc --noEmit` — clean
- `npm test` — **869 pass** (96 files)
- `npm run build` — green

## How to use / follow-ups

- **Use Grok:** add an xAI key in Settings → API keys (or set operator `XAI_API_KEY`),
  then pick a `grok-*` model in the LLM model dropdown.
- **Deferred decision:** to make a cheap Grok the keyless/operator default, set the default
  model to `grok-build-0.1` (env `OPENAI_MODEL` / `DEFAULT_OPENAI_MODEL`) — left unchanged
  for now per owner ("undecided").
- The Anthropic **chat assistant** path is untouched; pointing it at Grok would be a
  separate change (it has its own transport, overridable via `OPENAI_CHAT_URL`).
- xAI structured-output / tool-calling is assumed compatible with the OpenAI schema the
  app sends (per xAI's capability surface); validate against a live key before making Grok
  a primary path.
