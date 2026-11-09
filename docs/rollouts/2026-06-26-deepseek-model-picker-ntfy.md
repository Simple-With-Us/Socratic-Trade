# 2026-06-26 — DeepSeek provider + custom model picker (logos + price tiers) + ntfy guidance

Branch `feat/deepseek-ntfy-price-tiers` (throwaway worktree `~/apps/trading-ag13`, off `origin/main`).

## 1. DeepSeek as a 6th provider (chat + strategy)
Same OpenAI-compatible wiring as gemini/mistral:
- `src/lib/db-api-keys.ts` — `DEEPSEEK_API_KEY` env map, `deepseek`/`deepseek_api_key` aliases,
  `resolveLlmCredential` union, `LOCAL_ENV_MIGRATION_SERVICES`.
- `src/lib/llm-provider.ts` — `resolveLlmEndpoint` `deepseek` branch (url
  `https://api.deepseek.com/v1/chat/completions`, env-overridable `DEEPSEEK_API_URL`), provider union.
- `src/lib/chat/llm.ts` — `ChatProvider` + OpenAILLM provider unions; `chatProviderForModel` deepseek-*;
  `openAiCompatChatUrl`/`makeOpenAITransport` (now typed `OpenAiCompatProvider`).
- `app/api/chat/providers/route.ts` — availability includes `deepseek`.
- `app/api/keys/route.ts` — DeepSeek catalog row (LLM), with a China-data-residency note.
- `src/lib/llm-usage.ts` — `deepseek-chat` / `deepseek-reasoner` pricing.
- `src/lib/llm-errors.ts` — DeepSeek in `providerLabel` / `providerFromText`.
- `app/dashboard-client.tsx` — DeepSeek optgroup in Strategy Studio Green + Red selects.
- Chat picker offers `deepseek-chat` (V3 — cheap, tool-capable) + `deepseek-reasoner` (R1 — reasoning,
  limited tools). **Caveat surfaced in the catalog:** DeepSeek processes requests on its servers (China).

## 2. Custom model picker with provider logos + relative price tiers (chat)
- NEW `app/ui/model-picker.tsx` (`ModelPicker`) replaces the native `<select>` in the Assistant:
  provider logo + model id + a $/$$/$$$ relative-cost tier per option, grouped by provider, with the
  same availability logic ("no key" + disabled when the provider's key isn't resolvable).
- Logos load from `/public/model-logos/<provider>.svg` on a white tile (visible in any theme); a missing
  file falls back to a colored initial chip (no error), so it looks intentional before the SVGs land.
- `app/ui/assistant-console.tsx` — `CHAT_MODEL_GROUPS` now carry `provider` + `tier`; uses `ModelPicker`.
- `public/model-logos/README.md` — documents the expected filenames.
- **Logo assets NOT included** — the operator's SVGs live in iCloud Drive, which macOS blocks the app
  from reading (EPERM via both Bash and Read). The operator copies the 6 SVGs into
  `public/model-logos/{openai,anthropic,xai,gemini,mistral,deepseek}.svg` (from a non-iCloud path) and
  the logos appear with no code change. Strategy Studio dropdowns stay native (logo picker there = a
  follow-up).

## 3. ntfy push
Already the default push provider (available with no key) via the #180 delivery panel — improved the
hint to make the free/no-key flow explicit: install the ntfy app, subscribe to a hard-to-guess topic,
paste that topic. (`src/lib/notify.ts`.)

## Verification
- `npx tsc --noEmit` clean · `npm test` 1254 passing (DeepSeek added to chat-llm / llm-provider /
  chat-providers-route tests) · `npm run build` clean.
- Live (`next dev -p 4199`): `/api/chat/providers` lists deepseek; `/api/keys` LLM rows include DeepSeek;
  `POST /api/chat {model:"deepseek-chat"}` → 200 (graceful Mock with no key here); dashboard 200.
- NOT verified: the custom dropdown's visual rendering (client-only; MCP preview is bound to another
  worktree) and the logos (no SVG assets here). The fallback chips + build + provider logic are sound.

## Follow-ups
- Operator drops the 6 logo SVGs into `public/model-logos/` (or moves them out of iCloud so I can commit
  them). DeepSeek key set in Infisical (`DEEPSEEK_API_KEY`) to use it. Logo-picker for Strategy Studio.
