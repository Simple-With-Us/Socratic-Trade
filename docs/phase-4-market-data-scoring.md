# Phase 4 - Market Data And Multi-Factor Scoring

## Goals

- Introduce a provider abstraction without removing the current delayed Nasdaq fallback.
- Add Robinhood bid/ask quote enrichment when the adapter supports it.
- Cache market scans and quotes with TTLs to reduce latency and rate-limit risk.
- Replace single-score ranking with configurable factor scores.

## Provider Shape

- `MarketDataProvider.scan(symbols, positions, options)`: normalized scan output.
- `MarketQuote` includes provider, freshness, bid, ask, optional source-provided VWAP, factor breakdown, sector, industry, and score.
- Optional provider data for fundamentals, technicals, and news/sentiment can be added later without changing strategy logic.

## Scoring Factors

- Liquidity
- Momentum
- Value
- Quality
- Volatility
- Sentiment
- Positioning
- Diversification

Weights are normalized before scoring. Missing provider data uses neutral factor values instead of failing the scan.

**Sub-factor enrichment (2026-06-16, branch `ui-redesign`):** the Value and
Quality sub-scores now incorporate previously-orphaned fundamentals that the
enrichment cascade was already fetching:

- **Value** adds a free-cash-flow-yield adjustment (`fcfYield >= 6% -> +12`,
  `>= 3% -> +6`, `< 0 -> -8`) on top of the P/E or market-cap base.
- **Quality** adds leverage (normalized `debtToEquity <= 0.5 -> +10`,
  `<= 1.5 -> +3`, `> 3 -> -10`) and earnings-growth (`epsGrowth >= 15% -> +8`,
  `> 0 -> +3`, `< -10% -> -8`) adjustments.

Both clamp to 0-100. The Market Scan table surfaces these as FCF% / D/E / EPS gr
columns with source-attribution tooltips; cells show `-` when no provider
supplied the value (never a fabricated number). See
`docs/rollouts/2026-06-16-signals-learning.md`.

**Positioning and technical overlay (2026-06-17/18, branch `phase-10`):**
the scoring model now includes a `positioning` factor driven by congressional net
buying, SEC Form 4 insider sentiment, and squeeze-level short pressure. Cached
web-source overlays are applied before final scoring, and the scan is re-sorted
after overlay so those signals can move deterministic ranking. Bar-based
technicals from TradingView webhook or in-house Yahoo/Stooq computation blend
into the existing Momentum score rather than adding a separate technical weight.

**Unofficial Webull quote bridge (2026-06-19):** an opt-in
`webull-unofficial` enrichment provider can shell out to
`scripts/webull_unofficial_quote.py` for read-only quote fields when
`WEBULL_UNOFFICIAL_ENABLED` is explicitly enabled. It is disabled by default,
attributed as `webull-unofficial`, and must not be used for broker execution,
account state, paper fills, or learning-grade fills.

**Quote/OHLC sharing guardrails (2026-06-19):** broker quote merges now append the
actual provider to `MarketScan.source` (`alpaca-quotes`, `robinhood-quotes`, or
`broker-quotes` when unspecified) and dedupe repeated merges. OHLC history caches
public/free and env-key/system-key market data globally, while history fetched
through a saved user key is private by default unless
`MARKET_DATA_SHARE_USER_KEYED_HISTORY=on` is set after entitlement review.
Failed public OHLC reads now record short-lived `market_data_demands`; if a later
shared cache fill arrives for the same symbol before `MARKET_DATA_PENDING_TTL_MS`
expires, prior requesters refresh from cache without spending another user's key.
Private user-key fills do not fulfill other users' pending misses.

**Source-list presentation (2026-06-30):** dashboard source subtitles normalize
known aliases at display time before deduping labels. Historical scan strings can
contain both `congress` and `congress.trade`, or both `yahoo-finance` and
`yahoo-finance-delayed-quotes`; Latest Decisions and Market Scan show those as a
single `Congress.Trade` and `Yahoo Finance` label respectively.

**Massive VWAP surface (2026-06-19):** when Massive grouped daily bars are
available, `/api/scan` merges source-provided `vw` into scan rows as
`MarketQuote.vwap` / `MarketQuoteSummary.vwap`, attributes it as
`massive-vwap`, and the dashboard shows sortable `vs VWAP`. Missing Massive
keys, weekends/holidays, or plan gaps leave the cell blank instead of
fabricating a value.

**Custom quote-only universe rows (2026-06-23):** Additional Watchlist symbols
are no longer limited to embedded index members. When Nasdaq's screener omits a
quote-resolvable custom U.S. equity/ETF ticker, the scan carries it forward as a
Yahoo Finance quote-only row and still runs enrichment/scoring. If a custom
ticker cannot be priced, Market Scan keeps the rest of the scan usable and shows
a concrete warning naming the ticker.

**Expanded dynamic universes (2026-06-23):** Base universe selection now covers
small and broad indexes without sending the whole market to the LLM. Static
embedded lists still cover S&P 500, Nasdaq 100, and Dow 30. Dynamic universes
flow into `scanMarket` as follows:

- S&P 100 and Russell 2000 are loaded from BlackRock iShares holdings downloads
  (`OEF` and `IWM`) and intersected with the live Nasdaq screener rows.
- Nasdaq Composite and NYSE Composite use the existing free Nasdaq screener with
  `exchange=nasdaq` / `exchange=nyse`.
- FT Wilshire 5000 uses the free all-screener U.S.-listed universe as the app's
  no-license proxy, not a licensed exact constituent feed.

The full selected universe is ranked locally first. Only the capped candidate
set receives expensive enrichment and enters the LLM prompt. The cap is now a
per-user policy setting (`marketScanCandidateLimit`, default 30, bounded
10-100); `MARKET_SCAN_LIMIT` remains only a fallback for direct/internal scan
calls that do not pass policy. The below-cutoff outlier reserve is also
per-user (`marketScanOutlierReserve`, default 8, bounded 0-25 and never above
the candidate cap); `MARKET_SCAN_EVENT_RESERVE` is the direct-call fallback.
Outliers are ordered by signal strength across notable congressional buying,
insider buying, short pressure, and bullish technical signals, and they replace
lower-ranked plain candidates inside the cap rather than expanding it. This
limit is primarily about prompt quality, latency, and API/provider cost; it also
reduces free-data endpoint pressure. Dynamic-universe trade approval is
scan-proven: an opening order for a broad-index-only symbol must be present in
the latest ranked scan, while explicit Additional Watchlist symbols remain
allowed directly.

Expert review guidance for the candidate cap:

- 10-12: lowest reasonable cost-sensitive range; useful for narrow universes or
  cheap smoke runs, but diversity and outlier coverage suffer.
- 25-40: balanced default range; enough breadth for sector rotation and LLM
  comparison without overwhelming the prompt.
- 60-80: broad research mode; useful for Russell/NYSE/Wilshire scans when cost
  is acceptable.
- 100: practical upper bound. Above this, extra breadth usually adds attention
  dilution/noise faster than it improves proposal quality, even if token cost is
  ignored.

**MCP/provider evaluation (2026-06-24):** `docs/data-provider-mcp-evaluation.md`
compares FMP, Alpha Vantage, Twelve Data, Tiingo, EODHD,
FinancialData.net, Nasdaq Data Link, Tastytrade, Pyth, Databento, Unusual
Whales, Trading Volatility, and a generic Yahoo-backed MCP server. The
production guidance is to keep scheduled scans, scoring, history, cache writes,
and execution-adjacent data on direct REST/WebSocket adapters. MCP is useful for
provider research, trial benchmarking, and interactive deep dives, but app-side
MCP calls should be promoted only through a narrow server adapter that normalizes
and caches source-attributed results. Near-term candidates are Tiingo as a
low-cost direct adapter and FinancialData.net/EODHD/Twelve Data as broad replacements if their
coverage and licensing fit.

## Acceptance

- Scan results include `factorBreakdown` for each candidate.
- `MarketScan.sectorBySymbol` and `quotesBySymbol` cover all returned quotes.
- Nasdaq delayed data is still available as fallback.
- Quote-resolvable custom Additional Watchlist tickers can appear in Market Scan
  even when omitted by the Nasdaq screener, with concrete warnings for custom
  tickers that cannot be priced.
- Dynamic base universes can broaden discovery without expanding the enriched
  LLM candidate set beyond the configured scan cap, outlier reserve names remain
  eligible for the prompt, and broad-index symbols are policy-approved only when
  scan-proven.
- Robinhood quote enrichment adds bid/ask where available and does not fail the run when unsupported.
- Optional unofficial quote enrichment is clearly attributed and disabled by default.
- Broker quote source attribution reflects the actual provider and does not duplicate repeated merges.
- Shared OHLC cache fills can satisfy pending public misses without pooling private user keys.
- Source-provided VWAP is attributed when present and omitted when unavailable.
- The strategy prompt asks for ask-relative limit prices only when ask data exists.

## Interactive scan reliability and FMP routing (2026-07-15)

The interactive `/api/scan` path no longer starts the full multi-provider fundamentals
cascade. A default 30-candidate configuration widens to 150 preselection symbols; on a
cold process, Finnhub alone can enqueue 750 calls at 50/min. The old 25-second
`Promise.race` returned 500 without cancelling that work, and user retries multiplied
the queue. Interactive scans now return the real Nasdaq/broker scan plus persisted web
signals, reuse only slow facts from a completed strategy scan no more than 24 hours old,
replace every price/event-sensitive field, coalesce identical refreshes, and bound Nasdaq
at eight seconds. A Nasdaq outage shows the last strategy scan with explicit stale
attribution instead of a blank table. Strategy/scheduler scans keep full enrichment, and
ticker sheets fetch bounded, per-user/symbol-coalesced data for any valid symbol.

FMP's live lane now uses stable `profile`, `ratios-ttm`, `grades-consensus`, and
`insider-trading/search` endpoints (plus opt-in price targets), with header auth and
per-field provenance. `ratios-ttm` maps valuation, leverage, returns, margin, and yield;
`profile` maps issuer identity/classification, beta, dividend yield, and 52-week range.
Congressional disclosures stay owned by Congress.Trade rather than duplicated per
symbol. The cadence/entitlement expansion map is maintained in
`docs/fmp-capabilities.md`.

## Data-source breadth (2026-07-01, branch `claude/trading-audit-d-e-dpw0h7`)

Audit work-split "Chat D" (`docs/reviews/2026-07-01-audit-work-split.md`) closed additive
holes in the enrichment cascade. All new fields flow through the standard per-field
enrichment checklist (`SymbolEnrichment` → `EnrichmentSourcedField` → `takeScalar` →
`EMPTY_SOURCED` → `MarketQuote` → `applyEnrichment` → prompt compaction) and degrade to
`undefined`/absent (never fabricated) when a provider doesn't return them.

- **`daysToEarnings`** — whole days to the next *future* earnings date, from the existing
  authenticated Yahoo `quoteSummary` call (`calendarEvents` module). Zero added cost;
  surfaced to the Bull prompt as `earnIn`.
- **`institutionOwnershipPct`** — institutional/13F ownership %, from the same Yahoo call
  (`institutionOwnership`/`majorHoldersBreakdown` modules). Zero added cost.
- **Synthetic bid/ask is now provenance-tagged** `yahoo-finance-synthetic`. `hasAskData`
  (via `hasRealAsk`) and the marketable-limit calculation exclude a synthetic ask and
  degrade to `refPrice`-based limits — the "ask-relative limits only when ask exists"
  acceptance above now means a *real* quoted ask, not the price×0.999/1.001 placeholder.
- **Robinhood options/IV tier** (`RobinhoodOptionsEnrichmentProvider`) — near-the-money IV
  + put/call ratio, long-TTL, default-off (`ROBINHOOD_OPTIONS_ENRICHMENT_ENABLED`).
- **Active per-provider circuit breaker** — skips an enrichment lane whose db-health status
  is `stoppedWorking`, re-probing after a backoff; default-off
  (`ENRICHMENT_CIRCUIT_BREAKER_ENABLED`). The trip is scoped to the provider's own
  credential lane: a dead env-key lane no longer blacks out a healthy user-key provider
  for the same service (keyless providers keep the all-lanes-for-service check).
- **Short interest** — Yahoo Finance is the single source (`shortPercentOfFloat`). FMP does
  **not** publish short interest — there is no `/short_interest` (or equivalent) endpoint on
  FMP's API surface (verified 2026-07 against FMP's docs + official MCP surface). The earlier
  "FMP second short-interest source" + Yahoo-vs-FMP disagreement bulletin were removed as
  non-deliverable; a genuine second source would require a real provider (e.g. Massive,
  Finnhub). See `docs/rollouts/2026-07-01-followon-fmp-breaker-quotes.md`.
- **Finnhub REST-volume lever** — `FINNHUB_DROP_RECOMMENDATION` (default-off) drops the
  per-symbol `stock/recommendation` call (5→4); analyst ratings remain backstopped by the
  Yahoo/FMP/Alpha-Vantage tiers.
- **Free-first field-demand planner (2026-07-26, default ON)** —
  `ENRICHMENT_FREE_FIRST_ENABLED`. Wave A runs free/keyless providers (Yahoo, Alpaca
  snapshot/news, SEC XBRL when enabled, FMP-RapidAPI, etc.) with one retry on throw; Wave B
  runs paid non-scarce providers only for symbols still missing core gap fields; Wave C is
  the existing scarce RapidAPI gate (`quotaScarce` + `suppliesFields`). Insiders/TwelveData
  RapidAPI now declare `suppliesFields` so they participate in Wave C. Alpha Vantage RapidAPI
  also supplies NEWS_SENTIMENT when sentiment/headlines remain gaps. Keyless `nasdaq-quote`
  joins the free wave beside Yahoo. ROIC resolves from `ROIC_API_KEY` (profile-first).
  FilingAPI.dev (`FILINGAPI`) supplies sector/industry/daysToEarnings/insiderSentiment in
  wave C. SEC XBRL is default ON. Additional RapidAPI scarce lanes: yh-finance-apidojo,
  real-time-finance-data, seeking-alpha-rapidapi.
- **Enrichment coverage report** — after each cascade run, Admin → Enrichment Coverage
  (`/admin/enrichment-coverage`), `/api/admin/enrichment-coverage`, and ops snapshot
  `enrichmentCoverage` show per-field fill rate, winning/most-frequent source, missing
  fields, and provider failures. `applyEnrichment` preserves `fieldObservations` /
  `providerFailures` on `MarketQuote`.

See `docs/rollouts/2026-07-01-data-sources-breadth.md`,
`docs/rollouts/2026-07-01-followon-fmp-breaker-quotes.md`, and
`docs/rollouts/2026-07-26-free-cascade-coverage.md`.
