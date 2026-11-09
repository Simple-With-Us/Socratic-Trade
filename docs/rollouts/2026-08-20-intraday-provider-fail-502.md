# 2026-08-20 — #2953 intraday provider failure must be 502

## Context & Objective

#2953 added `GET /api/market/intraday/{symbol}` so Congress.Trade can backfill
retrospective latency snapshots without FMP.  The route's own comment said empty
`bars` means a confirmed empty window (weekend / halt) and that only a non-200
is a provider failure — the same contract as `/api/market/prices`.

`fetchIntradayBars` returned `null` for a missing credential, an Alpaca HTTP
error, a timeout, AND a successful empty page.  The route then did
`bars: bars ?? []`, so every failure became `200 { ok: true, bars: [] }`.

CT treats 200-empty as "this source has no prints here" and only falls back on
non-200.  An Alpaca 403 therefore looked like a weekend and kept writing
`missed_window` — the blanking #2953 was shipped to stop.

## Changes Made

- `src/lib/market-realtime.ts` — `IntradayBarsResult` is `{ kind: "ok", bars }`
  or `{ kind: "unavailable", reason }`.  Alpaca HTTP/network failures and a
  missing history credential are `unavailable`.  A 200 with `bars: []` is `ok`.
- `app/api/market/intraday/[symbol]/route.ts` — `unavailable` → 502; confirmed
  empty stays 200 `[]`.
- Tests: `test/market-realtime.test.ts`, `test/market-intraday-route.test.ts`.

## Decisions & Trade-offs

- Robinhood miss/error still falls through to Alpaca.  If Alpaca is also
  missing, that is `unavailable` rather than a guessed empty window.
- Partial Alpaca pages that already produced bars stay `ok` if a later page
  fails — losing confirmed prints would be worse than a short series.

## Scope Honesty

- Did not touch #2957 (middleware bearer pass-through for these routes).
- Did not touch #2947 / #2952 (Tradier `getEquityOrders` paging / live pending).
- Did not chase the /api/health cache-miss 503 path (#2816 / #2817).
