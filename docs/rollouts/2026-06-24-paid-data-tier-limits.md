# 2026-06-24 — Capture the paid Polygon/Massive + FMP "Starter" tiers

## Summary
The owner upgraded **Polygon/Massive → Stocks Starter** and **Financial Modeling Prep → Starter**
(both already wired via `MASSIVE_API_KEY` / `FMP_API_KEY`). Two defaults were still pinned to the
*free* tiers; raised them so the app actually uses the paid throughput.

- **Massive client-side rate limiter** (`market-signals/massive.ts`): `DEFAULT_REST_MAX_CALLS_PER_MINUTE`
  5 → **100**. Starter is unlimited calls; 5/min was the free-tier politeness cap that throttled
  grouped-daily breadth, gainers/losers, news, and (critically) Massive as the **primary OHLC-history
  source** — so it was falling through to rate-limited free Yahoo. 100 lets Massive serve reliably
  while still bounding a runaway loop. Free-tier deployments lower it via the env var.
- **`.env.example`**: `MASSIVE_REST_MAX_CALLS_PER_MINUTE` 5 → 100 and `FMP_MAX_SYMBOLS` 15 → 30 (the
  code default was already 30 = the scan limit; the example was stale), each with a comment on the
  free-vs-paid tradeoff.

No new providers, no schema change. Paid FMP automatically restores the sector/industry/news fields
the free tier dropped (same endpoints, now returning data).

## Operator action (secrets — not committable)
On the live box `.env.local`: ensure `MASSIVE_API_KEY` and `FMP_API_KEY` are the paid keys, set
`FMP_MAX_SYMBOLS=30` (and `MASSIVE_REST_MAX_CALLS_PER_MINUTE=100` if it was pinned to 5), then
`pm2 restart trading --update-env`.

## Why
From the paid-tier value survey (`docs/rollouts/` chat): Polygon/Massive Starter ($29) + FMP Starter
($22) were the two high-value, in-budget upgrades; everything else stays on free tiers / trivial
usage. Massive's 5-calls/min was the single hardest self-imposed data bottleneck.

## Files
- `src/lib/market-signals/massive.ts` — `DEFAULT_REST_MAX_CALLS_PER_MINUTE` 5→100.
- `.env.example` — Massive limiter + FMP symbol cap defaults + comments.

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run test/history.test.ts` — 13/13 (rate-limit-disabled path still passes; default change
  doesn't affect single-call tests).
- Full `npm test` + `npm run build` via `land.sh`.

## Follow-ups (optional, not done)
- Massive Starter includes WebSockets — could add a real-time Massive price producer mirroring the
  Alpaca one (`streams/alpaca-price-events-stream.ts`).
- Finnhub paid (~$50) only if fundamentals depth becomes a felt gap (free tier already strong).
