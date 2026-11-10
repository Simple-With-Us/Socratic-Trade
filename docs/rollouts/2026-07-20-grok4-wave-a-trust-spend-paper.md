# 2026-07-20 — GROK4 Wave A (+ C partial): trust/spend taxonomy, paper honesty, short parity

## Summary

Owner-directed multi-wave implementation after the multi-expert full-app review
(`docs/reviews/2026-07-20-grok4-multi-expert-full-app-review.md`).

**Wave A (done in this commit):**
1. Strategy run **skip ≠ completed** — market closed, broker unhealthy, usage-budget
   enforce, and early LLM budget admission finish as `status: "skipped"` with honest
   summaries. Trading liveness + auto-tune only count `completed`.
2. **Early budget admission** before `scanMarket` (after safety maintenance / broker health)
   so over-budget runs do not thrash enrichment cascade.
3. **Usage-Monitor enforce** prefers provider `openrouter` under universal routing (#1703)
   while keeping model-family fallback for older monitor shapes.
4. **SiliconFlow bge-m3 embed price** 10× undercount fixed (`0.00001` per 1K tokens).
5. **api-circuit-breaker.ts** null-byte corruption cleaned.
6. **Paper wording** — no more “simulated” in Activity/toasts; paper is broker-mediated;
   banner kept but softened (focus live). Keys copy distinguishes required LLM vs optional enrichment.
7. **First-run setup** items in Needs attention (broker, LLM key, Green model).
8. **Pushover** already supported via `NOTIFY_PUSH_PROVIDER=pushover` + `PUSHOVER_APP_TOKEN`;
   Delivery UI surfaces provider when active.

**Wave C partial (done):**
- Add-to-loser stop rule uses **scan/mark price** (not only limit/stop → always-zero drawdown).
- Bracket permission accepts **shortStopLossPct**.
- Dashboard short/cover labels (not collapsed to “Trade”).
- Synthetic trail arms for **shorts** from `shortStopLossPct` when account trailing is 0.

## Why

Budget skips looked like successful green runs; monitor enforce missed OpenRouter spend;
paper copy conflicted with product philosophy; shorts lacked continuous protection default.

## Files

- `src/lib/strategy.ts` — skipped status, early admission
- `src/lib/db-execution.ts` — `StrategyRunFinishStatus`
- `src/lib/usage-budget.ts` — openrouter-first enforce
- `src/lib/rag-metering.ts` — SiliconFlow price
- `src/lib/api-circuit-breaker.ts` — null byte
- `src/lib/policy.ts` — mark price + short bracket
- `src/lib/synthetic-stops.ts` — short trail fallback
- `src/lib/dashboard-ui.ts`, `dashboard-feed.ts`, activity, derive, api-keys, delivery, chat
- `src/lib/types.ts`, `app/dashboard-types.ts`
- `test/usage-budget.test.ts`
- review + effort log updates

## Verification

```bash
npx tsc --noEmit
npx vitest run test/usage-budget.test.ts test/api-circuit-breaker.test.ts
```

## Follow-ups (still planned)

- **Wave B:** complete bge-m3 corpus re-embed on prod; expand doc types (8-K, fundamentals,
  news) + autonomous summarization; coach-note archive + lesson vectors.
- **Wave C rest:** broker-held cover stops on Alpaca (not only synthetic trail).
- **Wave D:** coach chat → doctrine/learned_context from plain English + URL ingest;
  options data as long/short advisors.
- **Ops:** set `NOTIFY_PUSH_PROVIDER=pushover` + `PUSHOVER_APP_TOKEN` in Infisical if
  owner wants Pushover as default push.
- **Re-embed:** operator `POST /api/admin/reembed` full 4-docType run; verify Pinecone
  stats before purge-legacy.

## Effort board

Live: `/Users/jay/apps/TRADING-EFFORT-LOG.md`  
Mirror: `docs/EFFORT-LOG.md`  
Agent: GROK4 · branch `grok/multi-wave-a-onward`
