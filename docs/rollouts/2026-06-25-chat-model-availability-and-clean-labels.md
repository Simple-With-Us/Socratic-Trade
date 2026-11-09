# 2026-06-25 — Chat model picker: real key-availability + clean provider labels

Branch `feat/chat-model-availability` (throwaway worktree `~/apps/trading-ag13`), stacked on
#169. Refinement of the five-provider LLM work (#167, #169) per operator feedback.

## Summary
1. **No more "needs key" / OpenAI-special labels.** The chat picker and the Strategy Studio Green/Red
   Team dropdowns no longer annotate non-OpenAI providers with "(needs X key)" / "requires X key in
   Connections". OpenAI is treated like every other provider (nothing free/special about it). Group
   labels are now just the provider name: OpenAI, Anthropic, xAI (Grok), Google Gemini, Mistral.
2. **No failover commentary in the UI.** Removed the "operator key is the backup" wording from the
   Green Team hint — the app just works; we don't narrate the key it falls back to.
3. **Chat picker reflects real key availability.** New `GET /api/chat/providers` returns booleans-only
   per provider (never the key), computed with `resolveLlmCredential` — the same check `llmForModel`
   uses to decide real-vs-mock, so a provider shows available whenever the app can actually serve it
   (a user's own key OR any resolvable key; no distinction surfaced). The Assistant fetches it and, for
   any provider whose key isn't resolvable, labels its group "— no key" and disables its options.
   Loads fail-open (every provider stays selectable until/if the check says otherwise). Offline Mock is
   always available.

With live keys present for all five providers, every group renders clean and selectable.

## Files
- `app/api/chat/providers/route.ts` — NEW. GET → `{ providers: { openai, anthropic, xai, gemini,
  mistral } }` booleans via `resolveLlmCredential(service, userId)`. No key value is ever returned.
- `app/ui/assistant-console.tsx` — `CHAT_MODEL_GROUPS` gain a `provider` id and clean labels (dropped
  the "(needs … key)" suffixes); new `providerStatus` state fetched from `/api/chat/providers`; missing
  providers get a "— no key" group label + disabled options; tooltip reworded (no OpenAI-special text).
- `app/dashboard-client.tsx` — Green/Red Team optgroup labels cleaned ("xAI (Grok)", "Google Gemini",
  "Mistral" — dropped "requires … key in Connections"); Green Team hint reworded to drop the
  operator-backup/failover mention.
- `test/chat-providers-route.test.ts` — NEW. All-keyed→all true (failover on); no-key+failover-off→all
  false; mixed→only the keyed provider true (independent reporting).

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 1246/1246 passing (138 files).
- `npm run build` — clean.
- Live (throwaway `next dev -p 4199`, torn down): with only `OPENAI_API_KEY` set,
  `GET /api/chat/providers` → `{openai:true, anthropic:false, xai:false, gemini:false, mistral:false}`
  (independent per-provider reporting); dashboard `GET /` → 200.

## Follow-ups / risks
- Availability is per-request for the resolved user; it does NOT distinguish a user's own key from any
  other resolvable key (deliberate — the picker only needs "usable or not").
- Strategy Studio dropdowns got the label cleanup but NOT the dynamic "— no key" detection (the operator
  asked for the dynamic behavior on the chat picker specifically). Easy to extend later if wanted.
- The dropdown's disabled-group behavior wasn't screenshot-verified (MCP preview is bound to a different
  worktree); it's covered by the type-checked render + the verified availability endpoint.
