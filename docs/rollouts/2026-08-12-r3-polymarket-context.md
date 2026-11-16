# 2026-08-12 — r3 slice: keyless Polymarket prediction-market context

## Context & Objective

Round-3 slice of the external-repo/social-sentiment lessons program. Implements the
implementable subset of the "social-sentiment axis" lesson: real-money crowd odds from
Polymarket's public Gamma API as strategist-prompt context. Reddit/X remain OUT of scope — both
are blocked on owner-provisioned API keys and no agent may create one (CLAUDE.md, "NEVER create a
new provider API key"). Polymarket needs no key at all, so this slice ships standalone.

## Changes Made

- **`src/lib/polymarket-provider.ts`** (new) — keyless provider + prompt formatter.
  - API shape verified LIVE against `gamma-api.polymarket.com` on 2026-08-12 (curl probes, not
    training-data memory — see the file header for the full verified shape, cache-control
    behavior, and rate-limit observations). `GET /public-search?q=<text>&limit_per_type=<n>`
    returns `{ events: [{ markets: [{ question, outcomes, outcomePrices, volume, volume24hr,
    active, closed, archived }] }] }`; `outcomes`/`outcomePrices` are JSON-ENCODED STRINGS
    (index-aligned), not native arrays — a live-shape detail training data would not know.
  - `fetchPolymarketContextForSymbols(symbols, companyNames)`: one `/public-search` request per
    unique symbol (query = companyName ?? symbol), filtered to live markets (`active && !closed
    && !archived`), each candidate market scored via `scoreHeadlineRelevance` (reused verbatim
    from `news-relevance.ts` — same ticker/company-name/ambiguous-name-corroboration rubric every
    other keyless provider in this app uses), kept only at/above `POLYMARKET_MIN_RELEVANCE`, top
    3 per symbol by relevance then 24h volume. In-process cache keyed by query text, 10-minute
    TTL (`POLYMARKET_CACHE_TTL_MS`, default). Bounded to `POLYMARKET_MAX_SYMBOLS_PER_RUN`
    (default 20) distinct symbols per call — a deliberate ceiling since this is prompt-time
    enrichment for the candidates entering ONE LLM call, not a scan-wide provider. Fails open at
    every layer: the whole function is wrapped so an unexpected error yields `{}`; each symbol's
    fetch/parse is caught independently so one bad symbol never blanks the rest; a symbol with no
    relevant live market simply has no entry — never an empty-array placeholder.
  - `formatPolymarketLinesForPrompt(markets)`: pure formatter, bounded to
    `MAX_MARKETS_PER_SYMBOL` (3) whole lines, e.g. `Polymarket: "Will Apple beat earnings
    estimates this quarter?" — Yes 62% (24h vol $1.8K, total vol $268.7K)` — always explicitly
    Polymarket-attributed, percent rounded to whole number, volume compact-formatted.
  - Fires one bounded aggregate `audit("polymarket.context", { symbolsProbed, marketsMatched,
    droppedForRelevance })` per call, never per-market.

- **`src/lib/strategy.ts`** (`proposeTrades`) — prompt wiring, mirroring the seam that injects
  `prompt-headlines.ts`'s output (studied both injection sites: the `promptMarketScan`
  containment clone and `compactCandidateForPrompt`) and the seam that fetches
  `getUpcomingEconomicEventsForPrompt` (prompt-time-only external context, gated for free by only
  running when `proposeTrades` itself runs — i.e. never on a budget-skipped/threshold-skipped
  run):
  - Fetches `polymarketBySymbol` right after `upcomingEconomicEvents`, over
    `input.marketScan.topCandidates` (the exact set entering this prompt).
  - `promptMarketScan`'s per-candidate containment clone gets a new `polymarketLines` override
    (same `containData("news", ...)` per-line sanitization as headlines — "news" is the closest
    fit in `PromptTextSource`, a third-party text source that is never trusted-owner).
  - `compactCandidateForPrompt` gains a `predictionMarkets` key alongside `news`/`smartMoney`.
  - The advisory prompt-injection scan (`untrustedPromptFields`) gains a `polymarket:<sym>` entry
    per candidate, matching the existing news/smartMoney entries' "mirror what
    compactCandidateForPrompt injects" contract.

- **`src/lib/types.ts`** — `MarketQuote.polymarketLines?: string[]` (prompt-time-only field, next
  to `evidenceBulletins`; NOT added to `MarketQuoteSummary` since it is never persisted on the
  stored `MarketScan`/`quotesBySymbol`, only synthesized on the ephemeral prompt clone).

- **`src/lib/source-settings-catalog.ts`** (group `enrichment`) — two new knobs, resolved via the
  existing `resolveSourceBool`/`resolveSourceNumber` fail-open contract:
  - `POLYMARKET_CONTEXT` (boolean, default **true**).
  - `POLYMARKET_MIN_RELEVANCE` (number, default **0.5**, min 0, max 1).

- **`test/polymarket-provider.test.ts`** (new, 18 tests) — relevance matching (AAPL/Apple-earnings
  match; TGT/Target ambiguous-name corroboration gate, both without and with a finance term;
  irrelevant market dropped; closed/archived/inactive markets dropped), bounded-top-3
  relevance-then-volume sort, TTL cache (hits within TTL, distinct cache per query text), knob-off
  passthrough (zero fetch calls), per-run symbol bound, fail-open (HTTP error, transport error,
  malformed body), zero-match-contributes-nothing, and `formatPolymarketLinesForPrompt` formatting
  (bounded lines, whole-percent, compact volume, Polymarket attribution).

## Decisions & Trade-offs

- **Why "TGT"/"Target" instead of "META"/"Meta" for the ambiguous-name-corroboration test.** Live
  verification (`scoreHeadlineRelevance`) showed Meta Platforms' own ticker ("META")
  case-insensitively word-matches the bare word "Meta" in ordinary prose, so a META-ticker
  question mentioning "Meta" always clears relevance via the TICKER signal alone and never
  actually exercises the ambiguous company-NAME gate. TGT/"Target" is the same
  `AMBIGUOUS_COMPANY_NAMES` gate with a ticker that doesn't collide with the ambiguous word,
  matching `news-relevance.ts`'s own test precedent (`test/news-relevance.test.ts`).
- **No wiring into `data-providers.ts`'s `CascadingEnrichmentProvider`/`EnrichmentSourcedField`
  cascade.** That cascade enriches every scan-wide symbol every scan cycle; Polymarket context is
  deliberately prompt-time-only (candidates entering ONE LLM call), matching the spec and mirroring
  `evidenceBulletins`'s existing posture (also absent from `EnrichmentSourcedField`/`takeScalar`/
  `EMPTY_SOURCED`).
- **Dependency-health registration: none needed, by design.** Investigated `/api/health`'s
  dependency map (`getServiceHealthSummaries()` in `src/lib/db-health.ts`, read by
  `src/lib/ops-snapshot.ts`): it derives its service list dynamically from `SELECT DISTINCT
  service FROM api_health_log` — there is no static registry to edit. Passing `service:
  "polymarket"` to `fetchWithRetry` (already done) is sufficient; a health row appears
  automatically the first time this module actually runs, and nothing here adds a per-tick
  network call (the health map itself never polls — it only reads what real calls already wrote).
- **Evidence-pack family: none extended, by design.** Investigated `src/lib/evidence-pack.ts`'s
  `EvidenceSourceFamily`. The new `predictionMarkets` field lives inside `compactCandidateForPrompt`'s
  per-candidate object, which is nested entirely inside the EXISTING `market-candidate-set`
  `EvidenceRef` (`family: "market"`) built from `compactPromptMarketScan` in `strategy.ts` — the
  same structural home headlines/evidenceBulletins already use. No new `EvidenceRef` or family
  value was needed or added.
- **Probability side chosen: whichever outcome currently has the higher price** (not always
  "Yes"). For a market where "No" is priced at 90%, the line reads `No 90%` rather than `Yes 10%`
  — this is the more informative phrasing (the consensus view) and avoids a misleadingly low
  headline number; documented in the module's doc comment.
- **Per-request query text is `companyName ?? symbol`, unmodified** (no corporate-suffix
  stripping before the search call) — Polymarket's search is a loose text match (verified live:
  "apple" and "Apple Inc." both resolve equivalent matches), and `scoreHeadlineRelevance` already
  strips the suffix internally for the relevance comparison, so stripping it again for the query
  string would add complexity with no verified behavior change.

## Verification State

```
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx tsc --noEmit                                   # clean
npx vitest run test/polymarket-provider.test.ts     # 18/18 passed
npx vitest run test/source-settings.test.ts test/strategy-headlines-prompt.test.ts \
  test/strategy-prompt-wiring-counterfactuals.test.ts test/strategy-active-protection-wiring.test.ts \
  test/strategy-prompt-safety.test.ts test/strategy-episodic-injection.test.ts \
  test/strategy-rag-quickwins-wiring.test.ts        # 29/29 passed (adjacent seams touched)
npx eslint src/lib/polymarket-provider.ts src/lib/strategy.ts src/lib/types.ts \
  src/lib/source-settings-catalog.ts test/polymarket-provider.test.ts
                                                     # 0 errors (43 pre-existing grandfathered warnings, all in strategy.ts, none new)
```

Did NOT run `npm run build` or the full suite per this slice's scope instructions — lands via the
round-3 integration lane, which runs the full gate.

## Next Steps & Blockers

- None known. Committed locally on `agent/claude`; lands via the round-3 integration lane like the
  other r3 slices (scorecard, lookahead audit, PIT fundamentals).
- Not done (out of scope for this slice, per spec): Reddit/X buzz — both remain blocked on
  owner-provisioned API keys.
