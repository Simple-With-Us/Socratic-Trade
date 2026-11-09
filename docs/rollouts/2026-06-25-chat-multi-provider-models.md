# 2026-06-25 — Assistant chat across all five LLM providers (OpenAI · Anthropic · xAI · Gemini · Mistral)

Branch `feat/chat-multi-provider` (throwaway worktree `~/apps/trading-ag13`, off `origin/main`).

## Summary
The Assistant chat could previously use only OpenAI or Anthropic. It now spans **five** providers —
OpenAI, Anthropic, xAI (Grok), Google Gemini, Mistral — with a few recommended models per provider
(spanning cost ↔ capability), selectable from the Assistant header. Routing is purely by model name;
the matching provider key resolves per-user-first with the operator-funded env failover.

Note: an earlier PR (#161) that was supposed to add Gemini/Mistral never landed — the word
"gemini"/"mistral" appeared nowhere in `main`. This change adds the full credential plumbing for both
from scratch (chat path only; the strategy `resolveLlmEndpoint`/Strategy-Studio dropdowns still cover
only OpenAI + xAI and were intentionally left for a separate change).

## Why
User request: "set it up so chat can use any of the 5 different ai providers and that it has
option(s) for each for the few ones we recommend ... depending on performance, suitability, and
pricing." Closes the deferred §3 "Multi-LLM requirement" in `docs/chat-assistant-rag-learning.md`
(selector + adapters + per-provider key resolution).

## Design
- **Routing by model name** (no separate provider flag): `chatProviderForModel(model)` →
  `claude-*`→anthropic, `grok-*`→xai, `gemini-*`→gemini, `mistral|ministral|codestral|…`→mistral,
  else openai. `llmForModel(model, userId, opts)` builds the right `ChatLLM`.
- **One tool loop for four providers:** xAI/Gemini/Mistral are OpenAI-compatible, so they reuse
  `OpenAILLM` (chat/completions function-calling) with only a per-provider base URL + Bearer key
  (`openAiCompatChatUrl` + `makeOpenAITransport`). Anthropic keeps its Messages loop (`AnthropicLLM`).
  `OpenAILLM` gained an optional `provider` arg so the usage ledger attributes cost to the real
  provider, not always "openai".
- **No cross-provider key borrowing:** a model whose provider has no key → `MockLLM` (graceful
  offline degradation), never a different provider's key.
- **UI = per-request hint, no DB migration:** the Assistant dropdown sends a `model` hint to
  `/api/chat`; selection is sticky via `localStorage`. Route precedence: `model` hint →
  legacy `provider` hint → env default (`getLLM`). `getLLM` and its tests are unchanged.
- **Recommended models** (UI): OpenAI gpt-5.4-nano/mini/`5.4`; Anthropic claude-haiku-4-5/
  sonnet-4-6/opus-4-8; xAI grok-build-0.1/4.3; Gemini gemini-2.5-flash-lite/flash/3.5-flash;
  Mistral small/medium/large-latest; plus a Mock (offline) option. Default `gpt-5.4-mini`.

## Files
- `src/lib/db-api-keys.ts` — `API_KEY_ENV_MAP` (+`gemini`/`mistral`), `API_KEY_SERVICE_ALIASES`
  (+gemini/mistral aliases), `resolveLlmCredential` service union (+gemini/mistral),
  `LOCAL_ENV_MIGRATION_SERVICES` (+gemini/mistral), per-user-only tier comment.
- `src/lib/chat/llm.ts` — `ChatProvider` type; widened `recordChatUsage` provider union; `OpenAILLM`
  optional `provider` arg used for ledger attribution; `chatProviderForModel`, `openAiCompatChatUrl`,
  `makeOpenAITransport`, and exported `llmForModel`. `getLLM` left as-is.
- `app/api/chat/route.ts` — accept `model` in the body; route via `llmForModel` ahead of the legacy
  provider hint / env default.
- `app/api/keys/route.ts` — catalog rows for Anthropic (Claude), Google Gemini, Mistral AI
  (category "LLM"); previously only OpenAI + xAI were offered.
- `app/ui/assistant-console.tsx` — replaced the 3-option provider `<select>` with a 5-provider
  optgroup model selector; `localStorage` persistence; sends `model`; prop `defaultProvider` →
  `defaultModel`.
- `src/lib/llm-usage.ts` — `MODEL_PRICE_PER_M` rows for gemini-2.5-flash-lite/flash, gemini-3.5-flash,
  mistral-small/medium/large (best-effort).
- `test/chat-llm.test.ts` — new `chatProviderForModel` + `llmForModel` multi-provider routing suites
  (instance-by-provider, no cross-provider borrowing, keyless→Mock).
- `docs/chat-assistant-rag-learning.md` — §3 marked DONE.

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 1228/1228 passing (136 files); includes the new routing assertions.
- `npm run build` — clean.
- Live (throwaway `next dev -p 4199` in the ag13 worktree, torn down after):
  - `GET /api/keys` → catalog now lists OpenAI (Required) + Anthropic/xAI/Gemini/Mistral (LLM).
  - `POST /api/chat {model:"mock"}` → routes through `llmForModel`→`MockLLM`, returns a grounded
    reply (intent `chat`).
  - `POST /api/chat {model:"gemini-2.5-flash"}` with no Gemini key → `200` (graceful Mock, no crash).
  - `GET /` (dashboard hosting `AssistantView`) → `200`, no SSR error.

## Follow-ups / risks
- Strategy loop (`resolveLlmEndpoint`) + Strategy-Studio dropdowns still cover only OpenAI + xAI.
  Extending those to Gemini/Mistral is a separate, intentional follow-up (this change is chat-scoped).
- Live calls against real Grok/Gemini/Mistral endpoints were not exercised (no keys available in this
  environment); routing + key resolution are covered by unit tests and the base URLs are the standard
  OpenAI-compatible endpoints (env-overridable via `XAI_API_URL` / `GEMINI_API_URL` / `MISTRAL_API_URL`).
- Pricing for the new models is best-effort; unknown/dated suffixes fall back to prefix match.
