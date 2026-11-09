# 2026-06-26 — DeepSeek as 6th LLM Provider

## Summary

Added DeepSeek as a 6th LLM provider (OpenAI-compatible) alongside OpenAI, Anthropic, xAI, Google Gemini, and Mistral.

## Why

User requested DeepSeek support. DeepSeek's API is fully OpenAI-compatible (chat/completions), uses automatic prefix caching (~10× cost reduction for repeated context), and exposes two models of interest: `deepseek-chat` (balanced, V3/V4) and `deepseek-reasoner` (R1 chain-of-thought, strong adversarial reasoning for the red team).

## Files Touched

- `src/lib/llm-provider.ts` — added `"deepseek"` to `LlmEndpoint.provider` union; added `if (/^deepseek/i.test(model))` branch in `resolveLlmEndpoint` with `DEEPSEEK_API_URL` env override and `DEEPSEEK_API_KEY` credential lookup
- `src/lib/chat/llm.ts` — added `"deepseek"` to `ChatProvider` type, `chatProviderForModel`, `openAiCompatChatUrl`, `makeOpenAITransport` signature, `OpenAILLM` constructor `provider` parameter
- `src/lib/llm-errors.ts` — added `"DeepSeek"` to `LlmProviderName`, `case "deepseek"` in `providerLabel`, deepseek detection in `providerFromText`
- `src/lib/db-api-keys.ts` — added `deepseek: "DEEPSEEK_API_KEY"` to `API_KEY_ENV_MAP`; `deepseek`/`deepseek_api_key` aliases; `"deepseek"` to `resolveLlmCredential` service union and `LOCAL_ENV_MIGRATION_SERVICES`
- `app/api/keys/route.ts` — added DeepSeek catalog entry (label, category LLM, docsUrl platform.deepseek.com)
- `app/dashboard-client.tsx` — added DeepSeek optgroup (`deepseek-chat`, `deepseek-reasoner`) to both Green Team and Red Team model dropdowns
- `.env.example` — added `DEEPSEEK_API_KEY`/`DEEPSEEK_API_URL` block; updated comment from "five" to "six"
- `STATUS.md`, `docs/rollouts/2026-06-26-deepseek-provider.md` (this file)

## Verification

```
npx tsc --noEmit   # clean
npm test           # 1243/1243 passed
npm run build      # clean
```

## Follow-ups

- DeepSeek prefix caching is automatic (no API changes needed); no Anthropic-style explicit cache_control required.
- `deepseek-reasoner` (R1) is a good candidate for the red team slot given strong chain-of-thought reasoning.
- No real-money trades; paper mode default unchanged.
