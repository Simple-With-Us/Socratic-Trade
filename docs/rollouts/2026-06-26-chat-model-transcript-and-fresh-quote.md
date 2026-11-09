# 2026-06-26 — Per-turn model logging (admin transcript + hover) + fresher chat quote + history prompt

Branch `feat/chat-model-transcript-and-fresh-quote` (throwaway worktree `~/apps/trading-ag13`, off
`origin/main`).

## Summary (operator requests)
1. **Which model said what — logged per turn + shown.** `chat_turns` gains a `model` column; the
   orchestrator records the model on each assistant turn and returns it on the reply.
   - **Admin transcript view** (NEW `app/admin/transcript`): the full conversation with the model that
     produced each assistant reply (badge), plus intent / redacted / timestamp.
   - **Chat hover:** hovering an assistant message shows `Answered by <model>` (title tooltip).
2. **Fresher chat quote (fixes the "as of June 24" staleness).** `getQuote` now prefers Yahoo's live
   `regularMarketPrice` + its real `regularMarketTime` ("yahoo-finance") BEFORE the daily-bar close
   ("yahoo-finance-delayed"). The old behavior used the last NON-NULL daily bar, which is yesterday for
   symbols whose current-session bar hasn't posted yet (and today for others) — hence the mixed dates.
3. **History prompt fix.** Added a CAPABILITIES line telling the model it CAN see recent history (the
   last ~10 turns ARE replayed), so it stops falsely claiming "no memory" when a model is switched
   mid-chat. Bumped `PROMPT_VERSION` 0.6.0 → 0.7.0.

## Files
- `src/lib/db.ts` — migration v5 `chat_turns_model` (ALTER TABLE … ADD COLUMN model) + `model` on the
  base `chat_turns` CREATE.
- `src/lib/types.ts` — `ChatTurn.model?`.
- `src/lib/db-api-keys.ts` — `insertChatTurn`/`mapChatTurn` read/write `model`.
- `src/lib/chat-history.ts` — `appendTurn` accepts `model`.
- `src/lib/chat/types.ts` — `ChatLLM.modelName` (readonly) + `ChatReply.model`.
- `src/lib/chat/llm.ts` — `modelName` on MockLLM ("mock") / AnthropicLLM / OpenAILLM (the model id).
- `src/lib/chat/orchestrator.ts` — record `model.modelName` on the assistant turn + reply; live-quote
  fallback via `fetchYahooFinanceQuote` ahead of the daily-close.
- `src/lib/yahoo-finance.ts` — `YahooFinanceQuote.asOf` from `meta.regularMarketTime`.
- `src/lib/chat/prompt.ts` — history-capability line + PROMPT_VERSION bump.
- `app/ui/assistant-console.tsx` — `ChatMessage.model`; set from reply + chat-history; `title="Answered
  by <model>"` on assistant bubbles.
- `app/admin/transcript/{page,transcript-client}.tsx` — NEW admin transcript view.
- Tests: `test/chat-orchestrator.test.ts` (+model recorded on reply/turn; user turns carry none).

## Verification
- `npx tsc --noEmit` — clean.  `npm test` — 1254 passing.  `npm run build` — clean.
- Live (throwaway `next dev -p 4199`): `POST /api/chat {model:"mock"}` → `reply.model="mock"`;
  `/api/chat-history` new assistant turns carry `model` (older pre-column turns show none, expected);
  `GET /admin/transcript` → 200.
- NOT locally verifiable: the fresher-quote path (this build host's IP is Yahoo-429'd; no Massive key
  here). On the operator's box Yahoo works (their logs show "yahoo-finance-delayed" already), so the
  live `regularMarketPrice` path will now produce a current "as of". Confirm there.

## Notes / follow-ups (answered to operator, not built here)
- **Alerts + notifications**: alerts genuinely fire (60s scheduler); webhook works with no setup;
  push (ntfy/Pushover), email (Resend), SMS (Twilio) are REAL but need provider keys + user prefs.
- **Fancier model dropdown (logos + relative price tiers)** for chat + Strategy Studio — evaluated;
  offered as a follow-up (provider SVGs + a $/$$/$$$ tier from MODEL_PRICE_PER_M).
- **DeepSeek** as a red/green/chat provider — evaluated (OpenAI-compatible, same wiring as gemini/
  mistral); recommended among the top add-ons.
