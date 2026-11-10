# 2026-08-13 — r4 slice: prompt data-age audit (every strategist data block honestly stamped)

## Context & Objective

Owner concern: "I thought we were having the date/time stamp for all data the app has for
honesty's sake." Audit every data block injected into the Green/strategist (Bull) prompt
(`src/lib/strategy-prompts.ts` + the assembly in `src/lib/strategy.ts`'s `proposeTrades`) and
confirm each carries an as-of/age signal — add one where genuinely missing. AUDIT-then-fix: this
note is the audit table (block -> stamp status before/after -> source of truth), followed by the
two fixes it found necessary.

## Audit table

| Block (prompt field) | Stamp before | Source of truth | Status |
|---|---|---|---|
| Quotes/technicals (`marketScan.topCandidates[*]`) | Per-candidate `asOf` ("candidate data freshness — most-recent enrichment timestamp", `compactCandidateForPrompt`) + block-level `marketScan.generatedAt`. Backend even ENFORCES it: `policy.riskRules.maxQuoteAgeSec`/`maxFundamentalsAgeSec` blocks a stale-backed OPENING proposal at review time (`types.ts`). | `MarketQuoteSummary.asOf`, `MarketScan.generatedAt` | Already adequate — no change |
| Headlines (`news` per candidate) | **None.** Provider supplies bare titles with no per-item publish timestamp (`strategy.ts` comment: "Provider headlines are bare titles with no timestamps"); no block-level note existed anywhere in the visible prompt either. | N/A (provider limitation — no timestamp exists to surface) | **FIXED** — added block-level `marketScan.newsAgeNote` |
| Congress signals (`smartMoney` bulletins "Congress: … in the last Nd"; `congressScore`/`congressDir`/`congressConf`/`senateNet`) | Bulletin text embeds the trade-disclosure recency window (`buildBulletin`, `src/lib/web-sources/congress.ts`); the numeric composite fields share the candidate's `asOf`. | `web-sources/congress.ts` `buildBulletin`, candidate `asOf` | Already adequate — no change |
| Insider (`smartMoney` bulletins "Insider: … in last Nd"; `insiderSent`) | Same pattern (`buildInsiderBulletin`, `src/lib/web-sources/sec.ts`); numeric field shares candidate `asOf`. | `web-sources/sec.ts` `buildInsiderBulletin`, candidate `asOf` | Already adequate — no change |
| Fundamentals (`fcf`, `de`, `pe`, `eps`, `pb`, `roa`, `grossMarginPct`, derived `peg`/`earnYld`/`roe`/`payout`, …) | Shares the candidate-level `asOf` — including SEC-XBRL scalars resolved through the point-in-time revision chain (`fundamental_revisions` / `db-fundamentals.ts`), which feeds the same scalar rather than a separately-timestamped path. Backend `maxFundamentalsAgeSec` gate as above. | `MarketQuoteSummary.asOf` | Already adequate — no change |
| Macro/regime (`macroeconomicData`, `macroDerived`, `currentMarketRegime`) | `macroeconomicData.asOf` is in `MACRO_ALWAYS_KEEP` (`src/lib/macro.ts`) — never pruned by the delta-only compaction even when unchanged, so it is present in literally every prompt. | `MacroData.asOf` | Already adequate — no change |
| RAG evidence (`retrievedFinancialContext`) | Each chunk is prefixed by `formatChunkWithProvenance` (`src/lib/vector-db.ts`) with `[DOC_TYPE · SECTION · SYM · YYYY-MM-DD · rel X.XX]` whenever `chunk.as_of` exists, and silently (honestly) omits the date segment — never fabricates one — when it doesn't (already regression-tested: `test/vector-db-provenance.test.ts`). The block-level `evidenceManifest` receipt additionally stamps `asOf: null` for this family, correctly, since a bundle of many differently-dated chunks has no single as-of. | `vector-db.ts` `formatChunkWithProvenance`, `RetrievedChunk.as_of` | Already adequate — no change |
| Polymarket (`predictionMarkets`, new in r3) | **None.** No per-line date, no cache-age note, and the field wasn't even documented in the Bull system prompt (`predictionMarkets` never mentioned in `buildBullSystem`). | N/A before this fix | **FIXED** — added block-level `marketScan.predictionMarketsAgeNote` + documented the field in the system prompt |
| Learned lessons (`learnedContext`; `thesisOutcomes`/`regimeOutcomes`/`comboOutcomes`/`sectorOutcomes`/`factorOutcomes`/`signalEfficacy`/`confidenceCalibration`/`skippedCounterfactuals`) | Each `learnedContext` line carries inline `asserted=YYYY-MM-DD` provenance (`formatLearnedContextLine`, `src/lib/learned-context/store.ts`). The scorecards are live aggregates recomputed fresh every run from the account's full fill history — their `evidenceManifest` ref stamps `asOf: decisionAsOf` (this run's own point-in-time), which is correct since they are not a cached/stale snapshot. | `learned-context/store.ts`, `evidenceManifest` (`asOf: decisionAsOf`) | Already adequate — no change |
| Portfolio state (`portfolio`, `positions`, `recentOrders`, `activeProtection`) | Fetched synchronously at the top of `proposeTrades`, same run as `decisionAsOf`/`userContent.currentDate`; the `evidenceManifest`'s "broker-account-state" ref stamps `observedAt`/`asOf`: `decisionAsOf`. No separate per-field broker timestamp exists (none is fabricated), but the whole block is fetched fresh every run so the run-level anchor is honest. | `userContent.currentDate` (= `input.asOf`, captured when the run acquired its lock), `evidenceManifest` | Already adequate — no change |

## Changes Made

Two blocks had a genuine gap (Headlines, Polymarket); both fixed at the **block level** (one line
per scan, not per headline/market — keeps prompt token cost low, matches the existing
`marketScan.instructions` convention).

- **`src/lib/strategy.ts`** (`compactMarketScanForPrompt`, now exported for tests):
  - Computes `topCandidates` once (post-compaction, so the check reflects what actually reaches
    the model — a candidate whose raw headlines all dedupe/strip away to nothing must not trigger
    the note).
  - Adds `newsAgeNote` (block-level, only when any compacted candidate carries `news`): states
    that headlines carry no provider-supplied per-item timestamp — age UNKNOWN, not same-day —
    and points at dated evidence to corroborate timing against.
  - Adds `predictionMarketsAgeNote` (block-level, only when any compacted candidate carries
    `predictionMarkets`): states the REAL configured Polymarket cache TTL (default 10 minutes,
    reflects a `POLYMARKET_CACHE_TTL_MS` override) as an honest upper bound. Deliberately NOT a
    fabricated per-market "fetched Nm ago" — the shared cache means different markets in the same
    batch can have different actual ages, so a stated ceiling is the honest block-level framing,
    not a specific invented timestamp.
- **`src/lib/polymarket-provider.ts`** — exported the existing `polymarketTtlMs()` (was
  module-private) so the prompt-assembly layer reads the real configured constant instead of
  hardcoding a second copy that could drift from it.
- **`src/lib/strategy-prompts.ts`** (`buildBullSystem`):
  - `predictionMarkets` is now documented in the "Evidence per candidate" line (it was never
    mentioned before this fix, despite being wired into the prompt since r3).
  - New "Data-age honesty" line names `marketScan.newsAgeNote`/`marketScan.predictionMarketsAgeNote`
    and, for completeness, recaps where every OTHER block's as-of already lives (candidate `asOf`,
    `generatedAt`, `macroeconomicData.asOf`, congress/insider "in last Nd", RAG chunk dates,
    `learnedContext`'s `asserted=` dates) — so the model has one place that tells it how to read
    freshness across the whole payload.
  - `STRATEGY_PROMPT_VERSION` bumped `2.4.0` -> `2.5.0` (prompt wording changed; main already
    used 2.4.0 for the venue-contract prompt, so this pickup lands as 2.5.0).
- **`test/strategy-prompt-data-age.test.ts`** (new) — `newsAgeNote`/`predictionMarketsAgeNote`
  present/absent correctly (never a scaffold when the block has nothing to say), the Polymarket
  note reflects the real `POLYMARKET_CACHE_TTL_MS` knob (not a hardcoded duplicate), plus two
  regression checks that had no prior direct test: candidate `asOf` passthrough/no-fabrication
  (`compactCandidateForPrompt`) and `generatedAt` always present.
- **`test/strategy-prompt-safety.test.ts`** — updated the exact-string `STRATEGY_PROMPT_VERSION`
  assertion for the 2.5.0 bump.

## Decisions & Trade-offs

- **Block-level, not per-item.** Per the slice spec: headlines and Polymarket lines can both
  appear many times per candidate across many candidates: one line per scan (in
  `compactMarketScanForPrompt`'s top-level object, the same home as `instructions`) instead of
  duplicating a note next to every headline/market keeps the token cost fixed regardless of
  candidate count.
- **Polymarket note states a cache-TTL upper bound, not a derived exact fetch time.** Tracking a
  real per-query `fetchedAt` was considered, but the shared in-process cache means different
  markets injected in the SAME batch can have different actual ages (0 to TTL minutes old) — a
  single "fetched Nm ago" derived from one entry would misrepresent the others. Stating the real,
  code-enforced ceiling (`polymarketTtlMs()`) is honest without needing per-market tracking, and
  is still a real value read from the pipeline, not invented.
- **Headline note omitted entirely when no candidate has news, and the same for Polymarket** —
  matches the codebase's existing "never an empty scaffold" convention (e.g. `news` itself is
  omitted per-candidate when empty, not sent as `[]`).
- **Did not touch RAG's silent date-omission for chunks lacking `as_of`.** Already covered by
  `test/vector-db-provenance.test.ts` ("omits missing fields gracefully instead of rendering a
  placeholder") and consistent with the rest of the audit's honesty bar — no change needed.
- **No change to `db.ts` migrations** — this slice touches prompt assembly only, no new
  persisted/user-scoped tables.

## Verification State

```
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx tsc --noEmit                                             # clean
npx vitest run test/strategy-prompt-data-age.test.ts test/strategy-prompt-safety.test.ts \
  test/strategy-headlines-prompt.test.ts test/strategy-prompt-wiring-counterfactuals.test.ts \
  test/strategy-active-protection-wiring.test.ts test/vector-db-provenance.test.ts \
  test/macro.test.ts test/polymarket-provider.test.ts        # 81/81 passed
npx vitest run test/run-strategy-offline.test.ts test/strategy-prompt-version.test.ts \
  test/redteam-observability-g10.test.ts                     # 10/10 passed (prompt-version consumers)
npx eslint src/lib/strategy.ts src/lib/strategy-prompts.ts src/lib/polymarket-provider.ts \
  test/strategy-prompt-data-age.test.ts test/strategy-prompt-safety.test.ts
                                                               # 0 errors (44 pre-existing grandfathered warnings, none new)
```

Did NOT run `npm run build` or the full suite per this slice's scope instructions.

## Next Steps & Blockers

- None known. Committed locally on `agent/claude`; lands via a round-4 integration lane like the
  other r4 slices.
- Out of scope for this slice (not gaps, just adjacent follow-ups if ever wanted): a real per-market
  Polymarket `fetchedAt` (would need the shared cache restructured to carry per-entry fetch times,
  not just TTL expiry); surfacing per-field enrichment timestamps (price vs. fundamentals) instead
  of one candidate-level `asOf` — the existing `maxQuoteAgeSec`/`maxFundamentalsAgeSec` gate already
  treats them as distinct concerns on the backend even though the prompt surfaces one stamp.
