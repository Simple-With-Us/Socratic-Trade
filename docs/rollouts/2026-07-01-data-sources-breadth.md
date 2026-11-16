# 2026-07-01 — Data sources & breadth (Chat D)

## Summary
Implemented all six items of the audit work-split "Chat D — Data sources & breadth"
(`docs/reviews/2026-07-01-audit-work-split.md`, lines ~128–154): earnings-calendar
signal, a correctness fix for synthetic bid/ask, institutional ownership, a
Robinhood options/IV enrichment tier, an active per-provider circuit breaker, and
FMP as a second short-interest source with a material-disagreement flag. New
behavior (items 4, 5, and item 6's second short-interest call is always-on but the
disagreement flag is derived, not routed) is default-safe; the two behavior-changing
tiers (options, circuit breaker) are behind default-off env flags.

## Why
The audit found real, additive holes in the otherwise best-scoring data-source
dimension: no next-earnings signal, a synthetic bid/ask masquerading as a real
quoted spread that anchored live limit-price math (a correctness/safety bug), no
institutional ownership despite an already-authenticated Yahoo call, no options/IV
despite a connected Robinhood MCP, an inert circuit breaker, and single-sourced
short interest.

## Items (status)
1. **`daysToEarnings`** — DONE. Added Yahoo `calendarEvents` to the `quoteSummary`
   modules string; `parseDaysToEarnings` returns whole days to the earliest FUTURE
   earnings date and degrades to `undefined` (never 0/guess). Threaded through the
   full enrichment checklist; surfaced as `earnIn` in `compactCandidateForPrompt`.
   Zero-cost (same call), default-on.
2. **Synthetic bid/ask fix** — DONE (approach b: provenance-tagged). `yahoo-finance.ts`
   now marks price-derived spreads with `syntheticSpread`; `toQuoteOnlyMarketQuote`
   tags `sources.bid`/`sources.ask` as `yahoo-finance-synthetic`. `mergeSources`
   preserves that tag through enrichment. `strategy.ts` `hasAskData` (via new
   `hasRealAsk`) and the marketable-limit calc now exclude a synthetic ask, degrading
   to `refPrice`-based limits. Correctness/safety fix, default-on.
3. **Institutional/13F ownership** — DONE. Widened the SAME Yahoo `quoteSummary`
   modules (`institutionOwnership`,`majorHoldersBreakdown`); `parseInstitutionOwnershipPct`
   prefers `majorHoldersBreakdown.institutionsPercentHeld`, falls back to summing the
   ownership list. Threaded through the full checklist. Zero additional API cost,
   default-on.
4. **Robinhood options/IV tier** — DONE, default-off. Added `fetchRobinhoodOptionChain`
   (`get_option_chains`/`get_option_instruments`) to `robinhood.ts` and a new
   low-frequency, long-TTL provider `src/lib/robinhood-options.ts`
   (`RobinhoodOptionsEnrichmentProvider`) deriving near-the-money IV + put/call ratio.
   Gated behind `ROBINHOOD_OPTIONS_ENRICHMENT_ENABLED` (default off) AND a connected
   Robinhood MCP. Tests mock the gateway parser; no live MCP.
5. **Active per-provider circuit breaker** — DONE, default-off. `applyCircuitBreaker`
   consults `getServiceHealthSummaries()` and no-ops a lane whose health is
   `stoppedWorking` (all its credential lanes), re-probing only after a backoff window.
   Gated behind `ENRICHMENT_CIRCUIT_BREAKER_ENABLED` (default off). Existing
   provider happy-path tests pass unmodified.
6. **FMP 2nd short-interest source + disagreement flag** — DONE. Added an FMP
   `short_interest` sub-call carried alongside Yahoo's read (not first-wins); the
   cascade flags a material (≥5pp, `SHORT_INTEREST_DISAGREEMENT_PCT_PT`) Yahoo-vs-FMP
   disagreement as an evidence bulletin. `MarketScan.source` includes `fmp` only when
   FMP actually contributed (existing `contributingNames` crediting) — never hardcoded.

## New env flags (all defaults preserve today's behavior)
- `ROBINHOOD_OPTIONS_ENRICHMENT_ENABLED` — default **off**. Enables the options/IV tier
  (also requires `ROBINHOOD_ADAPTER=mcp`). `ROBINHOOD_OPTIONS_TTL_MS` tunes its cache
  (default 6h).
- `ENRICHMENT_CIRCUIT_BREAKER_ENABLED` — default **off**. Enables skipping
  `stoppedWorking` lanes. `ENRICHMENT_CIRCUIT_BREAKER_BACKOFF_MIN` (default 15) is the
  re-probe window.
- `SHORT_INTEREST_DISAGREEMENT_PCT_PT` — default **5**. Percentage-point threshold for
  the short-interest disagreement flag. (The FMP short-interest sub-call itself is
  always issued; a non-premium 403 is tolerated/suppressed like insider/senate.)

## Files
Source (owned):
- `src/lib/types.ts` — `MarketQuote`/`MarketQuoteSummary`/`EnrichmentSources` new fields.
- `src/lib/data-providers.ts` — `SymbolEnrichment`/`EnrichmentSourcedField`/`EMPTY_SOURCED`
  additions; `takeScalar` wiring; Yahoo modules + parsers (`parseDaysToEarnings`,
  `parseInstitutionOwnershipPct`); FMP `short_interest` sub-call; short-interest
  disagreement in the cascade; `applyCircuitBreaker`/`SkippedEnrichmentProvider`;
  options-tier + circuit-breaker + disagreement flag helpers; provider wiring.
- `src/lib/yahoo-finance.ts` — `syntheticSpread` flag on synthesized bid/ask.
- `src/lib/market.ts` — `toQuoteOnlyMarketQuote` synthetic provenance tag;
  `applyEnrichment`/`quotesBySymbol` new fields + disagreement bulletin; `mergeSources`
  preserves price-family provenance.
- `src/lib/strategy.ts` — `hasRealAsk`, `hasAskData` + marketable-limit exclude synthetic
  ask; `compactCandidateForPrompt` new fields (`earnIn`,`instOwn`,`iv`,`putCall`).
- `src/lib/robinhood.ts` — `fetchRobinhoodOptionChain`.
- `src/lib/robinhood-options.ts` — NEW options-IV enrichment provider + pure parsers.

Tests (owned):
- `test/data-sources-breadth.test.ts` — NEW: items 1,3,4,5 (parsers, cascade threading,
  options metrics, circuit-breaker skip/re-probe).
- `test/data-providers.test.ts` — extended: FMP short-interest disagreement (+ agreement)
  cases; updated FMP sub-call counts 4→5.
- `test/market.test.ts` — extended: new-field `applyEnrichment` merge + disagreement bulletin.
- `test/market-custom-symbol.test.ts` — extended: synthetic bid/ask provenance tag.
- `test/strategy-hardening.test.ts` — extended: marketable-limit uses real ask, degrades on synthetic.
- `test/milestone-4-challenger.test.ts` — updated FMP sub-call count 4→5 (short_interest added).

Also touched (sandbox only, do NOT land): `package.json`/`package-lock.json` were
repointed to the local `congress-trading-shared` file: stub so deps install in this
environment. The orchestrator should discard/reconcile these — they are not part of
the feature.

## Verification
- `npx tsc --noEmit` — clean for all owned files (0 errors). The only 3 repo-wide tsc
  errors are in congress files (`congress-share.ts`, `congress-trade-client.ts`,
  `congress-analytics.ts`) caused by the sandbox `congress-trading-shared` stub's
  `safeParse` shape — not this workstream and outside ownership.
- `npx eslint <owned files>` — 0 errors (only pre-existing grandfathered "warn" backlog).
- Targeted tests green: `npm test -- test/data-sources-breadth.test.ts
  test/data-providers.test.ts test/market.test.ts test/market-custom-symbol.test.ts
  test/strategy-hardening.test.ts test/milestone-4-challenger.test.ts` → 161 passed.
- Full `npm test`: remaining failures are all NON-owned: 8 congress-* tests (sandbox
  stub `API_PATHS = {}`) and 1 `dashboard-fill-batching.test.ts` (the concurrent Chat E
  agent's in-progress dashboard.ts work). None are caused by this workstream.
- `npm run build` NOT run (would wipe `.next/` and break the concurrent agent, per
  instructions).

## Follow-ups / risks
- The concurrent Chat E agent is editing `dashboard.ts`/`dashboard-feed.ts`/`db*.ts`/
  `tax.ts`/`performance.ts`/`dashboard-client.tsx` in the same tree; its
  `dashboard-fill-batching.test.ts` was failing at hand-off (its own item, not mine).
- FMP `short_interest` response shape is provider-defined; the parser tolerates
  `shortPercentOfFloat`/`shortPercentFloat`/`shortInterestPercent`/`percentOfFloat` and
  fraction-vs-percent. Verify against a live FMP key before trusting the disagreement
  flag in production; a non-premium key returns 403 (suppressed) and simply yields no
  second source (no flag), which is safe.
- Options-tier + circuit-breaker are default-off; enable + verify against a live
  Robinhood MCP / real health data before relying on them.
- UI surfacing of the new fields (earnings, institution %, IV, put/call, disagreement
  bulletin) is intentionally out of scope — data reaches `MarketQuote`/the prompt
  correctly attributed; dashboard wiring is a follow-up.
- `package.json`/`package-lock.json` sandbox edits must be reverted/reconciled by the
  orchestrator (private-dep stub only).

## Codex review follow-ups (PR #292, 2026-07-01)

Addressed 5 of 6 automated P2 suggestions on the new tiers; all with tests:

- **Options cache keyed by user** (`robinhood-options.ts`) — the long-TTL cache is now keyed
  `userId::symbol`, not by symbol alone, so user A's per-user-OAuth-token-derived IV/put-call
  can never be served to user B (who fails closed). Test: `data-sources-breadth.test.ts`.
- **Underlying price threaded into option metrics** (`robinhood.ts` + `robinhood-options.ts`) —
  `fetchRobinhoodOptionChain` now also fetches the underlying last/mark price (`get_equity_quotes`)
  and returns it; `deriveOptionMetrics(raw, raw.underlyingPrice)` uses it to pick the true
  near-the-money strike and apply the ±20% ATM put/call filter (far-OTM strikes no longer drive
  the fields). Fallback (no price) documented + tested.
- **`underlying_symbol` MCP arg** (`robinhood.ts`) — `get_option_chains`/`get_option_instruments`
  now send `underlying_symbol` (alongside `symbol`/`symbols` for tolerance), matching the chat
  orchestrator's caller, so servers requiring it no longer throw → null → empty metrics.
- **Circuit breaker no longer trips on a single cold failure** (`data-providers.ts` +
  `db-health.ts`) — it now requires the exported `HEALTH_REASON_CONSECUTIVE_FAILURES` (5
  consecutive) condition, not the broad `stoppedWorking` flag that a lone "no success yet this
  hour" failure also sets. Test asserts a single failure does not blackout the lane.
- **Short-interest failures included in the FMP cache guard** (`data-providers.ts`) — a transient
  (429/5xx) `short_interest` failure now blocks caching the FMP row so the Yahoo-vs-FMP
  disagreement signal isn't suppressed until TTL; a non-premium 403 is (correctly) not transient
  and still caches. Two tests cover both.

**Deferred (1 of 6):** "trip the circuit breaker per credential lane" — backing off the *specific*
failing credential (env vs a given user) rather than requiring every lane for the service to be
stopped. This needs the provider to carry its `keySource` into `applyCircuitBreaker` (an interface
change threaded through ~9 providers) and is a design refinement of a **default-off** feature; the
current "all lanes stopped" behavior is the deliberate conservative choice (don't black out a
provider that can still serve someone). The `#5` tightening above already removes the most harmful
false-trip. Tracked as a follow-up rather than expanding this PR's surface.

## Codex review — 2nd round (PR #292, commit c58823a → follow-up)

Four further P2s, two of them behavior regressions in the ostensibly-safe changes; all fixed + tested:

- **[E] Unified feed cap broke ledger reconciliation** (`dashboard-feed.ts`) — the client's
  `decisionLedgerItems` reconciles fill/order statuses for up to 100 recent proposals from
  `unifiedFeed`, not just to render it, so the flat `.slice(0, 60)` dropped statuses for proposals
  beyond the newest 60 (a real output change, violating E's identical-output rule). Now keeps EVERY
  proposal-bearing group and caps only the proposal-less, render-only tail — the rendered newest-50
  and the reconciled statuses are both provably unchanged. Test added.
- **[D] Per-side marketable-limit pricing** (`strategy.ts`) — the all-or-nothing `syntheticSpread`
  flag discarded a real bid when only the ask was synthetic (and vice-versa). Now each side is judged
  independently (`syntheticAsk`/`syntheticBid`), so a buy still anchors on a real ask and a short on a
  real bid. Test added.
- **[D] `parseDaysToEarnings` dropped same-day / straddling windows** (`data-providers.ts`) — the
  1-day grace let `Math.min` pick a just-past window edge → negative days → `undefined`, hiding
  near-term earnings on earnings day. Now prefers the earliest strictly-upcoming date and clamps the
  grace window to 0. Two tests added.
- **[D] `extractUnderlyingPrice` ignored the nested `quote` envelope** (`robinhood.ts`) — Robinhood
  commonly returns `{ quote: {...} }`; the extractor now reads `item.quote ?? item` (exported + tested)
  so the options tier gets a real moneyness anchor instead of falling back to median IV.

### 3rd round (commit c2971e8 → follow-up)

- **[D] Sticky synthetic bid/ask provenance across `mergeQuoteData`** (`market.ts`) — the new
  `yahoo-finance-synthetic` tag was not refreshed when `mergeQuoteData` later merged a REAL broker
  bid/ask (it only updated volume provenance), so a genuine broker spread still looked synthetic to
  `hasRealAsk`/the marketable-limit calc and wrongly fell back to `refPrice`. Both merge branches
  (`topCandidates` + `quotesBySymbol`) now refresh the side's provenance to the broker provider when a
  real value is accepted. Test added asserting a merged real spread carries broker (not synthetic)
  provenance on both. This was a direct consequence of the item-2 provenance tag, not a pre-existing bug.

### 4th round (commit e756175 → follow-up) — all follow-ons to items 4 & 6

- **[D] Finnhub cache now keyed by `FINNHUB_DROP_RECOMMENDATION`** (`data-providers.ts`) — a row
  fetched with the recommendation dropped is missing Finnhub's analyst vote; caching it under the plain
  `finnhub` namespace meant turning the flag back OFF kept serving the partial row until TTL. Reads/writes
  now use a `finnhub-norec` namespace when the flag is on, so flipping it is a natural cache miss (→
  refetch) while caching still works within each flag state. Test added (toggle → refetch).
- **[D] Short-interest HTTP 500 now blocks caching** (`data-providers.ts`) — `isTransientError` matches
  502/503/504 but not 500, so a 500 on the optional `short_interest` call slipped through the round-1
  guard and wrote a full-TTL row missing the disagreement input. The guard now blocks caching on ANY
  recoverable short-interest failure (429/5xx incl. 500/network/timeout); only a permanent 403/404 caches
  without it. Test added (500 → refetch).
- **[D] Option put/call falls back to volume when OI is zero** (`robinhood-options.ts`) — `openInterest
  ?? volume` selected a present-but-zero OI (common for new/same-day strikes) and dropped the row; now
  uses volume whenever OI is not positive. Test added.

### 5th round (commit 152d225 → follow-up) — inverse of the round-3 provenance fix

- **[D] Preserve synthetic provenance across Test-mode broker merges** (`types.ts`, `robinhood.ts`,
  `market.ts`) — the round-3 `refreshSideProvenance` fix assumed a merged broker bid/ask is always REAL,
  but in the DEFAULT Test mode `TestBrokerGateway.getEquityQuotes` returns Yahoo *batch* quotes that can
  themselves be synthetic. `BrokerQuote` dropped the `syntheticSpread` flag and passed `provider:
  "yahoo-finance"`, so the refresh overwrote a `yahoo-finance-synthetic` tag with plain `yahoo-finance` —
  making a price-derived ask look real to `hasRealAsk`/marketable-limit (re-introducing the item-2 bug in
  Test mode). Fixed by threading `syntheticSpread` through `BrokerQuote` (set in the Test gateway) and
  having `refreshSideProvenance` tag a synthetic spread `yahoo-finance-synthetic` (volume, a real datum,
  still takes the actual provider). Test added.


