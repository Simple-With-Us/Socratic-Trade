# 2026-06-20 — Event-trigger Phase 1 (deterministic, no LLM) + Alpaca fills WS

Branch: `agent/claude`. Continues the event-driven trigger work; this is the experts' **Phase 1**
(deterministic Tier-0/1 — zero LLM cost), grounded in a 4-agent investigation of the current
fill/reconcile/regime/broker surface (post Codex Test/Paper/Brokerage refactor).

## Summary
1. **Regime flip detector** (`src/lib/regime-watch.ts`): the regime label was recomputed every run
   and persisted nowhere, so flips were invisible. Now the scheduler tick computes it (cheap, cached
   macro), stores `regime:current` in the no-audit KV, and on a change audits `regime_flip` + pushes a
   dashboard refresh + broadcasts a (non-triggering unless `TRIGGER_ENGINE=on`) material event. Seeds
   silently on first run. Escalation set (`isEscalationRegime`): crisis / inverted / risk-off.
2. **Real-time fill handling** (Phase 1 deterministic): new Alpaca `trade_updates` WebSocket worker
   (`src/lib/streams/alpaca-trade-updates-stream.ts`) — trading host, `{action:auth}` then
   `{action:listen, streams:[trade_updates]}`, **binary frames decoded to JSON** (no msgpack), single
   object. On `fill`/`partial_fill` → `onBrokerFill` (`src/lib/fills.ts`) reconciles via the existing
   `reconcilePendingFills` for active Alpaca users + emits a dashboard `order` event. **Fills are
   deterministic-only — they never trigger an LLM run** (expert policy). Opt-in
   `STREAMS_ALPACA_TRADE_UPDATES_ENABLED`.
3. **Closed an SSE gap**: the run-loop order placement (`strategy.ts`) now emits a dashboard `order`
   event (only the approval path did before).

## Key grounding (from the investigation)
- `reconcilePendingFills` / `generateProactiveRiskProposals` exist; **true brackets/OCO do NOT** — so
  "re-arm brackets" is honestly reconcile + (deferred) risk re-check, not resting stop orders.
- Codex's model is **derived** (`deriveExecutionState`, `usesLocalSimulation`), not a stored field;
  `FillSource` stays `"live"|"paper"` (Test→paper, Paper+Brokerage→live). New code must not branch on
  `paperMode` directly. (Phase 1 here only reconciles/ emits, so it's unaffected, but noted.)
- Alpaca trade_updates uses **binary frames with a JSON payload** — native WebSocket + TextDecoder +
  JSON.parse; no msgpack dependency.

## Files
- `src/lib/regime-watch.ts` — NEW flip detector.
- `src/lib/scheduler.ts` — calls `checkRegimeFlip()` on tick.
- `src/lib/fills.ts` — NEW deterministic `onBrokerFill`.
- `src/lib/streams/alpaca-trade-updates-stream.ts` — NEW WS worker; `src/lib/streams/index.ts` starts it.
- `src/lib/strategy.ts` — run-loop placement emits `order`.
- `docs/event-driven-llm-triggering.md` — Phase 1 marked done.

## Verification
- `npx tsc --noEmit` clean · `npm test` 261 pass (37 files) · `npm run build` green.
- Live: `[stream:alpaca-trades] authorized + listening to trade_updates`, news worker still
  authenticated, and `regime:current` seeded to `"Neutral (Normal Volatility)"` in `data/app.db`.

## Follow-ups
- Phase 2: turn the event lane on behind `admitRun` (regime/8-K/insider/technical), default `mode=both`,
  cadence 90. Phase 3: token/$ budget ceiling.
- Decide whether a fill should also auto-run `generateProactiveRiskProposals` (places exits outside a
  run) — deferred as a behavior change.
- REST fallback poll of `/v2/account/activities` for fills during WS reconnect gaps.
- True bracket/OCO orders (new persistence + `cancelEquityOrder` wiring + broker capability check).
