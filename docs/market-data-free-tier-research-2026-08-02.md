# Free-tier market-data research — 2026-08-02 (MONET)

Verified against live vendor docs/pricing pages on 2026-08-01/02 by a 23-agent research
workflow (7 data-type lanes, adversarial re-verification of secondary claims, synthesis).
Companion to `docs/market-data-provider-pricing.md` (canonical per-vendor facts). Consumer
context: self-hosted, single-user, server-side fetching. Full raw lane data: session
artifacts referenced in `docs/rollouts/2026-08-01-data-cascade-freshness-handoff.md` §2.

## 1. Immediate zero/low-code wins

- **Tiingo (ZERO CODE)**: `TiingoEnrichmentProvider` is already implemented but key-gated
  and unconfigured. Free Starter key (no card): 50 req/hr, 1,000 req/day, 500 unique
  symbols/mo, 30+ years split+dividend-adjusted EOD. Owner signs up, pastes key in
  Connections -> instantly the cascade's best free adjusted-history tier. Personal-use
  license fits the sole-user deployment.
- **Alpha Vantage budget reallocation**: the 25 req/day are better spent on AV's four FREE
  corp-actions functions (EARNINGS_CALENDAR horizon=3month, IPO_CALENDAR, DIVIDENDS incl.
  declared future distributions, SPLITS) than on quote/fundamentals calls other providers
  cover. `TIME_SERIES_DAILY_ADJUSTED` and intraday are premium-only now — never attempt.
- **Finnhub unused free endpoints**: /calendar/earnings (rolling ~1mo forward) and
  /calendar/ipo — a daysToEarnings fallback beside Yahoo. Insider-transactions free
  endpoint has more headroom than drawn. NEVER /stock/candle (premium); Finnhub has NO
  screener at any tier (verified against full swagger).
- **Alpaca free options snapshot**: Basic plan includes the options Indicative-feed
  snapshot WITH computed Greeks/IV at 200 req/min -> could feed nearTheMoneyIv +
  putCallRatio without the Robinhood opt-in tier (weaker than OPRA; greeks not always
  present). Do NOT touch Alpaca screener/movers — SIP-gated behind $99/mo.
- **Cboe CDN extension**: VIX_History.csv (daily OHLC 1990->present, verified) + sibling
  VVIX and VIX9D paths -> free vol-regime / term-structure-slope signal, no new vendor.
- **SEC EDGAR depth** (keyless, public domain, 10 req/s, the ONLY unlimited+commercial-
  clean fundamentals source): XBRL companyfacts/frames for eps/revenueGrowth/debtToEquity/
  returnOnEquity/sharesOutstanding; Full-Text Search (2001->); raw Form 4 XML for insider
  transactions (zero license risk); quarterly 13F bulk TSV.
- **Twelve Data self-adjusted history**: free time_series (unadjusted, full depth) +
  free /splits + /dividends -> self-computed adjusted EOD backfill if Tiingo key absent.
  All Twelve Data calendars are Basic-disabled — don't attempt.
- **Yahoo unofficial — harden, don't expand**: add crumb/cookie handling + 429 backoff
  (enforcement tightened through 2025-26). Keep as the no-key floor with fallbacks above.

## 2. New free sources, ranked (value/effort)

1. **US Treasury daily par-yield XML** (home.treasury.gov) — keyless, no limit, public
   domain. Yield-curve level/slope (2s10s, 3m10y) for entryMarketRegime. NOT on the
   fiscaldata REST API (404 verified) — only the XML feed. Low effort.
2. **Nasdaq calendar APIs** (api.nasdaq.com dividends/earnings/IPO) — keyless, live-
   verified forward-looking rows; same host/UA pattern as our screener. LICENSE CAUTION
   below — owner-acceptance item, convenience tier only.
3. **FRED** (free key, ~120 req/min) — CPI, DGS yields, macro for regime classification.
   ToU BANS caching into any database -> fetch-on-demand + transient memory cache only,
   plus required attribution line. VIXCLS/SP500 copyright-gated: display-fallback only.
4. **FINRA short interest** (flat files free, no auth, 2x/month, archives to 2014;
   Developer API free w/ registration) — origin data for shortPercentOfFloat; free
   primary/tiebreaker vs Massive. "Non-commercial" framing fits sole-user.
5. **Wisesheets API** (NEW, launched 2026-07-24): 5,000 req/mo, 200/min, 5y history,
   10,412 US stocks, SEC-XBRL-sourced with filing citations. Widest free US fundamentals
   headroom surveyed. No track record -> register BEHIND existing sources; first-wins
   ordering protects quality.
6. **BLS API v2** (free key: 500 q/day, 50 series/q; keyless 25/day verified live) —
   CPI/PPI/unemployment/payrolls. Public domain, NO caching restriction — the
   license-clean, cache-friendly alternative to FRED for BLS series.
7. **SimFin** (500 credits/mo, 5k US stocks, 5y fundamentals) — second SEC-derived
   opinion. ToS: downloaded data must be deleted if subscription lapses.
8. **Marketaux** (100 req/day) — news sentiment second opinion; API ToS unverifiable
   (site 403s) — read before wiring.
9. **USAspending.gov** (free, keyless, explicitly commercial-OK) — free gov-contracts
   equivalent to Quiver's field; needs recipient-name->ticker mapping (medium-high effort).
10. **S&P 500 constituents** — GitHub `datasets/s-and-p-500-companies` (PDDL, cleaner than
    Wikipedia CC BY-SA). Universe membership + GICS cross-check; can lag reconstitution.

## 3. Data types NOT obtainable free (owner-requested gap report)

| Data type | Free ceiling | Cheapest paid |
|---|---|---|
| Real-time SIP quotes + market-wide movers/screener | IEX-only (~2.5% vol) / 15-min delayed / ToS-gray Yahoo | Alpaca Algo Trader Plus $99/mo |
| Sub-15-min options + full Greeks (OPRA) | 15-min indicative (Alpaca), sandbox no-greeks (Tradier), 24h (MarketData.app) | Funded Tradier brokerage acct (real-time + ORATS greeks bundled, no data fee) |
| Bulk one-call all-symbols EOD | None (Stooq bulk now behind PoW bot wall) | EODHD $29.99/mo |
| 5y+ adjusted EOD under a COMMERCIAL license | Tiingo/FMP free are personal-use-only | EODHD $29.99/mo; Tiingo commercial (contact) |
| Forward analyst estimates / price targets / rec trends | none free anywhere surveyed | FMP Starter ~$22/mo |
| Forward corp-actions calendars at market scale | AV free but 25/day total; Nasdaq unlicensed | EODHD calendar add-on $19.99/mo |
| Congressional trading (structured API) | free mirrors dead/degraded; official portals HTML/PDF + statutory commercial bar | QuiverQuant Hobbyist $30/mo (fleet key already exists — sunk) |
| Fresh (daily/intraday) short interest | FINRA 2x/month IS the free ceiling | Ortex / S3 Partners class |
| S&P TR index / official GICS indices / licensed real-time index levels | SPY adjusted-close & XL* ETF proxies only | S&P DJI licensing (contact) |
| Intraday futures | none free | Databento pay-as-you-go |
| News sentiment at production volume | AV 25/day; NewsAPI free bans production use; Marketaux 100/day | AV Premium $49.99/mo |

## 4. License cautions (structural)

**Only government/public-domain sources are commercial-clean** (SEC EDGAR, Treasury, BLS,
USAspending, + PDDL constituents mirror). EVERY commercial vendor free tier is
personal-use-only — fine for today's sole-user deployment, but a future multi-tenant/GTM
flip violates all of them at once (Finnhub additionally bans internal business use without
written approval; FMP requires a Display & Licensing Agreement to show data to any other
end user; Wisesheets grants commercial use only on Enterprise). Specific teeth:
- **Nasdaq ToS** bars extraction for AI-systems development explicitly — applies to the
  screener we already depend on, not just the proposed calendars. Owner risk-acceptance.
- **FRED** bans DB caching + ML-training use; requires attribution.
- **Congressional disclosures**: commercial-use bar is STATUTORY (Ethics in Government
  Act), independent of vendor.
- **Stooq is DEAD to us**: whole site behind an Anubis-style JS proof-of-work wall +
  CAPTCHA-gated apikey (2026-08-01). Integrating would mean circumventing bot protection —
  do not; treat as unavailable and remove/degrade its history-cascade tier.
- Yahoo remains ToS-gray; single-user floor usage with hardening only.

## 5. Owner action list

1. Sign up free **Tiingo Starter** key -> paste in Connections (zero code, big win).
2. Decide **QuiverQuant**: fleet already pays Hobbyist — activate the existing key in ST
   (Connections/Infisical) or drop Quiver-only fields.
3. Accept/decline **Nasdaq calendar** usage given the ToS clause (screener precedent).
4. If forward analyst estimates matter to strategy: FMP Starter ~$22/mo is the cheapest
   unlock; otherwise we drop the priceTarget/consensus fields to best-effort.
5. Multi-tenant/GTM future: budget for commercial licenses or constrain the product to
   SEC/Treasury/BLS-derived data.
