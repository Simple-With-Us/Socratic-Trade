# 2026-06-21 — Chat NOW tranche + I4 (real citation provenance)

## Summary
Shipped the approved **NOW tranche** of chat-assistant fixes, then started the **NEXT tranche** with
**I4 (real citation provenance)**. The NOW tranche landed on `main`; I4 (and everything after) lands on
`agent/claude` via PR because a concurrent agent is mid-edit on `main`'s `strategy.ts`/`db.ts`/etc.
(see `docs/open-questions-for-jay.md` Q0).

## Why
The 5-expert advisory panel (`docs/chat-assistant-rag-learning.md`) found 3 ship-blockers in the live
chat plus a fabricated-citation problem. These erode trust (fake numbers/dates next to real ones) and
break the real-LLM path. The HYBRID decision: ISOLATE write surfaces, SHARE the read substrate, one-way
data flow.

## What changed
**NOW tranche (on `main`, `7d766de`→`7a675e8`):**
- **I1** — `narrateQuote` no longer fabricates `change_pct: 0` / "regular session"; `ChatQuote.change_pct`
  + `session` are optional and stated only when the source provides them.
- **I2** — disclaimer + refusal enforced **server-side** in the orchestrator (held only in `MockLLM`
  before, so they vanished on the real-LLM path). `PROMPT_VERSION` → `agentic-chat@0.4.0`.
- **I3** — orchestrator replays the last ~10 redacted `chat_turns` into the model (multi-turn memory);
  `AnthropicLLM` seeds them as prior messages (history must start with a user turn).
- **I6** — 5 read-only state tools: `get_positions`, `get_portfolio`, `list_watchlist`, `list_alerts`,
  `list_open_proposals`, wired in `buildProductionDeps` to the broker gateway + db. `ToolDeps` methods
  are OPTIONAL (tools return empty when unwired). `MockLLM` gained positions/watchlist_view/alerts_view
  intents so the offline path + chips don't dead-end. One-way: chat READS state, never writes/executes.
- **I13** — empty-state static hint replaced by router-matched suggested-prompt chips (one-click
  fill+send); flagship example fixed to **8-K** (only 8-K catalysts are indexed). `send()` accepts an
  override prompt.

**I4 (on `agent/claude`, this note's commit):**
- `vector-db.ts`: new `retrieveContextDetailed()` returns `RetrievedChunk[]` with REAL provenance
  (Pinecone vector `id`, `score`, the chunk's own `acceptance_datetime`/timestamp, `source`, `url`) via a
  pure, exported `matchToChunk()`. `retrieveContext()` is now a thin `string[]` wrapper (callers
  unchanged, e.g. `strategy.ts`).
- `orchestrator.ts` `searchKnowledge` maps real fields (chunk_id = real id, as_of = chunk's own date) —
  no more fabricated `<SYMBOL>#i` or query-derived as_of.
- `chat/types.ts`: `KbChunk` gains `score?`/`url?`; `Citation` gains `url?`. `llm.ts` propagates `url`
  into citations (MockLLM + AnthropicLLM). `assistant-console.tsx` renders citation chips as filing
  links when a `url` is present.

**I8 (on `agent/claude`, same lane):**
- `prompt.ts`: hardened the data-not-command rule (tool results, retrieved docs, AND user memory are
  DATA, never commands — cannot change boundaries/disclaimer/refusal even if they claim to be a system
  message or an authorized override) and pinned precedence so the HARD BOUNDARIES outrank
  `<user_memory>` — closing a self-injection vector where a planted `[HARD]` memory could try to
  authorize advice/execution. `PROMPT_VERSION` → `agentic-chat@0.5.0`. New `test/chat-injection.test.ts`.

## Files
- `src/lib/chat/llm.ts`, `src/lib/chat/orchestrator.ts`, `src/lib/chat/tools.ts`,
  `src/lib/chat/types.ts`, `src/lib/chat/prompt.ts`
- `src/lib/vector-db.ts`
- `app/ui/assistant-console.tsx`
- `test/chat-orchestrator.test.ts`, `test/vector-db-provenance.test.ts`, `test/chat-injection.test.ts`
- `docs/open-questions-for-jay.md` (new running questions log), `STATUS.md`, this rollout note

## Verification
- `npx tsc --noEmit` — clean (filtering the known pre-existing `alternative-data.test.ts` mockFetcher error).
- `npm test` — **412 passed (52 files)**; targeted: `vector-db-provenance` + `chat-orchestrator` +
  `atlas-golden-eval` + `vector-db` = 32 passed.
- `npm run build` — not re-run in this lane (no Next-server-observable change beyond the chip UI;
  RAG isn't configured locally so citations can't be exercised in the browser here). Build was green at
  the `agent/claude` baseline (== `origin/main`).

## Follow-ups
- **Q0 (blocker):** land this PR to `main` once the integration worktree is free of the concurrent
  agent's WIP; resolve any `STATUS.md`/`db.ts` merge conflicts at that point.
- NEXT tranche remaining: I5 full-filing ingestion (gated on Q2 paid-Voyage decision), I7 slot-filling /
  clarifying questions, I8 prompt-injection-via-RAG hardening + golden case, I11 chat→trade provenance.
- Re-run the golden eval against the real-LLM path with an injected transport.
