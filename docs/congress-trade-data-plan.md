# App B ↔ App A (congress.trade) — bidirectional data plan

Goal: each app gets every datum it needs, **neither double-pays**, and the whole thing keeps working
when paid sources lapse or API caps drop. Grounded in a full inventory of both codebases (2026-06-24).

## TL;DR
- **The biggest win is App B → App A prices.** App A's `price_eod` is **FMP-only** — single-sourced, on
  a ~230-call/day cap shared with enrichment, with **no fallback** (degrades to "--" if the cap is hit on
  a heavy ingestion day or the key lapses). FMP itself is cheap (App A is on the Starter tier, ~tens of
  $/mo — *not* a four-figure bill); the real risk is the **daily cap + single-source fragility**. App B's
  prices come from Massive/Tradier (paid) **and Yahoo/Stooq (free)**, so App B feeding App A prices
  de-risks App A's most fragile dependency.
- **The free floor for both is Stooq (deep history) + Yahoo (~1y) + SEC EDGAR (refs) + the free congress
  sources.** Route each datum through whoever has the cheapest/most-reliable source; share the result so
  the other never re-fetches. That sharing **is** the no-paid-access plan.
- **One data-correctness gap to resolve first: price adjustment** (raw vs split/dividend-adjusted) — see §4.

## 1. What each app needs
| App A (congress.trade) needs | App B (trading) needs |
|---|---|
| Congress trades (its own product) | Daily OHLC ~5y + SPX (charts, technicals, breadth) |
| Security refs (name/sector/industry/marketCap/exchange) | Fundamentals (P/E, EPS, beta, div-yield, 52w, FCF, D/E) + analyst consensus |
| **Per-ticker price history back to each trade's date** (years; for performance-vs-S&P) | Congress trades, insider (Form 4), short-vol |
| SPX (via SPY) from oldest trade date onward | Macro (FRED, VIX, SKEW/VVIX, COT, factors) — App B-only |
| Current price per held ticker | Real-time intraday snapshots (broker) — App B-only |

## 2. Sharing matrix — who fetches, who consumes (so neither double-pays)
| Datum | Cheapest/most-reliable fetcher | Flows to | Mechanism (status) |
|---|---|---|---|
| **Daily prices + volume** | **App B** (Massive/Tradier paid · Yahoo/Stooq free) | → App A | nightly push (live) + deep-history backfill (new, §3) |
| **SPX** | **App B** | → App A | nightly push (live) |
| **Security refs** | App B (Yahoo/Finnhub free) + App A (SEC free) | → App A | after-scan refs push (live) |
| **Fundamentals + analyst** | **App B** (Finnhub/FMP/Yahoo) | → App A | after-scan push, gated `CONGRESS_SHARE_FUNDAMENTALS_ENABLED` (awaits App A #46 migration) |
| **Insider (Form 4) + short-vol** | **App B** (SEC + FINRA, free) | → App A | nightly push (live) |
| **Congress trades** | **App A** (House Clerk + Senate eFD + seed = authoritative) | → App B | `/api/transactions` pull + SSE/webhook (live) |
| **Congress analytics** (net-flow, cluster, leaderboards) | **App A** | → App B | `/api/analytics/*` pull → scan scoring (live) |

Net: **App B is the market-data provider; App A is the congressional authority.** Each consumes the
other instead of re-fetching.

## 3. Deep-history backfill (resolves the #134 tension)
App A needs prices back to *old* trade dates, but the nightly push caps each symbol to ~1y
(`CONGRESS_SHARE_MAX_CLOSES_PER_TICKER`, default 260) so a POST never times out. So:
- **Nightly = light** (recent-capped, keeps App A's current prices fresh).
- **Backfill = deep, on-demand** — `POST /api/admin/congress-share {"fullHistory": true}` sends each
  symbol's FULL available series (still chunked into small bounded POSTs). Run it once (and after adding
  symbols) to seed App A's deep `price_eod`. Target App A's exact needs with
  `{"symbols": [...congressional tickers...], "fullHistory": true}`.
- App B's depth: ~5y from keyed providers; **Stooq gives deep history for free** — so even with no paid
  access, App B can backfill App A's history.

## 4. Gaps / misunderstandings to resolve
1. **Price adjustment (MUST resolve before App A trusts App B prices for performance).** App A's FMP
   `price_eod` is **split/dividend-adjusted**. App B's shared closes are **mostly raw** (Yahoo `close`,
   Tradier, Stooq) with some adjusted (Massive `adjusted=true`). Mixing raw into App A's adjusted store
   corrupts return math across dividends/splits. **Decision needed:** either App B standardizes its
   shared closes on adjusted (history-layer change), or App B labels each close's adjustment and App A
   keeps FMP-adjusted as authoritative + App B-raw as fallback-only. Until resolved, App A should treat
   App B prices as *fill-the-gap*, not overwrite its FMP-adjusted rows.
2. **Backfill targeting.** App B's monitored universe (≈S&P 500) covers most but not all congressional
   tickers. For 100% coverage, App A should hand App B its distinct ticker list (or App B derives it from
   `/api/transactions`) and run the `fullHistory` backfill over that set.
3. **App A→B price reuse is partial.** App B's cache-aside read of App A `/api/market/prices` only helps
   for tickers App A actually has (its FMP-limited congressional set) — fine, just don't expect App A to
   be App B's general price source.

## 5. Redundancies to kill (cost + caps)
1. **Congress double-fetch → drop App B's scrapers + the PAID Apify House actor.** Set
   `CONGRESS_TRADE_AS_CONGRESS_SOURCE=on` so App B sources congress from App A (authoritative). Kills
   App B's Apify pay-per-row cost and its Senate-eFD scraping.
2. **App A price refresh → lean on App B's push.** App A can cut FMP `eodHistory` calls (its biggest
   budget line) to gap-fills only, since App B feeds prices nightly + on backfill.
3. **App A enrichment → lean on App B refs/fundamentals + SEC.** Fewer App A FMP/Massive/Finnhub/
   TwelveData enrichment calls.

## 6. No-paid-access / low-cap future (the floor)
| Datum | Free floor when paid lapses |
|---|---|
| Prices / deep history | **Stooq (deep) + Yahoo (~1y)**, fetched by App B, shared to App A. Cache-once-share-twice to dodge free-tier 429s. |
| Refs / fundamentals | **SEC EDGAR** (both) + Yahoo (App B), shared. (Loses market-cap precision on SEC-only — acceptable.) |
| Analyst consensus | Yahoo (App B) — degraded but free. |
| Congress | Already free: Senate eFD + House Clerk + SEC; App A authoritative, App B consumes. |
| Macro / vol / factors | App B-only, already free: FRED (free key), CBOE, CFTC, Ken French. |
| SPX | Yahoo/Stooq ^GSPC (App B), shared. |

Principle: **fetch once at the cheapest source, share to halve quota use.** Lower caps → push/pull on a
slower cadence and rely more on each other's cache; nothing requires a paid tier to keep functioning.

## 7. Action checklist
**App B (this app):**
- [x] Push prices/volume/spx/insider/short-vol/refs; consume congress + analytics; fundamentals/analyst gated.
- [x] Deep-history backfill mode (`fullHistory`).
- [ ] Enable in prod: share (token + `CONGRESS_SHARE_ENABLED`) + consume (`CONGRESS_TRADE_READS_ENABLED`,
  `CONGRESS_TRADE_AS_CONGRESS_SOURCE`, `CONGRESS_ANALYTICS_ENABLED`). Run one `fullHistory` backfill.
- [ ] Resolve the price-adjustment question (§4.1) with App A.

**App A (congress.trade):**
- [ ] Apply #46 migration (then App B flips `CONGRESS_SHARE_FUNDAMENTALS_ENABLED`).
- [ ] Treat App B prices as fill/fallback vs FMP-adjusted until §4.1 is settled; then cut FMP
  price-refresh to gap-fills.
- [x] Expose missing price-history list: App A `GET /api/export/price-needs`; App B merges + deep-shares (2026-07-30).
