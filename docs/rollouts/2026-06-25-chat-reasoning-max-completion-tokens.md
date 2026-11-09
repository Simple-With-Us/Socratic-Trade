# 2026-06-25 — Fix: chat OpenAI reasoning models need max_completion_tokens

Branch `fix/chat-reasoning-max-completion-tokens` (throwaway worktree `~/apps/trading-ag13`, off
`origin/main`). Bug introduced by #167 (chat default model became `gpt-5.4-mini`).

## Symptom
Sending a chat message with an OpenAI reasoning model selected (gpt-5.x / o-series — including the new
default `gpt-5.4-mini`) returned:

> OpenAI error: openai 400: Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.

## Cause
The chat path's `OpenAILLM.run` (`src/lib/chat/llm.ts`) hard-coded `max_tokens: 1024` in the
chat/completions body. OpenAI's reasoning models reject `max_tokens` and require `max_completion_tokens`.
This was latent until #167 changed the chat default from `gpt-4o-mini` (classic, accepts `max_tokens`)
to `gpt-5.4-mini` (reasoning). The strategy path was already correct (`withLlmRequestBounds` renames the
param for reasoning models); only the chat path was missed.

## Fix
`OpenAILLM.run` now picks the token-cap param by model + provider:
- OpenAI reasoning model (`isReasoningModel` = gpt-5 / o-series) → `max_completion_tokens: 4096`
  (higher cap so hidden reasoning tokens don't starve the visible answer).
- Everything else (OpenAI classic models, and OpenAI-compatible xAI/Gemini/Mistral) → `max_tokens: 1024`.
The provider gate ensures the OpenAI-only param is never sent to an OpenAI-compatible endpoint.
Anthropic's path is unaffected (Anthropic's Messages API legitimately uses `max_tokens`).

## Files
- `src/lib/chat/llm.ts` — import `isReasoningModel`; compute `tokenCap` once per `run()` and spread it
  into the request body instead of the hard-coded `max_tokens: 1024`.
- `test/chat-llm.test.ts` — three assertions: reasoning OpenAI model → `max_completion_tokens` (no
  `max_tokens`); classic OpenAI model → `max_tokens`; OpenAI-compatible provider → `max_tokens` only.

## Verification
- `npx tsc --noEmit` — clean (after clearing a stale `.next/dev/` validator left by a prior dev server
  in this worktree — `next build` doesn't clean that subfolder; `rm -rf .next && npm run build` fixes it).
- `npm test` — 1247/1247 passing.
- `npm run build` — clean.

## Follow-ups
- 4096 completion-token cap for reasoning chat is a balance (room for reasoning + a normal answer at
  bounded cost). Bump if a reasoning model ever truncates a visible answer.
