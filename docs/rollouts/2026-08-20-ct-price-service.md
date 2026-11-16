# ST -> CT price service: real-time quotes + intraday bars, FMP-free

## 1. Context & Objective

Congress.Trade's latency-price capture (`app/src/ingestion/latencyPriceSnapshots.ts`)
sourced every price from a single FMP key. In production that key returned HTTP 402
and blanked the capture: of **2955 scheduled snapshots only 7 ever recorded a price**
(2937 `missed_window`, 11 `fmp_quote_http_402`).

Owner ruling 2026-08-20: **FMP must never be used for market data** anywhere in the
fleet. It stays valid as a latency-race *competitor being timed* — that is measuring a
rival feed, not sourcing market data.

This adds the replacement source on ST's side, over the token-gated peer-read path CT
already uses for EOD closes.

## 2. Changes Made

- `src/lib/market-realtime.ts` (new) — `fetchRealtimeQuotes` (batch), `fetchIntradayBars`,
  and the pure `barAt` / `normalizeTimeframe` / `toRobinhoodInterval` helpers.
- `app/api/market/quotes/route.ts` (new) — batch real-time quotes.
- `app/api/market/intraday/[symbol]/route.ts` (new) — intraday bars for backfill.
- `src/lib/robinhood.ts` — `fetchRobinhoodHistoricals` now accepts an explicit
  `startTime` / `endTime` / `bounds` window; the `>=2 bars` floor applies only to
  span-style reads.
- `src/lib/history.ts` — exported `resolveAlpacaHistoryCredential` (was private).
- `test/market-realtime.test.ts` (new) — 11 tests.

## 3. Decisions & Trade-offs

- **Intraday is the important half, not real-time.** CT schedules snapshots
  retrospectively, so their due times are already past by the time a row exists. A live
  quote cannot answer a question about the past without fabricating it — which is why
  2937 snapshots correctly refused. Minute bars answer it exactly and let history be
  rebuilt after the fact.
- **Robinhood first for intraday, Alpaca as fallback.** Robinhood offers finer
  granularity (15-second floor vs Alpaca's 1-minute) and answered ~100 consecutive
  research calls without a quota refusal while FMP rate-limited on the first. Gated on
  the OPERATOR-level `ROBINHOOD_MCP_AUTH_TOKEN` bypass: the Robinhood token is per-user
  and a peer route has no user in scope, so using the operator identity from a shared
  path would be the cross-user credential leak `robinhood.ts` warns about.
- **Delayed quotes are opt-in and flagged.** Yahoo's chart quote lags ~15 minutes. For a
  point-in-time capture that is worse than no answer, because a stale number is
  indistinguishable from a fresh one once written down. It is off unless the caller
  passes `allowDelayed`, and every such quote carries `delayed: true`.
- **ROIC was evaluated and rejected.** Its price API is daily-only with no interval
  parameter, and its "latest" endpoint returns the latest *daily* price with a 4-hour
  cache. It can answer neither "price now" nor "price at 14:43". Polling it in real time
  does not help, because the underlying value is not real-time. (Note the tension: their
  marketing page is titled "Real-Time Stock Data API" while the endpoint docs say
  otherwise — trust the endpoint docs, or test empirically before relying on it.)
- **Unpriceable symbols are OMITTED, never zero-filled.** The caller must be able to
  tell "no quote" from "some quote".
- **Feed honesty.** Alpaca's free plan is the IEX feed, ~2-3% of consolidated volume —
  fine for liquid names, potentially stale for thin ones. Every quote carries its `feed`.

## 4. Verification State

```
npm run lint      # 0 errors, 769 warnings (grandfathered backlog)
npx tsc --noEmit  # clean
npm test          # 639 files / 7191 tests passed, 51 skipped
npm run build     # succeeded
```

Node pinned to 24 (`/opt/homebrew/opt/node@24/bin`) — Homebrew's default v26 causes a
`better-sqlite3` ABI mismatch that mass-fails the suite.

## 5. Next Steps & Blockers

- **Do not merge while production is behind.** ST recovered from an outage at ~08:50Z on
  the last good image (`77d7d7b6`), leaving live production four merges behind
  `origin/main`. Merging adds another build to a queue that just failed. Land this once
  the backlog clears.
- CT side is NOT changed here. `latencyPriceSnapshots.ts` still calls FMP; switching it
  to these endpoints, and rebuilding snapshots as record-timestamp-then-backfill, is the
  follow-up.
- CT's snapshot event set has no **+15m** rung (`provider_publish / +5m / +30m / +60m`);
  add it when that path is rebuilt.

## 6. Zero-Code Findings

- `price.eod` / `spx.eod` are already in `CONGRESS_EVENT_TYPES` with an accepted-noop
  branch in `src/lib/congress-trade-events.ts` — but CT emits neither. A dormant
  half-built channel worth either using or deleting.
- The ultra-short-term trading lane this work originally supported was **closed** on
  evidence the same day: five independent analyses found no tradeable bump at competitor
  publication. This price service is justified as measurement/honesty infrastructure, not
  as trading enablement.
