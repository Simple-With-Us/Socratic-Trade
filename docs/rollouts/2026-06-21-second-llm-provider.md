# 2026-06-21 — Second LLM Provider: OpenAILLM + Provider Selector

## Summary

Added `OpenAILLM` as a second concrete `ChatLLM` implementation alongside the existing
`AnthropicLLM` and `MockLLM`. Extended `getLLM()` to branch on `CHAT_LLM=openai`, wired a
per-request provider hint through the chat API route, and added a model-selector dropdown to the
assistant console header. Also added `anthropic` to the `API_KEY_ENV_MAP` in `db.ts` so that
`resolveApiKey("anthropic")` now resolves from `ANTHROPIC_API_KEY` in addition to user-stored DB
keys.

## Why

The chat assistant previously had only one real provider (Anthropic) and a deterministic MockLLM.
Users and operators who supply an OpenAI key needed a supported path. The spec (spec key:
`second-llm-provider`) called for an injectable-transport approach matching AnthropicLLM so the
class is fully unit-testable offline.

The design choice (per-request hint vs. full per-user persistence) is deliberate: defaulting to
the env var avoids any DB migration in this slice. The UI dropdown sends the selection as a
`provider` field in the POST body; the route constructs a fresh orchestrator for that request.
Persisting a per-user preference is noted as a follow-up.

## Files

- `src/lib/chat/llm.ts` — Added `OpenAILLM` class with injectable `OpenAITransport`, expanded
  `getLLM()` to branch on `CHAT_LLM=openai`.
- `src/lib/db.ts` — Added `anthropic: "ANTHROPIC_API_KEY"` to `API_KEY_ENV_MAP` and
  `anthropic_api_key: "anthropic"` alias to `API_KEY_SERVICE_ALIASES`.
- `app/ui/assistant-console.tsx` — Added `ChatProvider` type, `PROVIDER_LABELS` map, `provider`
  state, model-selector `<select>` in the header, and passes `provider` in the POST body.
- `app/api/chat/route.ts` — Reads `body.provider` hint, constructs the appropriate LLM instance
  via `llmFromProvider()`, and falls through to the lazy singleton when no recognized hint arrives.
- `test/chat-llm.test.ts` — New test file: 14 tests covering `OpenAILLM` contract (plain
  response, system prompt, tool calling, citations, history, error handling, DISCLAIMER fallback)
  and `getLLM()` provider routing (MockLLM fallback, OpenAI routing, Anthropic routing).

## Verification

```
cd /Users/jay/apps/wt-llm
npx tsc --noEmit      # clean (no output)
npm test              # 478 passed, 0 failed
```

All 14 new tests pass. No existing tests broken.

## Open design / follow-ups

- Per-user provider preference is not persisted (no DB migration in this slice). The dropdown
  resets to `defaultProvider` on page reload. A `user_settings` column or a separate preference
  endpoint would be the natural next step.
- `OPENAI_CHAT_URL` env var overrides the endpoint for `OpenAILLM` (mirrors the strategy module
  pattern), useful for Azure OpenAI or local proxies.
- `CHAT_LLM_MODEL` is shared between Anthropic and OpenAI paths; a per-provider model override
  (`CHAT_LLM_MODEL_OPENAI`, `CHAT_LLM_MODEL_ANTHROPIC`) could be added if needed.
- `anthropic` was not previously in `API_KEY_ENV_MAP`; any existing code calling
  `resolveApiKey("anthropic")` (only `getLLM()`) silently fell back to MockLLM when the key
  came from the environment. That is now fixed.
