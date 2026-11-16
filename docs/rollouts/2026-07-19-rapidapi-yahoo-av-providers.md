# 2026-07-19 - rapidapi-yahoo-av-providers

## Summary

Adds three new, dormant-by-default `MarketEnrichmentProvider`s backed by a single shared RapidAPI
subscription (`RAPIDAPI_KEY`), each sourcing REDUNDANT/FAILOVER data for fields the app already
gets from the free keyless Yahoo scrape and native Alpha Vantage — not new schema fields:

1. **Mboum Finance** (`mboum-finance.p.rapidapi.com`)
2. **YH Finance 15** (`yahoo-finance15.p.rapidapi.com`)
3. **Alpha Vantage via RapidAPI transport** (`alpha-vantage.p.rapidapi.com`) — OVERVIEW function,
   as an additional fundamentals source alongside the existing NEWS_SENTIMENT-only native lane.

All three are registered in `getEnrichmentProvider()` (`src/lib/data-providers.ts`) **after** the
unconditional free `YahooFinanceEnrichmentProvider` tier, as a deep failover — the cascade is
first-wins per field, so these providers only actually win a field the free scrape (and every
earlier paid tier) left empty for that symbol.

## Why

Owner instruction: expand redundancy/throughput against the same market data the app already gets
elsewhere, using a RapidAPI account the owner already subscribes to, while staying safely under a
self-imposed combined-calls ceiling ("stay under the 1000 calls safely like 900 max").

### Ground truth this session verified live (owner-supplied, see the task prompt for the full text)

- **Alpha Vantage via RapidAPI** (host `alpha-vantage.p.rapidapi.com`): confirmed byte-identical
  response shape to native `www.alphavantage.co/query` for GLOBAL_QUOTE, NEWS_SENTIMENT, and
  OVERVIEW. Auth via `x-rapidapi-host`/`x-rapidapi-key` HEADERS (not a query param). Real plan
  (owner-confirmed from the RapidAPI dashboard): 500 requests/day, 5 requests/minute.
- **Mboum Finance** (host `mboum-finance.p.rapidapi.com`): quote endpoint confirmed —
  `GET /v1/markets/quote?symbol=AAPL&type=STOCKS` (no `/api` prefix, param `symbol`). Numeric
  fields are FORMATTED STRINGS (`"$333.74"`, `"+0.48"`, `"+0.14%"`, `"63,407,283"`). Modules
  endpoint (`/v1/markets/stock/modules?...&module=asset-profile`) param name is UNCONFIRMED on
  this host (only directly tested with `ticker=` on the sibling YH Finance host). Plan tier
  UNCONFIRMED — treated as free Basic (500 requests/month, 1 request/second) until proven
  otherwise.
- **YH Finance 15** (host `yahoo-finance15.p.rapidapi.com`): quote endpoint —
  `GET /api/v1/markets/quote?ticker=AAPL&type=STOCKS` (HAS `/api` prefix, param `ticker`). Modules
  endpoint confirmed live with `module=asset-profile` (real address/sector/industry/
  longBusinessSummary JSON). Multi-module in one call was attempted but hit a 429 before it could
  be evaluated — not assumed to work; this build makes exactly one module call per symbol. Plan
  tier CONFIRMED via a live 429 body: **Basic = 100 requests/MONTH, 1 request/second** — a very
  small monthly budget.

### MVP scope (deliberately narrow)

The target field set mirrors what `YahooFinanceEnrichmentProvider` already sources via its
`quoteSummary` modules: `peRatio, dividendYield, eps, sector, industry, pbRatio,
shortPercentOfFloat, beta, fiftyTwoWeekHigh, fiftyTwoWeekLow, debtToEquity, epsGrowth, fcfYield,
daysToEarnings, institutionOwnershipPct, analystBySource`. Mboum/YH Finance 15 aim at this same set
via their own quote + asset-profile calls; Alpha Vantage's OVERVIEW expansion maps into whichever
of these (or other pre-existing `SymbolEnrichment` fields) its documented schema unambiguously
supplies — no new schema fields were added.

### CRITICAL wiring question this session had to resolve from the actual code

The task prompt asked whether `CascadingEnrichmentProvider` narrows what a later, quota'd provider
is asked to fetch based on what an earlier provider already filled for a given symbol. Read the
full merge implementation (`src/lib/data-providers.ts`, `CascadingEnrichmentProvider.enrich`):

- **Default path:** `results = await Promise.all(this.providers.map((p) => run(p, normalized)))` —
  every registered provider's `enrich()` is called with the FULL per-run symbol batch, full stop.
  No per-symbol/per-field narrowing of what a later provider is asked to do.
- **Opt-in short-circuit path** (`enrichmentShortCircuitEnabled()`, requires BOTH
  `ENRICHMENT_SHORT_CIRCUIT_ENABLED=1` AND congress-fundamentals to be on — both default OFF):
  awaits the `congress.trade` tier first, builds a `coveredFields[symbol]` hint from what THAT
  tier alone filled, and passes it only to providers whose `costTier === "paid"`. Even then, a
  provider receiving the hint decides for itself which of its OWN sub-calls to skip — the cascade
  never skips calling a provider's `enrich()` outright, and the hint's source is congress.trade
  specifically, not "whatever the free Yahoo scrape happened to fill this run."

**Conclusion: no general narrowing mechanism exists.** Given YH Finance 15's real cap is
100 requests/MONTH, naively appending these providers to the unconditional cascade — where they'd
be asked to fetch EVERY symbol on EVERY scan — could exhaust an entire month's quota in a single
run against a modest watchlist. Safety here comes entirely from a NEW, provider-owned persisted
daily budget gate (mirroring `alpha-vantage-key-pool.ts`'s `tryReserveAlphaVantageCalls` /
`refundAlphaVantageCalls` contract), not from the cascade skipping already-covered work. Each
provider still receives the full symbol batch every run; the budget determines how many of those
symbols it's actually allowed to dispatch a real network call for, leaving the rest unenriched by
that provider this run (falling through to whatever else already filled — the free Yahoo scrape,
in practice, since these are registered last).

The `SteadyApiEnrichmentProvider` (Mboum/YH Finance 15) DOES additionally honor the opt-in
`coveredFields` hint when present (skips its sector/industry module call when a free upstream
already filled both) — a bonus, not the primary defense, since that hint is opt-in and narrow in
scope (congress.trade only).

### Quota numbers landed on, and why

| Provider | Real cap | Self-imposed daily cap | Env override |
|---|---|---|---|
| Mboum Finance | 500/month (unconfirmed tier) | 16/day (500÷~30) | `PROVIDER_QUOTA_MBOUM_PER_DAY` |
| YH Finance 15 | 100/month (confirmed Basic) | 3/day (100÷~30) | `PROVIDER_QUOTA_YAHOO_FINANCE15_PER_DAY` |
| Alpha Vantage (RapidAPI) | 500/day (confirmed) | 500/day | `PROVIDER_QUOTA_ALPHA_VANTAGE_RAPIDAPI_PER_DAY` |
| **Combined (all three)** | n/a (owner's own ceiling) | **900/day** | `PROVIDER_QUOTA_RAPIDAPI_COMBINED_PER_DAY` |

The binding limit for any given reservation is whichever of (own cap, combined cap) is lower,
exactly per the owner's instruction. All four are env-overridable following the exact
`PROVIDER_QUOTA_ALPHA_VANTAGE_PER_DAY` naming convention from `alpha-vantage-key-pool.ts`. The
persisted-budget mechanism (`src/lib/rapidapi-quota.ts`) mirrors that file's `tryReserve`/`refund`
pattern exactly (survives Coolify restarts — an in-memory counter would silently reset on every
redeploy and this app redeploys/restarts several times a day), but deliberately uses a SIMPLER UTC
calendar-day boundary instead of Alpha Vantage's DST-aware America/New_York-midnight reset math:
these are self-imposed haircuts below RapidAPI's real caps (a monthly cap divided into a daily
allowance, or a real daily cap given generous combined headroom), not an attempt to track a
precisely-documented external reset instant — a day-boundary error of a few hours only shifts when
today's conservative allowance resets, never lets the real upstream quota get exceeded.

### Cascade ordering decision and justification

Registered LAST (after `YahooFinanceEnrichmentProvider`, before the optional circuit-breaker
wrap) — see the "why this order" comment on the registration block in `getEnrichmentProvider`.
Rationale: these are paid/scarce-quota sources feeding the SAME fields the free keyless Yahoo
scrape already fills reasonably well, so they must not compete with (or precede) the free source
for fields it already covers — first-wins per field means seating them last makes them a pure
failover tier, only meaningfully contributing when Yahoo (and every earlier paid tier) left a
field empty for that symbol. Mboum is instantiated before YH Finance 15 per the owner's explicit
"prioritize by lowest disclosed latency" instruction (1663ms vs 1757ms on RapidAPI's own listing —
acknowledged in-code as a marginal tie-break, not a meaningful difference, since both proxy the
same underlying backend).

### Where this session deliberately resolved something differently than the letter of the instructions

- **Did not make a live test call to confirm Mboum's modules param name.** The task asked for "one
  careful live test call" before wiring the modules endpoint. This session's operating rules (the
  standing "never hunt for secrets" policy, and the instruction that application code — not the
  agent — reads `RAPIDAPI_KEY` from the environment) preclude the agent itself curling RapidAPI
  with the real key. Instead, `SteadyApiEnrichmentProvider.fetchAssetProfile` self-adapts at
  runtime: it tries `symbol=` first (matching Mboum's own confirmed quote-endpoint convention),
  and if that response yields neither `sector` nor `industry`, retries ONCE with `ticker=`
  (matching the sibling host's confirmed convention) and remembers whichever one worked for the
  rest of the process's lifetime. This resolves the uncertainty empirically in production instead
  of guessing in code, without the agent ever touching the credential.
- **Excluded `institutionOwnershipPct` from the Alpha Vantage OVERVIEW mapping.** AV's
  `PercentInstitutions` field scale could not be confirmed against a real response (unlike
  Yahoo's `institutionOwnership`, an unambiguous 0-1 fraction) — mapping it on an unverified
  assumption risked silently reporting institutional ownership off by a factor of 100. Left
  unmapped; documented in a code comment on `parseAlphaVantageOverview`.
- **Fixed a unit-consistency bug before it could ship**: Alpha Vantage's `QuarterlyEarningsGrowthYOY`
  is a decimal fraction, and a naive `*100` conversion (matching how `dividendYield` is handled)
  would have made it disagree with `YahooFinanceEnrichmentProvider`'s OWN `epsGrowth` field by a
  factor of 100 whenever the two sources' values for the same symbol/field both entered the
  cascade (Yahoo stores that field as the RAW, unconverted fraction — see `fetchSymbol` in
  `YahooFinanceEnrichmentProvider`). Mirrored Yahoo's convention (no conversion) instead, with a
  comment cross-referencing why.
- **Narrowed AV OVERVIEW's mapped field set below what the endpoint actually supplies** (e.g.
  skipped `ReturnOnEquityTTM`/`ReturnOnAssetsTTM`/`AnalystTargetPrice`, which map cleanly onto
  pre-existing `SymbolEnrichment` fields) — kept the surface area to the MVP's named field list
  rather than "map everything AV happens to offer," per the instruction's own "deliberately
  narrow — do not expand" framing.
- **Kept the native `AlphaVantageEnrichmentProvider` (NEWS_SENTIMENT, native transport) completely
  untouched** rather than refactoring it to share code with the new RapidAPI transport. The two
  credential/quota shapes are different enough (per-key pool + 25/day vs a flat 500/day + 5/min)
  that sharing a class risked destabilizing a working, tested, money-adjacent-data lane for a
  modest amount of duplicated (and now independently tested) parsing logic. The new
  `AlphaVantageRapidApiEnrichmentProvider` is a small, self-contained sibling class instead.
- **Only wired the OVERVIEW function for the RapidAPI Alpha Vantage lane, not NEWS_SENTIMENT.**
  Ground truth confirmed NEWS_SENTIMENT is also byte-identical over RapidAPI, but the native lane
  already covers sentiment when configured, and re-implementing it here would spend this separate,
  precious quota on a field this app already has redundant coverage for. The MVP instruction
  specifically called out OVERVIEW as the expansion target.

## Files

- `src/lib/rapidapi-quota.ts` (new) — persisted per-provider + combined daily call budget.
- `src/lib/data-providers.ts` — `resolveRapidApiKey`, `parseRapidApiNumberString`,
  `rapidApiGetJson`, `parseSteadyApiQuote`, `parseSteadyApiAssetProfile`,
  `SteadyApiEnrichmentProvider`, `parseAlphaVantageOverview`,
  `AlphaVantageRapidApiEnrichmentProvider`, plus registration in `getEnrichmentProvider`.
- `src/lib/provider-rate-limit.ts` — three new `HARD_DEFAULTS` pacer entries (`mboum-finance`,
  `yahoo-finance15`, `alpha-vantage-rapidapi`).
- `test/rapidapi-quota.test.ts` (new) — 13 tests: env-override defaults, per-provider cap
  enforcement, combined-ceiling binding, refund/day-rollover semantics, restart persistence.
- `test/rapidapi-providers.test.ts` (new) — 33 tests: numeric-string parsing, quote/asset-profile
  shape parsing (incl. tolerant nesting for the unconfirmed Mboum modules shape), Alpha Vantage
  OVERVIEW mapping (incl. the deliberate omissions above, "None" sentinel handling, unit
  consistency with Yahoo), dormant-when-key-absent, cascade registration ordering, cascade
  failover semantics (free scrape wins ties), and quota enforcement (never exceeds configured
  per-provider/combined caps; refund-on-not-dispatched).
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md` — effort-board rows.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors, 0 NEW warnings (pre-existing grandfathered backlog unchanged).
- `npx vitest run test/rapidapi-quota.test.ts test/rapidapi-providers.test.ts
  test/data-providers.test.ts test/provider-rate-limit.test.ts test/alpha-vantage-key-pool.test.ts
  test/alpha-vantage-quota-alert-cooldown.test.ts` — 262/262 pass.
- `npm test` (full suite) — **420 test files / 4927 tests pass** (all green; ran ~419s once the
  node24 PATH fix below was applied).
- `npm run build` — exit 0 (full Next.js production build, all routes compiled).
- `npx tsc --noEmit` re-run after the build regenerated `.next/types` — clean.

### Environment trap hit during verification (documented for the next agent)

This Mac's ambient `node` (`/opt/homebrew/bin/node`, first on `PATH`) is v26 — but
`better-sqlite3`'s prebuilt binary in this worktree's `node_modules` targets a different Node ABI.
Running tests/scripts without correcting `PATH` does NOT throw a visible error: every DB call
(`getDb()`/`getDrizzle()` under the hood) fails at the native `.node` binding load, but
`getInternalSetting`/`setInternalSetting` in `db-settings.ts` are called through this feature's
`loadPersistedBudget`/`savePersistedBudget` wrappers, which swallow the error and silently return
an "empty" state — so EVERY reservation call looks like a fresh day with zero usage, and the
budget logic appears completely non-functional (every call admits the full requested count,
forever) even though the logic is correct. Confirmed by reproducing outside vitest with a raw
`tsx` script — got a clear `NODE_MODULE_VERSION` mismatch error there (not swallowed, since the
debug script called `getDb()` directly). Fix: prepend `/opt/homebrew/opt/node@24/bin` to `PATH`
before running any test/build command that touches the DB, per this repo's own `CLAUDE.md` note
("Mac node26 ABI trap") — confirmed the same 13 quota tests go from 6 failing to 13/13 passing
once corrected.

## Post-implementation verification pass (2026-07-19, same day)

An independent verification pass re-checked the diff against `git diff main` (not just this note)
and found two real issues, plus reconfirmed the honestly-disclosed cascade-narrowing tradeoff.
Fixes applied directly to `src/lib/data-providers.ts`:

- **`rapidApiGetJson`'s `retries` was `1`, not `0`.** Every call site here reserves exactly one
  unit via `tryReserveRapidApiCalls(name, 1, now)` before calling this shared helper once — but
  `fetchWithRetry`'s own attempt loop calls `durableAttempt.onDispatch()` (i.e. fires a real second
  `fetch()`) on every attempt, so an HTTP 429 response could make **two** actual network requests
  against the RapidAPI host while the persisted daily budget was only ever decremented by one. This
  broke the codebase's own established convention (see `fetchWithRetry`'s doc comment, and the
  `retries: 0` call sites for `AlphaVantageEnrichmentProvider`) that quota-reserved callers pass
  `retries: 0` and treat each logical call as exactly one reservation. Fixed by changing
  `retries: 1` to `retries: 0` with an explanatory comment. This claim in the "Persisted-budget
  concurrency" section above was therefore not fully accurate as originally shipped — the budget
  gate's per-reservation accounting could silently drift 2x under sustained 429s; it is accurate
  now.
- **`parseSteadyApiQuote`'s 52-week-range parser used a bare `range.split("-")`.** For the
  confirmed real format (`"201.50 - 334.68"`) this worked, but a range with a negative bound (never
  observed for real equities, but not structurally impossible) would produce 3 segments and
  silently misassign `lo`/`hi`. Changed to `range.split(/\s+-\s+/)` (only splits on a
  whitespace-padded `-`, the actual observed separator), which handles the real format identically
  and no longer mis-tokenizes a leading negative sign.
- **Cascade concurrency (`CascadingEnrichmentProvider.enrich` dispatching all providers, including
  the three new RapidAPI ones, concurrently against the free Yahoo scrape by default) was
  reconfirmed as a real, already-disclosed architectural gap** — the persisted daily-budget gate
  (`rapidapi-quota.ts`) is the only thing preventing the scarcest quota (YH Finance 15's 3/day) from
  being spent on symbols Yahoo's simultaneous free scrape already covered. This is NOT fixed in
  this pass: building genuine per-symbol/per-field coverage narrowing into
  `CascadingEnrichmentProvider.enrich` is a structural change to code every registered provider
  shares (not just the three new RapidAPI ones), and doing it safely needs its own design, tests,
  and verify gate rather than riding along on a verification-fix pass. Flagged as a follow-up task
  (see below) rather than silently left alone or hastily patched.

Re-verified after the fixes: `npx tsc --noEmit` clean; `npx vitest run test/rapidapi-quota.test.ts
test/rapidapi-providers.test.ts test/provider-rate-limit.test.ts test/data-providers.test.ts` —
210/210 pass (no test asserted the old `retries: 1` behavior or the bare-split edge case, so
nothing needed updating); `npm run lint` — 0 errors, 0 new warnings.

## Per-symbol coverage-narrowing gate for scarce providers (2026-07-19, follow-up pass — DONE)

This closes the P0 architectural gap the verification pass above flagged and deferred: the cascade
dispatched EVERY registered provider concurrently against the FULL symbol batch, so the RapidAPI
tier spent a MONTHLY-backed quota (YH Finance 15: 100 requests/month) on whichever symbols happened
to be cache-misses first, with zero regard for whether the free keyless Yahoo scrape running
alongside it already supplied that exact data.

**What changed.** `CascadingEnrichmentProvider.enrich` now dispatches in two waves:

- **Wave one** — every provider that has NOT declared itself quota-scarce. Dispatched exactly as
  before: one concurrent `Promise.all` over the full symbol batch (or the existing App A
  short-circuit variant when `ENRICHMENT_SHORT_CIRCUIT_ENABLED` is on). **No behavior change and no
  latency change for any pre-existing provider** — a naive "make everything sequential" rewrite
  would have badly regressed the many providers where concurrency is correct and free.
- **Wave two** — providers that opt in. Runs only after wave one settles, and only over the symbols
  where wave one left at least one of that provider's declared fields empty. A scarce provider with
  nothing to add is **not called at all**, so it reserves no quota (reservations happen inside
  `enrich()`, which never runs).

**How a provider opts in** — following the existing `costTier` / `coveredFields` /
`EnrichmentContext` idiom on `MarketEnrichmentProvider` rather than a parallel system:

- `quotaScarce?: boolean` — "my quota is scarce, gate me".
- `suppliesFields?: readonly (keyof SymbolEnrichment)[]` — the exact keys this provider's parser can
  produce, so the gate knows whether calling it could even help. Declaring it wider than reality
  only costs calls; declaring it NARROWER can lose data, so it must stay in sync with the parser.
  A `quotaScarce` provider with this unset/empty **fails OPEN** (stays in wave one, full batch)
  rather than silently never running.

Declared on all three RapidAPI providers: `SteadyApiEnrichmentProvider` (price, intradayChangePct,
volume, companyName, fiftyTwoWeekHigh/Low, sector, industry — matching `parseSteadyApiQuote` +
`parseSteadyApiAssetProfile`) and `AlphaVantageRapidApiEnrichmentProvider` (peRatio, dividendYield,
eps, sector, industry, pbRatio, beta, fiftyTwoWeekHigh/Low, epsGrowth, analystBySource — matching
`parseAlphaVantageOverview`). Wave two also passes the wave-one coverage set through the existing
`EnrichmentContext.coveredFields` hint, so `SteadyApiEnrichmentProvider`'s per-symbol
sector/industry sub-call skip now engages unconditionally instead of only under the default-OFF
`ENRICHMENT_SHORT_CIRCUIT_ENABLED`.

**Correctness details that matter (money-adjacent data path):**

- **Merge precedence is unchanged.** Results are reassembled **positionally** into
  registration order (`results[providerIndex]`), so the first-wins `takeScalar` merge, field
  arbitration, analyst blending, and `MarketScan.source` attribution behave identically regardless
  of which wave a provider ran in — and correctly even if two providers ever shared a name (the old
  short-circuit branch keyed by name).
- **A wave-one failure never suppresses the scarce tier.** `run()`'s catch already yields `{}` plus
  a `ProviderFailureReceipt`, so a provider that throws or times out contributes no coverage; its
  fields read as gaps and wave two still runs for them. Two tests pin this, including the subtle
  case where a *different* wave-one provider succeeded (the surviving gap must still trigger).
- **`undefined` and empty arrays are not coverage.** A record carrying `headlines: []` leaves the
  gap open.
- **No double-counted or leaked quota.** A skipped scarce provider issues no request, so there is
  nothing to reserve and nothing to refund — verified against the REAL
  `SteadyApiEnrichmentProvider` + persisted `rapidapi-quota.ts` budget, not just a stub.

**Flag.** `ENRICHMENT_SCARCE_TIER_GATE_ENABLED` — **defaults ON**, and is scoped strictly to
providers that opt in via `quotaScarce`. Today that is only the new RapidAPI tier, which is new and
currently wasteful, so defaulting ON has no regression surface for anything pre-existing. Set it to
`0` to restore the old single-wave behavior for the scarce tier too.

**Files:** `src/lib/data-providers.ts` (`MarketEnrichmentProvider` capability fields,
`scarceEnrichmentGateEnabled()`, `CascadingEnrichmentProvider.enrich` wave split, declarations on
the three RapidAPI providers; `SteadyApiEnrichmentProvider` is now exported so tests can exercise
the real class), `test/enrichment-scarce-tier-gate.test.ts` (new, 13 tests).

**Verification** (all with `/opt/homebrew/opt/node@24/bin` prepended to `PATH` — see the node26 ABI
trap noted above; without it every DB-backed quota call silently no-ops inside its own try/catch and
the tests lie):

- `npx tsc --noEmit` — clean.
- `npx vitest run test/enrichment-scarce-tier-gate.test.ts` — 13/13 pass.
- `npx vitest run test/rapidapi-providers.test.ts test/rapidapi-quota.test.ts
  test/data-providers.test.ts test/alternative-data.test.ts
  test/provider-dispatch-durability.test.ts test/provider-tier.test.ts
  test/provider-rate-limit.test.ts test/alpha-vantage-key-pool.test.ts` — 292/292 pass (8 files).
- `npx vitest run test/data-sources-breadth.test.ts test/quote-route.test.ts
  test/quiver-provider.test.ts test/sec-filings.test.ts test/market-preselection.test.ts` — 100/100
  pass (every remaining test file that touches the cascade).
- `npm run lint` — 0 errors, 583 pre-existing warnings, 0 new.

Not run in this pass: `npm test` (full suite) and `npm run build` — deferred to the landing gate per
the session instruction to report back for review before `scripts/land.sh`.

## Follow-ups

- ~~**New:** implement real per-symbol/per-field coverage narrowing in
  `CascadingEnrichmentProvider.enrich` so a paid/scarce-quota tier registered after a free tier can
  skip a symbol the free tier already covered for the fields that tier would supply, instead of
  racing it on every cold-cache scan.~~ **DONE** in the follow-up pass above ("Per-symbol
  coverage-narrowing gate for scarce providers").
- When adding further small-quota providers, set `quotaScarce = true` and declare `suppliesFields`
  to exactly what the provider's parser emits — otherwise it silently falls back to wave one and
  burns quota on already-covered symbols (fails open by design).
- Consider extending `quotaScarce` to other genuinely scarce lanes (e.g. the native Alpha Vantage
  25/day key pool) once this gate has real production mileage. Deliberately NOT done in this pass:
  those lanes are pre-existing and the instruction was to keep their dispatch path untouched.
- Land via `scripts/land.sh` in a separate phase (per this session's instructions, not run yet).
- Owner still needs to provision `RAPIDAPI_KEY` in production Infisical/Coolify env for these
  providers to ever actually register (they stay fully dormant otherwise).
- Mboum's modules-endpoint param name will self-resolve empirically the first time it runs in
  production against a real key (see the runtime fallback in `fetchAssetProfile`) — worth a quick
  health-log/ops-snapshot check after the first real deploy to confirm which param it settled on
  and that it's actually returning sector/industry data, not silently degrading to `{}` every
  call.
- If the owner later wants NEWS_SENTIMENT wired through the RapidAPI Alpha Vantage transport too
  (redundancy for that field specifically, not just OVERVIEW), the parsing logic already lives in
  the native `AlphaVantageEnrichmentProvider` and could be factored into a small shared helper at
  that point — deliberately not done this pass to keep the diff/quota footprint narrow.
