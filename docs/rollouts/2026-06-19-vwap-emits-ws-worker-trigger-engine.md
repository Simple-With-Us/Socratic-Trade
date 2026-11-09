# 2026-06-19 — VWAP surface + order/proposal emits + Alpaca news WS worker + trigger engine

Branch: `agent/claude`.

## Summary
Follow-on to the push-vs-poll work — four pieces:
1. **Surface price vs VWAP**: the price chart now draws a dashed VWAP overlay + a "% vs VWAP"
   readout (data captured last commit). `/api/history` now returns `vwap` per bar.
2. **order/proposal SSE emits**: `executeProposal` emits `order`, `rejectProposal` emits
   `proposal`, the cancel route emits `order` — so other open dashboards refresh on those too.
3. **Alpaca news WebSocket worker** (first outbound stream): persistent client to
   `wss://stream.data.alpaca.markets/v1beta1/news`, auth + subscribe + reconnect/backoff + dedup,
   writing into a push news store the enrichment provider now reads FIRST (REST fallback).
   Started from `instrumentation.register()`, opt-in (`STREAMS_ALPACA_NEWS_ENABLED`).
4. **Event-driven LLM trigger engine** (Phase 0/2 scaffold, DEFAULT OFF): mode switch
   (`TRIGGER_ENGINE`/`TRIGGER_MODE`), debounce/coalesce, `admitRun` gate (market hours + cooldowns
   + hourly/daily caps), dedup, one wired producer (material-item 8-K). Policy from a 4-expert panel.

## Files
- `src/lib/strategy.ts` — order/proposal emits.
- `app/api/orders/cancel/route.ts` — order emit.
- `app/api/history/route.ts`, `app/ui/price-chart.tsx` — VWAP through to the chart overlay.
- `src/lib/streams/{news-store,alpaca-news-stream,index}.ts` — NEW WebSocket worker + push store.
- `instrumentation.ts` — `startStreams()`.
- `src/lib/data-providers.ts` — AlpacaNewsEnrichmentProvider reads the push store first.
- `src/lib/triggers.ts` — NEW trigger engine (default off).
- `src/lib/scheduler.ts` — interval lane skipped in `event` mode.
- `src/lib/web-sources/sec8k.ts` — `eightKHasMaterialItem` + broadcasts a material event (dynamic
  import breaks the strategy↔web-sources cycle).
- `app/api/admin/trigger-test/route.ts` — NEW dev route to inspect/preview the engine.
- `test/triggers.test.ts` — NEW (engine defaults + 8-K item gating).
- `docs/event-driven-llm-triggering.md` — NEW design + expert policy + status.

## Verification
- `npx tsc --noEmit` clean · `npm test` 239 pass (31 files) · `npm run build` green.
- Live: WS worker logged `authenticated + subscribed to news`; `GET /api/admin/trigger-test`
  returned `engineEnabled:false, mode:both, admitPreview: engine_off` (correct default-off).
  VWAP confirmed in `/api/market/flatfile` rows last commit.

## Follow-ups (from the expert panel)
- Trigger Phase 1 (deterministic fill→re-arm brackets, regime re-score), then Phase 2 producers
  (regime/insider/technical), per-user `triggerConfig` policy, per-ticker run scope, $/token ceiling.
- WS #3/#4 (Alpaca `trade_updates` fills, quotes WS) reuse the same worker pattern.
- Surface "vs VWAP" on the scan row too (only on the chart today).
