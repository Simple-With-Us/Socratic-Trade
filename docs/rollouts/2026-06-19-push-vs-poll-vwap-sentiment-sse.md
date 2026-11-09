# 2026-06-19 — Push-vs-poll doc + VWAP capture + sentiment offload + SSE dashboard push

Branch: `agent/claude` (worktree `~/apps/trading-claude`).

## Summary
Acted on the data-architecture audit (push-vs-poll + compute-offload):
1. **Doc:** added `docs/data-architecture-push-vs-poll.md` capturing the durable principles
   (push mechanisms + tradeoffs, the relay/fan-out pattern, compute-vs-source rule, event-driven
   LLM triggering) and the grounded opportunity inventory + scoping of the remaining push items.
2. **Quick win — VWAP capture:** we already fetch Massive's `vw` (VWAP) but were dropping it on
   parse. Now captured into `GroupedBar`/`GroupedDailyBar` and per-symbol `OHLCBar.vwap`.
   Live-verified: the flatfile route rows now include `vwap`.
3. **Quick win — sentiment offload:** the enrichment cascade now prefers Alpha Vantage's real
   `NEWS_SENTIMENT` model score over the `scoreHeadlines` keyword proxy when present (the proxy
   was winning because Finnhub runs earlier in first-wins order).
4. **Push #1 — SSE dashboard:** replaced the browser's 30s blind `/api/dashboard` poll with
   Server-Sent Events. New in-process event bus (`src/lib/events.ts`), SSE endpoint
   (`app/api/events/stream`), a `run-complete` emit at the end of `runStrategyOnce`, and a client
   `EventSource` that refreshes on events. The old poll is demoted to a 120s safety-net fallback.

## Why
The audit showed most polling is already cheap (long TTLs); the real overhead is the 30s client
poll and the LLM loop. SSE eliminates the former with no external dependency. VWAP/sentiment were
the two "free" compute-offload wins (data already fetched / a real score already parsed).

## Files
- `docs/data-architecture-push-vs-poll.md` — NEW principles + inventory + scoping doc.
- `src/lib/market-signals/massive.ts` — `GroupedBar.vw` + `GroupedDailyBar.vwap` + capture in `fetchGroupedBarsRest`.
- `src/lib/history.ts` — `MassiveAggBar.vw` + `OHLCBar.vwap` populated in `fetchMassive`.
- `src/lib/indicators.ts` — `OHLCBar.vwap?` field.
- `src/lib/data-providers.ts` — Alpha Vantage real sentiment overrides the keyword proxy in `CascadingEnrichmentProvider`.
- `src/lib/events.ts` — NEW globalThis-pinned in-process pub/sub for dashboard push.
- `src/lib/strategy.ts` — `emitDashboardEvent({type:"run-complete"})` after a run.
- `app/api/events/stream/route.ts` — NEW SSE endpoint (nodejs runtime, heartbeat, abort cleanup).
- `app/api/admin/emit-test/route.ts` — NEW dev-gated route to verify the push path.
- `app/dashboard-client.tsx` — EventSource live-push; 30s poll → 120s fallback.

## Gotcha resolved
The event bus had to be pinned to `globalThis` — Next.js bundled the SSE route and the emit route
into **separate module instances**, so a plain module-level `const Set` gave them different Sets
(emit observed `subscribers: 0`). globalThis singleton fixed it (`subscribers: 1`, event delivered).

## Verification
- `npx tsc --noEmit` clean · `npm test` 233 pass · `npm run build` green.
- Live: SSE handshake (`connected`/`ready`) received; `POST /api/admin/emit-test` →
  `subscribers: 1` and the SSE stream received `event: dirty` with payload. VWAP present in
  flatfile rows. (Full `run-complete` delivery uses the same verified bus; couldn't drive a real
  run here — this worktree has no connected broker account, "No account selected".)

## Follow-ups
- Surface "price vs VWAP" on the quote/chart (data now captured).
- Add `order`/`proposal` emits (event types already defined) for instant refresh on those too.
- Push #2–#4 (Alpaca news WS, `trade_updates` WS, quotes WS) need a persistent WebSocket worker —
  scoped in the doc. Event-driven LLM trigger is the big design item.
