# 2026-06-21 — Chat/RAG/learning advisory: HYBRID decision + issue log

## Summary

Ran a 5-agent expert panel (RAG · NL-finance-chat · conversational-onboarding · prompt/tool
engineering · LLM memory/learning) over the shipped chat assistant + RAG + memory + the app's own
strategy learning loop, and documented the result as a durable design doc:
`docs/chat-assistant-rag-learning.md`. No code changed.

## Why / decision

The user asked for expert advice on RAG, NL-finance chat, how to guide users to interact, request→
prompt translation, learning-over-time, and whether the chat should be a **separate channel learning
entirely separately** from the rest of the app. All five experts independently converged on **HYBRID**,
decomposed into READ vs WRITE: ISOLATE the write surfaces (execution, strategy factor-weight/risk
tuning, conversation memory) and SHARE the read substrate (RAG corpus, user constraints, and new
read-only views of positions/P&L/proposals/watchlist/scorecards). One-way data flow: outcomes flow
into chat; chat opinions never steer the trading brain — except one explicit, human-confirmed
constraints→policy path. The exact isolation boundary already exists physically in the code.

## Notable findings (3 ship-blockers in the chat we just shipped)

1. **Quotes fabricate** `change_pct:0` + "regular session" as fact (BrokerQuote has no change field) —
   violates the prompt's own "never invent figures" rule.
2. **Refusal + disclaimer live only in MockLLM** — they vanish the moment a real provider is enabled;
   the golden eval validates the mock, not production.
3. **Single-turn amnesia** — `chat_turns` is persisted but never replayed into the LLM loop.

Plus: citations are partial theater (fabricated chunk_id + query-derived as_of); the corpus is nearly
empty (8-K summaries only; the structure-aware `storeDocument`/`chunkDocument` we ported has zero
production callers); chat can't read its own positions/P&L/proposals. Full list (13 issues, sev H/M/L)
+ roadmap + user-guidance design in the design doc.

## User decisions (2026-06-21)

- **Multi-LLM** provider choice required; user-vs-app key provisioning deferred (proceed now).
- **NOW tranche approved**: fix I1/I2/I3 + add read-only state tools (I6) + suggested-prompt chips;
  bump `PROMPT_VERSION` → 0.4.0; re-run the golden eval against the real-LLM path.
- **Constraint→policy via explicit confirmation**; **lean toward integrated/shared learning** with the
  one carve-out that free-text chat never steers factor-weight/risk tuning without a confirm.

## Cost answer (corpus depth, the user's open question)

Full-filing RAG ingestion is cheap; the gate is throughput, not dollars. Embeddings ~$15–55 one-time
(Voyage, re-embed only new filings); Pinecone ~$5–30/month recurring depending on depth/queries; the
free Voyage 3-RPM tier is the real blocker (a paid key removes it). Verify current pricing.

## Files

- `docs/chat-assistant-rag-learning.md` (new — the design doc / issue log / roadmap)
- `docs/rollouts/2026-06-21-chat-rag-learning-advisory.md` (this note)
- `STATUS.md` (Active Focus entry)

## Verification

- Documentation only; no code touched. `npx tsc --noEmit` / `npm test` / `npm run build` not re-run
  (no source change).

## Follow-ups

- Implement the approved **NOW** tranche (next session/turn): I1 (quote fabrication), I2 (refusal+
  disclaimer to system prompt + server guard; re-run golden vs real-LLM), I3 (transcript replay),
  I6 (read-only state tools), I13 (prompt chips) — bump `PROMPT_VERSION` to 0.4.0.
- Pending user calls before the relevant tranches: LLM key provisioning + provider order; corpus depth
  (cost above); auth-before-portfolio-reads (phase-11); multi-user feedback isolation.
