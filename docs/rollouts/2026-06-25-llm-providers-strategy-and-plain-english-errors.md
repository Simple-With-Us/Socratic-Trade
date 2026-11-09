# 2026-06-25 — Five-provider LLM everywhere: strategy loop, key backups, plain-English errors, labeled mock

Branch `feat/llm-providers-strategy-and-errors` (throwaway worktree `~/apps/trading-ag13`, off
`origin/main` after #167). Follow-up to #167 (which made the **chat** Assistant five-provider).

## Summary
Four related changes the user asked for:
1. **Strategy loop now spans all five providers.** `resolveLlmEndpoint` gained Gemini + Mistral
   branches (mirroring xAI/Grok — OpenAI-compatible chat/completions, per-provider base URL + key).
   Strategy Studio's Green Team and Red Team model dropdowns gained Google Gemini + Mistral optgroups
   (recommended models, cost ↔ capability). So proposal generation, the Red Team Bear, strategy
   tuning, proposal re-validation, and post-mortems can all run on any of the five.
2. **All five provider keys are operator-funded backups; the user's own key wins.** This was already
   the resolution model (`resolveLlmCredential`, per-user-first → flag-gated operator failover); the
   change documents all five env keys in `.env.example` and the Strategy Studio hint, and the new
   Gemini/Mistral branches route through the same resolver.
3. **Plain-English API-key errors.** New pure helper `src/lib/llm-errors.ts` →
   `humanizeLlmError(raw, { provider?, status? })` maps raw provider errors (401/403/404/429/5xx/
   timeout/context-length) to short, actionable, provider-named sentences; unknown shapes fall back
   to the trimmed raw text (nothing hidden). Wired into the chat client (`assistant-console`,
   replacing two hard-coded regexes — now covers all five), the green proposal path and strategy
   tuning (thrown error), the Red Team debate `reason` (user-visible), and the revalidation/
   post-mortem operator logs. The chat OpenAI-compat transport now names its provider in the thrown
   error so the humanizer labels it correctly.
4. **MockLLM labels every answer.** `MockLLM.run` now wraps its deterministic answer with a
   `"Mock Response: "` prefix (idempotent) so a mock reply can never be mistaken for a real model.

## Files
- `src/lib/llm-provider.ts` — `LlmEndpoint.provider` union += gemini|mistral; new gemini + mistral
  branches (env-overridable `GEMINI_API_URL` / `MISTRAL_API_URL`).
- `src/lib/llm-errors.ts` — NEW pure helper (`humanizeLlmError`, `providerLabel`, `providerFromText`).
- `src/lib/chat/llm.ts` — `MockLLM` run/answer split + `"Mock Response: "` label; `makeOpenAITransport`
  now provider-aware (throws a provider-named error).
- `src/lib/strategy.ts`, `src/lib/strategy-tuning.ts` — throw `humanizeLlmError(...)` on non-OK LLM
  responses (was a raw `OpenAI request failed with …`, which also mislabeled grok/gemini/mistral).
- `src/lib/red-team.ts` — debate `reason` + log use `humanizeLlmError`.
- `src/lib/proposal-revalidation.ts`, `src/lib/post-mortem.ts` — humanized operator logs.
- `app/ui/assistant-console.tsx` — chat error handler uses `humanizeLlmError` (all five providers).
- `app/dashboard-client.tsx` — Green + Red Team dropdowns gain Gemini + Mistral optgroups; Green hint
  updated to explain per-provider keys + operator backup.
- `.env.example` — documents `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/`GEMINI_API_URL`,
  `MISTRAL_API_KEY`/`MISTRAL_API_URL` as operator backups (user keys win).
- Tests: `test/llm-provider.test.ts` (+gemini/mistral routing, URL overrides, red-team routing);
  `test/llm-errors.test.ts` (NEW); `test/chat-llm.test.ts` (+MockLLM label assertions).

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 1243/1243 passing (137 files).
- `npm run build` — clean.
- Live (throwaway `next dev -p 4199`, torn down): chat `{model:"mock"}` reply starts with
  `"Mock Response: "`; a `gemini-*` model with no key → graceful labeled mock (no crash);
  dashboard `GET /` → 200.

## Follow-ups / risks
- Real Grok/Gemini/Mistral calls weren't exercised end-to-end (no live keys here); routing + key
  resolution + error mapping are unit-tested, and the base URLs are the standard OpenAI-compatible
  endpoints (env-overridable). The first real run on a new provider should be smoke-tested with a key.
- `humanizeLlmError` pattern-matches English provider bodies; a non-English/odd error still surfaces
  verbatim (provider-prefixed) rather than being misclassified.
- Mock label is a single prefix per answer (idempotent); multi-sentence mock replies are labeled once
  at the top, which is enough to make the mock origin unmistakable.
