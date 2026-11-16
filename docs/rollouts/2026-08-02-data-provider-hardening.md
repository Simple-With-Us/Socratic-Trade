# 2026-08-02 — Data-provider hardening pass (Round 1)

**Seat:** MONET · **Branch:** `monet/data-cascade-freshness` · **Worktree:** `/Users/jay/apps/socratic-monet-data-cascade`
**Scope note:** this is a DIFFERENT slice of work than the in-flight Stage 1/2/3 weekend-freshness
effort tracked on this same branch (see `docs/rollouts/2026-08-02-data-cascade-freshness-handoff-2.md`).
Owner asked directly to implement `docs/market-data-free-tier-research-2026-08-02.md`'s own
recommendations (§1 harden existing providers, §2 add new free sources), waiving the research doc's
license caveats (sole-user, bring-your-own-key model). Stage 2/3 (scheduler/UI freshness) is untouched.

## 1. Context & Objective

Owner directive (2026-08-02): "harden and re-focus all data providers as you recommended and add the
new free providers you recommended," explicitly setting aside the research doc's personal-use-license
cautions (sole user, BYOK) and noting they believed a Tiingo key was already configured. Objective:
implement the research doc's §1 (zero/low-code hardening of existing providers) and §2 (new free
sources) recommendations, verifying each against live vendor behavior rather than trusting the prior
research pass's claims at face value — several didn't hold up exactly as described once checked
against the actual current code.

## 2. Changes Made

**New keyless data sources:**
- `src/lib/market-signals/treasury.ts` (NEW) — US Treasury daily par-yield curve (home.treasury.gov's
  legacy Atom/XML feed, keyless, public domain). Wired into `macro.ts`'s `fetchVixOnlyFallback` as a
  keyless fallback for `dgs3moTreasury`/`dgs2Treasury`/`dgs10Treasury` when no FRED key is configured —
  extends the same "at least something real, never fabricated" floor the VIX cascade already has.
  New `MacroData.treasurySourced` flag (mirrors `fredSourced`'s honesty contract).
- `src/lib/market-signals/cboe.ts` — added `_VIX9D` alongside the existing `_SKEW`/`_VVIX` keyless
  Cboe CDN quotes, completing the near-term vol term structure. Threaded through
  `market-signals/index.ts`'s `MarketSignals.vix9d`. Deliberately NOT wired into the deterministic
  `regime-severity.ts` scorer or the volatility panic brake — that would mean inventing a threshold
  with no owner/expert review behind it; it's available to the LLM/dashboard as data only.

**Deepened existing providers:**
- `src/lib/data-providers.ts` `parseCompanyFacts` (SEC-XBRL) — added `revenueGrowth` (fiscal-year-over-
  fiscal-year %, computed ONLY from true ~365-day-duration 10-K `Revenues`/
  `RevenueFromContractWithCustomerExcludingAssessedTax` facts, so a same-concept quarterly/YTD duration
  can never be mistaken for the full year). Zero new API calls — same companyfacts payload the provider
  already fetches for `debtToEquity`. The field/cascade wiring already existed app-wide (FMP/Yahoo
  already supply `revenueGrowth`), so this needed no new touchpoints.
- `src/lib/history.ts` — Tiingo (`/tiingo/daily/{ticker}/prices`) is now ALSO an OHLC-history source,
  not just an enrichment source. **This was the real finding behind "Tiingo, zero code, just add a
  key":** `TiingoEnrichmentProvider` only ever called `/iex` and `/tiingo/daily/{ticker}` (latest-price
  metadata) — never the actual adjusted-history endpoint — so a configured key delivered NONE of the
  "30+ years split/dividend-adjusted EOD" value the research doc promised. Seated after Tradier, before
  Marketstack (Tiingo's real 1,000/day free cap beats Marketstack's 100/month); shares the SAME
  account-wide `"tiingo"` `RATE_QUOTAS` budget as the enrichment provider via `admitProviderRequests`,
  so a scan's enrichment calls and a chart's history call can't together blow the real 50/hour vendor
  cap.
- `src/lib/history.ts` — removed the dead Stooq tier from the cascade. Confirmed live 2026-08-02:
  Stooq's daily-CSV endpoint now sits behind a proof-of-work bot wall (not merely rate-limited) —
  circumventing it would mean defeating bot protection. `parseStooqCsv` stays exported (pure, still
  unit-tested) in case a future non-bot-walled CSV source needs the same shape.

**Console UI (Macro board):**
- `app/console/macro/indicators.ts` / `app/console/macro/page.tsx` — the 3M/2Y/10Y rate tiles and the
  `curve3m10y`/`curve2s10s` tiles now light up from EITHER FRED or the new keyless Treasury fallback
  (new `MacroSourcing.treasury`), instead of showing EM_DASH whenever FRED itself isn't configured even
  when the Treasury data is real. `curvePolicy` (10Y − Fed funds) stays FRED-only — Fed funds has no
  keyless source. `UnsourcedNotice` copy updated to describe the new partial-keyless state accurately.

**Files touched:** `src/lib/market-signals/treasury.ts` (new), `src/lib/market-signals/cboe.ts`,
`src/lib/market-signals/index.ts`, `src/lib/macro.ts`, `src/lib/data-providers.ts`, `src/lib/history.ts`,
`app/console/macro/indicators.ts`, `app/console/macro/page.tsx`,
`docs/market-data-provider-pricing.md`, plus new/updated tests (see §4).

## 3. Decisions & Trade-offs

1. **Verified every recommendation against live vendor behavior AND current code before implementing**
   — the research doc was accurate on vendor pricing/ToS but had NOT been cross-checked against what
   the app's own code actually does yet (that was a separate, code-focused recon). Two of its claims
   didn't hold up: Tiingo's "zero code, just add a key" undersold the real gap (history endpoint never
   wired), and FINRA short interest can't deliver a comparable free `%-of-float` figure (see below).
2. **sharesOutstanding (SEC-XBRL) deferred, not shipped.** The research doc asked to "deepen beyond
   debtToEquity: sharesOutstanding" — extraction itself is cheap (same companyfacts payload), but
   `sharesOutstanding` doesn't exist ANYWHERE in `SymbolEnrichment` today, so shipping it needs the full
   6-touchpoint wiring this repo's own docs warn about (interface, `EnrichmentSourcedField` union,
   `EMPTY_SOURCED`, `takeScalar` call, `types.ts` `MarketQuote`/`MarketQuoteSummary`, `market.ts` merge).
   That UI-facing wiring properly belongs with whichever effort actually consumes the field — the
   OTHER in-flight freshness effort's Lane F already wants it for Congress.Trade sharing. Flagged, not
   built, to avoid a half-consumed field.
3. **FINRA short interest: verified, NOT wired.** Live-confirmed `https://cdn.finra.org/equity/otcmarket/
   biweekly/shrt{YYYYMMDD}.csv` — keyless, no auth, pipe-delimited despite the `.csv` name, and DOES
   cover exchange-listed securities post-2021 (confirmed NYSE tickers present, not just OTC as an
   earlier web search suggested). But it only gives raw share counts + a `daysToCoverQuantity` column —
   NOT a `%`-of-float figure. Computing one needs a free shares-outstanding/float denominator, which
   this app doesn't have anywhere (confirmed: even Massive's OWN `shortPercentOfFloatSecondary` needs a
   SECOND, PAID Massive `/stocks/vX/float` call — Massive doesn't return the percentage ready-made
   either). Fabricating a percentage from a wrong/missing denominator would be worse than the field's
   absence (false Massive-disagreement flags). Left as a documented Round-2 item, packaged with the
   sharesOutstanding decision above.
4. **Did NOT reclassify Tiingo/TwelveData to `shared-operator-infra` credential tier.** Investigating
   why a configured `TIINGO_API_KEY` might not reach the cascade surfaced that both are `per-user-only`
   tier in `db-api-keys.ts` — env only migrates ONCE at startup into the "local" user's Connections
   row (the same trap `AGENTS.md` already documents for `OPENROUTER_API_KEY`), unlike Massive/FMP/
   Finnhub/Marketstack/AlphaVantage/ROIC/FilingAPI/FRED which re-read env live on every call. This
   LOOKED like an oversight (both are exactly the "public market data" category the shared-operator-
   infra tier's own doc comment describes) — but an existing test
   (`api-keys-env-purge.test.ts`) explicitly asserts per-tenant isolation for tiingo/twelvedata as
   intended behavior, and the owner's own framing this session ("each user puts their own keys") reads
   as endorsing exactly this BYOK model. Documented the finding and the correct owner-facing fix
   (paste the key on the Connections page — the env var is not the reliable path) rather than
   unilaterally changing multi-tenant credential architecture on an inference.
5. **VIX9D and revenueGrowth are surfaced as data only, not wired into any deterministic scoring/veto
   logic** (`regime-severity.ts`'s `computeMultiSignalSeverity`, the volatility panic brake, the bear
   veto). Inventing thresholds for a money-path-adjacent signal without owner/expert review felt like
   scope creep beyond "harden the data layer."
6. **Nasdaq calendar APIs, BLS, Wisesheets, SimFin, Marketaux, USAspending.gov, S&P 500 constituents
   PDDL mirror, Alpha Vantage corp-actions reallocation, Finnhub calendar endpoints, Alpaca options
   Greeks/IV, and Yahoo crumb/cookie+429 hardening are NOT done this round** — genuinely out of time
   budget for one pass done to full verified quality. See §5 for the prioritized remainder.

## 4. Verification State

- `npx tsc --noEmit`: clean.
- `npm run lint`: 0 errors (663 pre-existing warnings, grandfathered per `AGENTS.md`).
- `npm test`: full suite — **5678/5680 passed, 489/490 files passed** (894.77s). The 2 failures are
  BOTH in `test/fmp-transcripts-telemetry.test.ts` ("sends every failed upstream attempt..." / "records
  one redacted failed attempt..."), completely unrelated to this change (FMP earnings-call-transcript
  telemetry retry counting). **Confirmed pre-existing**: `git stash`-ed every change from this session
  and re-ran that one file on the clean tree — identical failures, identical assertion values (expected
  2 got 4 / expected called 1 times got 2 times). Not a regression from this work.
- Targeted suites run to completion and green before the full run: `test/sec-xbrl.test.ts` (32,
  +6 new), `test/cboe-vol-stats.test.ts` (3, new file), `test/treasury-yield.test.ts` (7, new file),
  `test/cache-provenance.test.ts` (14, +2 new), `test/macro-indicators-treasury-sourcing.test.ts` (6,
  new file), `test/history.test.ts` (17, +3 new/updated), `test/web-sources-technical.test.ts`,
  `test/data-providers.test.ts`, `test/api-keys-env-purge.test.ts`, `test/provider-rate-limit.test.ts`,
  `test/key-resolution-tiering.test.ts` (216 combined) — all passed.
- `npm run build`: not yet run as of this note — required before landing (see Next Steps).
- Live-verified against real vendor endpoints before writing code (not just trusting docs/prior
  research): Cboe `_VIX9D` CDN quote, Treasury.gov XML feed (current + prior month, exact tag/field
  shape), FINRA short-interest CDN file (format, exchange-listed coverage, no-auth).

## 5. Next Steps & Blockers

1. **Run `npm run build`** (Node 24 PATH) and confirm the backgrounded `npm test` run's final tally
   before landing — this note was written while that run was still in flight.
2. **Land via `scripts/land.sh`** once gates are fully green — expect it to merge `origin/main` first
   (this worktree hasn't synced since 2026-08-01; re-check for overlap, especially with KIMI/AG cascade
   work landed since).
3. **Owner action, direct answer to "I have a Tiingo key already I thought":** check the Connections
   page (`/console/connections`), not just an env var/Infisical value — Tiingo is per-user-only tier,
   so `TIINGO_API_KEY` only reaches the app via a one-time startup migration into your own Connections-
   stored key. If that migration ran before the key existed (or on a fresh DB), the env var alone won't
   activate it; paste it directly on Connections instead. Once active, it now unlocks the full value
   the research doc described (real adjusted EOD history, not just quote enrichment).
4. **Round 2 (not started, prioritized next):** Alpha Vantage corp-actions reallocation (EARNINGS_
   CALENDAR/IPO_CALENDAR/DIVIDENDS/SPLITS), Finnhub `/calendar/earnings`+`/calendar/ipo`, Yahoo
   crumb/cookie + 429 backoff hardening, S&P 500 constituents GitHub PDDL mirror, Alpaca options
   Greeks/IV snapshot (nearTheMoneyIv/putCallRatio alternative to the Robinhood opt-in tier).
5. **Round 3 (not started, lower priority — needs owner sign-up for a free key each):** BLS API v2,
   Wisesheets, SimFin, Marketaux (verify its ToS live first — flagged unverifiable by the research
   pass), USAspending.gov (needs recipient-name→ticker mapping, medium-high effort), Nasdaq calendar
   APIs (owner has waived the ToS caution, so this is now unblocked — same host/UA as the existing
   screener dependency).
6. **sharesOutstanding + FINRA short-interest co-design** — see Decision #2/#3 above. Whoever picks up
   Congress.Trade Lane F (the OTHER in-flight effort) should decide the sharesOutstanding wiring once,
   and this FINRA tier can then pair with it for a real (not fabricated) free `%`-of-float tiebreaker.

## 6. Zero-Code Findings

- **Tiingo's real gap was the history endpoint, not the key.** Confirmed by reading
  `TiingoEnrichmentProvider` line-by-line — it never called `/tiingo/daily/{ticker}/prices`. Now fixed
  in code (§2), but flagging this because the research doc's own "ZERO CODE" framing for Tiingo was
  wrong and other agents/sessions should not repeat that assumption for other "just add a key" items
  without checking the actual call sites first.
- **FINRA short interest is real, live, keyless, and covers exchange-listed securities** — but is not a
  drop-in `%`-of-float source without a paired shares-outstanding/float provider (see Decision #3).
- **Tiingo/TwelveData env-var config is per-user-only by design**, not a bug — see Decision #4. Do not
  "fix" this by moving them to `shared-operator-infra` without an explicit owner decision; an existing
  test deliberately asserts the current per-tenant isolation behavior.
