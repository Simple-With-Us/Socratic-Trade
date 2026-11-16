# 2026-08-01 — Data-ingestion free-tier optimization + weekend freshness — HANDOFF (PAUSED, owner-directed)

**Seat:** MONET · **Branch:** `monet/data-cascade-freshness` · **Worktree:** `/Users/jay/apps/socratic-monet-data-cascade` (isolated; the standing `~/apps/trading-monet` lane has unrelated uncommitted peer work on `monet/codex-review-remediation` and was deliberately left untouched)

**State at pause: recon + research complete, full design ready, ZERO code changes made.** The branch is `origin/main` @ `39785370` plus this docs commit only. All background workflows stopped cleanly; everything needed to resume is in this note.

## 1. Context & Objective

Owner directive (2026-08-01): optimize the data-ingestion cascade to run entirely on free-tier API keys; guarantee ticker + Market Scan data is fetched at least every 24h over weekends and/or weekend-stable data is cached and displayed until Monday; make more thorough use of existing providers; find new free sources; report which data types cannot be had free; ensure optimal Usage Monitor interaction and complete EOD/S&P/history sharing with Congress.Trade. Work was paused by the owner mid-implementation-launch.

## 2. Changes Made

**Code: none.** Docs/coordination only:
- This handoff note.
- Live effort board `/Users/jay/apps/TRADING-EFFORT-LOG.md`: MONET row added (now marked PAUSED); also corrected KIMI's stale PR #2314 row in place (it said "open, not merged" — gh shows MERGED 2026-07-31T21:32Z).
- `docs/EFFORT-LOG.md` (repo mirror): PAUSED row added in this commit.
- #ag***-s**c: claim posted at session start; pause notice posted at session end.

**Artifacts (all durable, session dir persists):**
- Recon workflow (COMPLETE, 8/8 agents): full area reports + synthesis at
  `/Users/jay/.claude/projects/-Users-jay-Code-Socratic-Trade/9a241ca7-1c7a-46d1-af97-63c7de3c5c3d/tasks/w2zbj50tz.output` (JSON; `result.synthesis` = the design brief). Journal: `.../subagents/workflows/wf_7ad1aef2-61c/journal.jsonl`.
- Research workflow (STOPPED at 6/7 sweep lanes done; Verify/Synthesize phases not run): per-lane results in
  `.../subagents/workflows/wf_e005ae48-3d5/journal.jsonl`. Missing lane: `corp-actions-calendar`. Resume: `Workflow({scriptPath: ".../workflows/scripts/free-data-source-research-wf_e005ae48-3d5.js", resumeFromRunId: "wf_e005ae48-3d5"})` — completed lanes replay from cache.
- Implementation workflow (STOPPED before any edit landed; Stage-1 agents were mid-read): script at
  `.../workflows/scripts/data-cascade-implementation-wf_5ce762cb-82f.js`, runId `wf_5ce762cb-82f`. It encodes the complete 3-stage/6-lane implementation with per-lane specs, verify+checkpoint-commit agents, and repo rules. Resume the same way, or re-launch fresh — nothing was cached that matters.

## 3. Decisions & Trade-offs (made this session; revisit only with cause)

1. **Weekend guarantee = a scheduled scan lane, not a loosened trading gate.** New scheduler lane `market_scan_freshness` (20h staleness threshold, env knob, 0 disables) that does NOT pass `isRunAllowedNow`/`isTradingDay` — data freshness decoupled from trading. Scan persisted under a NEW `market_scan` audit kind; consumers read newest-of(`market_scan`, `strategy_run.result.marketScan`).
2. **Weekend cost posture:** trading days → full enrichment; non-trading days → `enrichmentMode: "skip"` + seed from newest persisted scan (keyless price refresh only, no keyed-quota burn). Satisfies both halves of the owner's ask.
3. **Weekend-stable TTLs over DB persistence (for now):** helper `expiresAtRespectingMarketClose(now, baseTtlMs)` in market-hours.ts extends close-stable cache expiries to next market open. Explicitly excluded: VIX 10-min TTL and Alpaca ~30s snapshot (panic-brake/live paths). Open question logged on whether weekend Coolify redeploys (in-memory cache wipe) force a DB-persist follow-up.
4. **Free-tier caps get conservative in-code defaults** (filingapi 45/day, roic ~200/day + pacing, marketstack ~3/day ≈ 100/mo), env `PROVIDER_QUOTA_*` stays authoritative — per the owner's advisory-guardrails philosophy.
5. **UM subscription→knob lane:** new `usage-monitor-knobs.ts` consuming UM `GET /api/subscriptions` (knobEnv/freeTierKnobEnv already in ST's naming); precedence env > UM-active > UM-lapsed > defaults; fail-open.
6. Implementation staged 3×2 parallel lanes with tsc+targeted-test+commit checkpoints between stages (contention-free file partition; see workflow script).

## 4. Verification State

- No code changes → no gates run. `npm ci` green in the worktree (Node 24 PATH: `/opt/homebrew/opt/node@24/bin`).
- Live prod probes run this session (Saturday ~22:00 UTC): `/api/health` 200 — `oldestCompletedRunAgeSeconds ≈ 99,714` (~27.7h, live proof of the weekend >24h gap); `usage-monitor: ok=false` while UM's own `/api/health` is 200 (client-side failure — see Findings); `dataProvidersDegraded: true` (FMP probe 403 tier-unknown; Massive free tier ~2y history cap); unhealthy lanes: alpha-vantage, fmp-rapidapi, insiders-rapidapi, nasdaq-quote, seeking-alpha-rapidapi, twelvedata-rapidapi, vix-yahoo, yh-finance-apidojo. `/api/market/spx` + `/api/market/prices/AAPL` → 401 (deployed, token-gated, correct).

## 5. Next Steps & Blockers

**To resume implementation (any seat):** re-launch the implementation workflow (script path above) from this worktree, then run the full gate (`npm run lint` → `npx tsc --noEmit` → `npm test` → `npm run build`), write the rollout note, land via `scripts/land.sh`. Before Lane F, re-verify its items against current main — **KIMI's same-day merged work** (`scripts/cascade-audit.ts`, STATUS.md 2026-08-01 entry) already mapped Yahoo analyst targets/revenueGrowth/fcfYield and enabled Robinhood options enrichment in prod; recon ran on a main that includes it (39785370), but re-check for further overlap before editing.

**Owner actions (blockers for full value, not for the code):**
1. **APP_B_INGEST_TOKEN smoke test** — CT rotated it 2026-08-01; CT's `peer.ts` swallows 401s silently (falls back to Massive with zero visible error). Curl ST `GET /api/market/spx` with CT's bearer: 200 = synced, 401 = update ST's Infisical copy. Agents cannot verify this without secret access.
2. **Prod flag decisions:** `CONGRESS_SHARE_FUNDAMENTALS_ENABLED` (ST→CT fundamentals push; high value while CT's FMP key is suspended), `CONGRESS_TRADE_FUNDAMENTALS_ENABLED` (ST pull tier), confirm `CONGRESS_SHARE_ENABLED`. All default OFF; no rollout note confirms prod flips.
3. **QuiverQuant has NO free API tier** (verified on pricing page 2026-08-01; cheapest Hobbyist $30/mo). The integrated `QuiverQuantEnrichmentProvider` is dormant without a paid key — decide: subscribe, or deprioritize those fields (congress trades already flow free via congress.trade share).
4. **Usage Monitor push failing in prod** (`usage-monitor: ok=false`; UM service itself healthy). Likely `USAGE_MONITOR_BASE_URL`/`USAGE_INGEST_TOKEN` config or the un-rotated `USAGE_MONITOR_INGEST_TOKEN` from KIMI's 2026-08-01 secret scrub ("usage receiver choreography — owner list"). Needs owner-side token check.

**Design plan to execute (from recon synthesis, full detail in the workflow script + synthesis JSON):**
1. Scheduled 24h scan lane (scheduler.ts, market.ts, scan-singleflight.ts, dashboard.ts, app/api/scan/route.ts)
2. Weekend-stable TTL helper at ~8 cache-write sites (market-hours.ts + market.ts:902, data-providers.ts ~1923/~3468 + roic TTL ~3667→6h, history.ts:120, macro.ts:229/263/268 NOT :414, macro-history.ts:115)
3. Calendar-aware interactive seed gate (scan-singleflight.ts: flat 24h → `createdAt >= previousTradingDayStart(now)`)
4. Freshness UI (scan/page.tsx isFresh identity-check → generatedAt-based + age chip; console/page.tsx:692 tile age label; resolve vestigial MarketQuote.stale)
5. Enforce filingapi/roic/marketstack quotas (provider-rate-limit.ts) + sync docs/market-data-provider-pricing.md (stale since 2026-07-10; missing FilingAPI/ROIC/RapidAPI lanes)
6. UM subscription→knob lane + forecast-aware budget alerts (usage-monitor-knobs.ts NEW, provider-rate-limit.ts, usage-budget.ts)
7. UM telemetry for 3 invisible providers (CongressTrade/Webull/SecXbrl enrichment providers)
8. CT completion: sharesOutstanding via SEC XBRL → 6-touchpoint enrichment wiring → congress-share.ts marketQuoteToRef; fix stale docs (EFFORT-LOG rows ~4372/4374 say #2314 "not merged"; 2026-07-31-market-read-routes.md Next Steps lists CT consumption as TODO — both done); dividend/split EVENT sharing = joint backlog (schema needed both sides)
9. Cheap provider wins: AV-RapidAPI OVERVIEW ROE/ROA/AnalystTargetPrice (already-fetched payload), GLOBAL_QUOTE scarce fallback, FMP trimmed-fetch cache fix (~3279-3299), RapidAPI refund-on-403 for delisted hubs (yh-finance-apidojo, seeking-alpha — both ok:false in prod health)

## 6. Zero-Code Findings

### Weekend freshness (the core defect)
`scanMarket` has NO scheduled caller — only (a) inside the weekend-blocked strategy run, (b) approval flow, (c) `/api/scan` page visit. No user visit ⇒ Friday scan serves until Monday (~60h+). Dashboard's Market-scan evidence tile has no freshness label; scan page "fresh" chip is an object-identity check; `MarketQuote.stale` is written but read nowhere. The 24h interactive seed gate (flat wall-clock) rejects Friday's seed exactly on Monday morning when it's still the best available. Every value cache is in-memory flat-TTL (screener 5m, enrichment 6h, OHLC 30m, macro 24h, macro-history 12h) with zero calendar awareness — weekend expiries re-burn real quota (AV 23/day, RapidAPI 900/day combined, Tiingo 50/hr, marketstack 100/mo) on unchanged data, and any weekend merge→auto-deploy wipes all of them.

### Free-tier enforcement holes
`filingapi` (comment claims ~50/day enforcement that doesn't exist), `roic` (no quota, no pacing, 30-min TTL ⇒ ~12× refetch rate of peers), `marketstack` (100/mo, unguarded — one bad day can exhaust the month). FMP coverage-trimmed fetches skip the cache entirely (repeat spend). AV multi-key pool is dead weight (per-IP cap, proven 2026-07-10; also no-new-keys owner ruling). Quiver unguarded if symbol cap raised.

### Usage Monitor
Push architecture solid (debounced queue + durable replay + circuit breaker). Gaps: UM's `GET /api/subscriptions` serves knobEnv/freeTierKnobEnv in ST's exact `PROVIDER_QUOTA_*` naming and ST never calls it (a lapsed subscription silently leaves stale quotas until a human edits Infisical); budget read-back discards forecast fields (projectedEomUsd/projectedRunoutDate); 3 providers emit zero telemetry (CongressTrade, Webull, SecXbrl). And prod push is currently failing (see §4/§5).

### Congress.Trade sharing
Price/SPX routes live and consumed as CT's PRIMARY price tier since 2026-07-31 (SPX = SPY bars). Missing: refs push omits sharesOutstanding/CIK/exchange/ipoDate (CT's schema wants sharesOutstanding specifically; cheapest source = SEC XBRL payload ST already fetches); fundamentals/analyst push + reverse pull flags default OFF; ST's import receiver intentionally drops insider/shortVolume/fundamentals from CT; dividend/split events are a joint schema gap. Token-rotation risk: see §5 owner action 1.

### Free-source research (6/7 lanes, verified against live docs 2026-08-01)
**Worth adding (free):** SEC EDGAR XBRL frames/companyfacts (unlimited, 10 req/s — deepen beyond debtToEquity: sharesOutstanding, revenue, margins); FRED (120 req/min free key — SP500 price index, VIXCLS, DGS yields, CPI); US Treasury par-yield XML (keyless, verified); FINRA short-interest files (free static, back to 2014); USASpending.gov (free, keyless — gov contracts without Quiver); Cboe delayed options JSON `cdn.cboe.com` (keyless, live-verified — NTM IV/put-call corroboration); Tradier Lite $0 (real-time equities + full options chains + Greeks — bundled free with any brokerage account, already a history tier); SimFin (5k US stocks, 5y fundamentals free); MarketData.app (100/day, ≥24h delayed). Alpaca free movers/most-actives endpoints are NOT in the free feed (paid algo plan).
**Now-broken assumptions:** **Stooq is blocked for server-side/headless fetches (live-tested 2026-08-01)** — it's the terminal tier of `fetchDailyOHLC`; replace/degrade gracefully. Finnhub free excludes `/stock/candle` (403) and news-sentiment (403 despite docs). AV `TIME_SERIES_DAILY_ADJUSTED` + intraday are premium-only now; AV free = 25 req/day account-wide. NewsAPI.org free tier contractually prohibits production use. IEX Cloud is dead (2024). QuiverQuant: no free tier (see §5).
**Effectively NOT free (owner's requested gap list):** S&P 500 TOTAL-return index (price-only via FRED/Yahoo; TR is licensed); consolidated real-time OPRA options NBBO + Greeks (Tradier Lite is the free-adjacent path); futures data (any resolution); analyst forward estimates/price targets/up-downgrade history at depth (only single-point consensus fields ride along on free payloads); normalized cross-comparable financial statements at volume; bulk one-call all-symbols EOD (nearest free: Stooq static archives — now access-blocked; per-symbol loops within caps otherwise); intraday bars at scale (Twelve Data 800 credits/day and Alpaca IEX are the free ceilings); global non-US fundamentals; licensed news at production scale. Missing research lane at pause: corp-actions/earnings-calendar (dividends/splits/earnings dates) — resume the research workflow to complete it.

### Coordination notes
KIMI's same-day merged cascade-audit work (STATUS.md 2026-08-01, `agent/kimi-lane`) overlaps Lane-F territory — re-diff before implementing. KIMI's PR #2331 (VIX cascade + regime flaps) was open at pause. Recon synthesis flagged one untraced area: synthetic-stop-monitor's weekend quote reads (runs every tick in protective states) — trace before changing any quote TTL it depends on.
