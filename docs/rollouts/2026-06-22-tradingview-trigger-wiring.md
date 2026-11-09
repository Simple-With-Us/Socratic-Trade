# Rollout: Wire TradingView webhook alerts into the event-driven trigger engine

**Date:** 2026-06-22
**Branch:** agent/claude-h-trig
**Author:** Claude Code (agent lane)

## Summary

The TradingView webhook route (`app/api/webhooks/tradingview/route.ts`) previously
parsed incoming Pine `alert()` payloads and wrote a technical signal to the cache via
`recordTradingViewSignal()`, but **never submitted a material event to the trigger
engine**. This meant a TradingView alert could not cause a strategy decision cycle,
even with `TRIGGER_ENGINE=on`.

This change wires the two together: after a fresh (non-deduped) signal is cached, the
route now calls `broadcastMaterialEvent({ type: "technical", ... })` via the trigger
engine, reusing all existing dedup/cooldown/cap gating — no engine logic was duplicated
or bypassed.

## Why

Phase 2 of the event-driven trigger design (docs/event-driven-llm-triggering.md)
requires every material market event to feed the trigger engine. The SEC 8-K source
already does this (`src/lib/web-sources/sec8k.ts`, lines 299-312). TradingView alerts
are a second catalyst source and should follow the same pattern.

## Design decisions

1. **`broadcastMaterialEvent` (not `submitMaterialEvent`)** — TradingView alerts are
   market-wide events, not per-user; the broadcast fan-out to all active users with
   accounts matches the 8-K precedent and the engine's intent.

2. **Dynamic import (`await import("@/lib/triggers")`)** — mirrors sec8k.ts to avoid
   the strategy↔web-sources circular dependency; the import is elided unless the code
   path is reached.

3. **`void submitTriggerEvent(...)` in POST; helper lives in `src/lib/tradingview-trigger.ts`** —
   the route remains fire-and-forget (response is not blocked on the engine call). The helper is in
   its own module (NOT the route file) because a Next.js `route.ts` may only export route handlers —
   exporting `submitTriggerEvent` from the route fails `npm run build`. It is imported via a relative
   path (not `@/lib/...`) because vitest's `"@/"` alias only resolves specifiers a route test mocks;
   an unmocked `@/lib/*` import fails to load under vitest. The `async/await` (not `.then().catch()`)
   dynamic-import form is used so vitest's module mock can intercept the call for assertions.

4. **Dedup guard (`!result.deduped`)** — TradingView retries identical alerts (same
   symbol + signal + bar_time); skipping the engine call for deduped records prevents
   spurious engine firings from retry storms.

5. **Engine gates itself** — the route does not check `TRIGGER_ENGINE` or `triggerMode`
   directly; `broadcastMaterialEvent()` is a no-op when the engine is off (default).
   This keeps the route thin and the gate logic in one place.

6. **sourceId** — `tradingview:{symbol}:{signal}:{bar_time}` — mirrors the dedupeKey
   written by `recordTradingViewSignal()` so the engine's own dedup TTL recognises
   repeated submits as the same event.

## Files changed

| File | Change |
|------|--------|
| `src/lib/tradingview-trigger.ts` | **New** — `submitTriggerEvent(symbol, sourceId)` helper: dynamically imports `@/lib/triggers` and calls `broadcastMaterialEvent({type:"technical",...})` with a defensive catch |
| `app/api/webhooks/tradingview/route.ts` | Import `submitTriggerEvent` (relative path) + `void submitTriggerEvent(...)` after a successful, non-deduped `recordTradingViewSignal()` |
| `test/webhook-tradingview-trigger.test.ts` | **New** — 9 tests: broadcastMaterialEvent called with correct shape, sourceId stability, dedup guard, throw-safety, failed-gate paths don't call engine |

No other files were modified.

## Verification

```bash
cd /Users/jay/apps/trading-h-trig

# Type check (clean — no new errors):
npx tsc --noEmit

# New test file (9 tests, all pass):
npx vitest run test/webhook-tradingview-trigger.test.ts

# Full suite (91 files, 813 tests, all pass):
npx vitest run
```

Results: 91 test files passed, 813 tests passed, 0 failures.

## Follow-ups / risks

- **`broadcastMaterialEvent` calls `listUsers()` + `getPolicy(userId)`** from the DB.
  In production this is synchronous SQLite; no perf concern at low alert frequency. If
  the TradingView alert volume grows (many symbols, Pine replay), the per-symbol
  cooldown (default 30 min) and global cooldown (default 5 min) will naturally throttle.

- **No per-`signal` severity filtering** — all TV alert types (`bullish`/`bearish`/
  `neutral`) are submitted to the engine equally. If noisy neutral signals cause
  unwanted runs, a severity gate (e.g. skip neutral direction) can be added to
  `submitTriggerEvent` without touching the engine.

- **`type: "technical"`** is a new event type in the engine. Existing admitRun /
  audit logic handles it correctly (no enum restriction), but monitoring dashboards
  or future filtering rules may want to distinguish it from `"sec8k"` / `"regime"`.

- sec8k.ts still uses `.then().catch()` (not `async/await`) for its dynamic import.
  That file's tests don't assert on `broadcastMaterialEvent` call counts, so it's
  fine as-is; the difference is intentional and noted for future test authors.
