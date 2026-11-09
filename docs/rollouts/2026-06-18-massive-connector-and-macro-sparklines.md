# 2026-06-18 — Massive connector (full-market breadth) + Macro sparklines

## A) Massive market-data connector
Discovered Massive (massive.com) exposes a **Polygon-compatible REST API** at `api.massive.com`
(Bearer auth with `MASSIVE_API_KEY`) in addition to S3 flat files. Built around the REST API
(no S3 signing needed in production).

- `src/lib/market-signals/massive.ts` — NEW. `fetchFullMarketBreadth()` uses the grouped-daily
  endpoint (`/v2/aggs/grouped/locale/us/market/stocks/{date}`, ~12k tickers per call) for the
  two most recent trading days and computes **true full-universe market breadth**: % of all US
  stocks advancing day-over-day, advancers/decliners, and the biggest liquid movers
  (volume ≥ 1M). Failure-tolerant; never fabricated.
- `src/lib/market-signals/index.ts` — `getMarketSignals()` now also returns
  `marketBreadthPct / marketAdvancers / marketDecliners / marketTopGainers / marketTopLosers /
  marketBreadthAsOf`. Combined cache lowered 6h → 1h (breadth wants daily freshness; the other
  sources are cheap). Reaches the LLM (existing `marketSignals` plumbing) and the Macro tab.
- `src/lib/strategy.ts` — prompt now describes `marketBreadthPct` (broad participation >55%
  risk-on / <45% caution) and the market-wide movers.

### Credential fix
- `.env.local` `MASSIVE_SECRET_ACCESS_KEY` had a one-character typo relative to the
  `MASSIVE_API_KEY` value. Fixed locally, so the S3 flat files would also authenticate
  if used later. No secret value is recorded here. (We use the REST API, which auths
  with the API key.)
- Endpoints NOT in this key's plan: the real-time full snapshot (`/v2/snapshot/...` → 403). Grouped
  daily + per-symbol aggregates work.

## C) Macro tab sparklines
- `src/lib/macro-history.ts` — NEW. `fetchMacroHistory()` pulls ~90 daily FRED observations for a
  curated set (10Y, 2Y, VIX, HY credit spread, USD index, WTI) for sparklines; cached 12h.
- `src/lib/dashboard.ts` — `macroBoard.history` added to the snapshot.
- `app/dashboard-types.ts` — `macroBoard.history?: Record<string, number[]>`.
- `app/ui/macro-panel.tsx` — `Sparkline` (inline SVG, trend-colored) + `TrendsSection` (~90-day
  sparkline per series with last value and 90-day % change) + `BreadthSection` (full-market breadth
  tiles + top gainers/losers).

## Voyage
Per the user: end users won't supply their own Voyage key, so it is NOT surfaced in the UI.
`vector-db.ts` already reads `VOYAGE_API_KEY` from env (a single shared key activates RAG).

## Verification
- `npx tsc --noEmit` clean · `npm test` → **190 tests** pass (26 files) · `npm run build` compiles.
- After the parallel RAG review-resolution pass, the combined local worktree also passed
  `npx tsc --noEmit`, `npm test` (**195 tests**, 27 files), and `npm run build`.
- Live: `GET /api/dashboard` → `macroBoard.signals.marketBreadthPct = 26` (3,045 adv / 8,806 dec,
  2026-06-17) with real top movers; `macroBoard.history` has 6 series × ~88–90 daily points
  (10Y 4.43, 2Y 4.05, VIX 18.44, HY 2.63, USD 119.5, WTI 84.65).
- Massive grouped-daily verified live (12,311 tickers/call); per-symbol aggregates also work.
- Browser: Macro tab renders Trends (~90d) sparklines + Full-Market Breadth section + all prior sections.
- Dev server healthy (GET / → 200).

## Notes / follow-ups
- Full-universe breadth (~12k names incl. illiquid) reads lower/more volatile than a large-cap
  breadth; it's true breadth, labeled as such for the agent.
- Massive S3 flat files (bulk historical backfill) remain unused — a future data-lake/backtest
  source; the SigV4 access is now proven (region us-east-1, secret = API key).
- RAG review-resolution work is now layered on the same local worktree; `git status` before committing.
