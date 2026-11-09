# 2026-06-19 - Shared market-data pending demand

## Summary
Added a durable pending-demand path for public OHLC history misses. When a user
requests a symbol that cannot be filled, the app records a short-lived
`market_data_demands` row. If a later request fills the same symbol through the
shared cache path, the pending rows are marked fulfilled and the dashboard emits a
`market-data` SSE event so open clients retry from cache.

## Why
This reduces duplicate provider traffic without pooling user API keys. Later shared
facts can benefit earlier requesters, but private user-key fills remain isolated by
default. That keeps the behavior fair: users benefit from cache warmth, not from
another user's quota being spent for their misses.

## Files
- `.env.example` - documents `MARKET_DATA_PENDING_TTL_MS`.
- `README.md` - documents the pending-demand TTL knob.
- `PLAN.md` - reflects shared-history pending-fill behavior in Phases 4 and 11.
- `STATUS.md` - current handoff note.
- `app/dashboard-client.tsx` - handles `market-data` SSE events and fans out a
  browser event for visible charts.
- `app/ui/price-chart.tsx` - retries history after a market-data fill event.
- `docs/data-architecture-push-vs-poll.md` - documents shared cache fills and the
  non-pooling rule.
- `docs/phase-4-market-data-scoring.md` - documents pending OHLC misses as part of
  cache/rate-limit behavior.
- `docs/phase-11-multi-user.md` - documents the multi-user sharing/privacy boundary.
- `src/lib/db.ts` - adds `market_data_demands` and helper functions.
- `src/lib/events.ts` - adds the `market-data` dashboard event type.
- `src/lib/history.ts` - records misses, source-scopes cache writes, and fulfills
  demands only from shared fills.
- `test/history.test.ts` - covers shared-fill fulfillment and private user-key
  non-fulfillment.

## Verification
- `npx vitest run test/history.test.ts` passed (13 tests).
- `npx tsc --noEmit` passed.
- `npm test` passed (242 tests across 31 files).
- `npm run build` passed.
- `git diff --check` passed.
- `pm2 restart trading-codex` completed after build regeneration.
- `curl -fsS http://127.0.0.1:4101/api/health` returned `{"ok":true}`.

## Follow-ups
- Extend the same demand/fulfill pattern to enrichment facts if the scan layer starts
  exposing a clear per-field "missing but wanted" signal.
- A future authenticated SSE stream should filter market-data refresh events per user;
  today's event intentionally omits the symbol to avoid leaking watchlist intent.
