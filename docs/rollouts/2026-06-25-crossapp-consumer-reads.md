# 2026-06-25 — Cross-app consumer reads (fundamentals/analyst from Congress.Trade)

## Summary
Added the App B (agentic-trading) consumer half of the cross-app fundamentals/
analyst data-sharing. Congress.Trade (App A) now exposes
`GET /api/market/fundamentals/:ticker` and `/api/market/analyst/:ticker` (it
already stored these — written by our own donated push + its enrichment — but had
no reader, so App B kept re-paying providers for data App A had). This wires App B
to read them.

## Why
Lower duplicate paid-provider calls and keep fundamentals/analyst numbers
consistent between the two apps. App A's data covers the full congressional
ticker universe and is free to read.

## Files
- `src/lib/congress-trade-client.ts` — new `getAppAFundamentals()` /
  `getAppAAnalyst()` (mirror `getAppAPrices`; gated by `congressReadsEnabled()`),
  plus `AppAFundamental` / `AppAAnalyst` types.
- `src/lib/data-providers.ts` — new `CongressTradeEnrichmentProvider` (name
  `congress.trade`) mapping the latest App A fundamentals + analyst row onto the
  existing `SymbolEnrichment` fields (peRatio, eps, beta, dividendYield,
  fiftyTwoWeekHigh/Low, fcfYield, debtToEquity, epsGrowth, targetMean/High/Low/
  Median, analystRating/Score/BySource). Registered in `getEnrichmentProvider`
  ahead of the paid fundamentals providers, **gated by `CONGRESS_TRADE_READS_ENABLED`**
  (default OFF). Supplies only fundamentals/analyst (no price), so real-time quote
  ordering is unchanged. No new `SymbolEnrichment` field → no cross-file field
  plumbing needed.

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 1184 tests pass (132 files).
- `npm run build` — succeeds.

## Codex review response (PR #160)
- **P1 docs** — updated `PLAN.md` + `docs/congress-trade-consume.md` (§1b) to cover this tier.
- **P2 rating-only rows** — the cascade derives the displayed rating from `analystBySource`, not the
  `analystRating` scalar, so a rating-only App A row was dropped. Fixed: derive a score from the label
  (`scoreFromAnalystLabel`) and write `analystBySource`.
- **P2 caching** — reads now use the shared 6h enrichment cache
  (`readEnrichmentCache`/`writeEnrichmentCache`, prefix `congress.trade`); hits short-circuit before HTTP.
- **P2 stale rows** — freshness guard `CONGRESS_TRADE_MAX_STALE_DAYS` (default 21): an App A row is used
  only if `updatedAt`/`date` is within the window, else it falls through to fresh paid providers.

## Deeper saving — opt-in short-circuit (NEW)
Implemented the actual paid-call elimination, opt-in: `ENRICHMENT_SHORT_CIRCUIT_ENABLED` (+
`CONGRESS_TRADE_READS_ENABLED`). The cascade now runs the **free** providers first, then **skips the paid
fundamentals providers' fetch for any symbol App A FULLY covered**. Price still comes from the free tier
(Alpaca/Yahoo) and App A's row carries the rest, so covered symbols lose nothing. Paid providers are tagged
`costTier: "paid"`; the merge stays in registration order so field precedence is identical. **Default OFF**
→ existing behavior unchanged, +3 tests cover the covered/partial/off paths. Also: App A misses are now
**negative-cached** for 1h so uncovered symbols aren't re-fetched every scan (Codex P2).

## Codex review round 2 (PR #160, commit fcf7db9)
- **P2 invalid App A numerics (line 425)** — App A stores `0`/negative as a "no value" sentinel for P/E and
  52-week high/low. The mapping now drops them (`peRatio > 0`, `week52High/Low > 0`) so a sentinel never
  overrides a real paid-provider value. Other scalars (eps, beta, etc.) keep the plain null check.
- **P2 too-weak coverage criterion (line 607)** — the short-circuit `covered` predicate required only
  `peRatio` + `eps`, so a symbol with a partial App A row would skip the paid tier and silently lose
  `beta`/`fcfYield`/`debtToEquity`/`epsGrowth`/analyst. Strengthened to require the **full** set those paid
  providers supply (the six fundamentals + `analystRating` or `targetMean`) before excluding a symbol;
  partial rows fall through to paid. Docs (`congress-trade-consume.md` §1b + config table) updated to match.

## Codex review round 3 (PR #160, commit 87cefe3) — short-circuit correctness rework
Two more P2s, both valid and related (App A's enrichment derives from the *same* upstream providers):
- **P2 lost fields (line 627)** — the whole-provider skip dropped fields the bundled paid providers
  *also* supply but App A never does: Finnhub/Alpha-Vantage **news+sentiment**, FMP **insider/senate**,
  Intrinio/Tiingo/TwelveData **quote** fields. "Nothing is lost" was false. **Reworked**: no whole
  provider is skipped anymore. The cascade now passes paid providers an `EnrichmentContext`
  (`coveredFields[symbol]` = the set of fields App A filled); a provider skips only the redundant
  **sub-calls**. Implemented for **FMP** — when App A has P/E it skips `ratios-ttm`, when App A has analyst
  it skips `grades-consensus`, but always fetches `insider-trading`/`senate-trading`. Providers that ignore
  the hint are unchanged. Real call savings, zero field loss.
- **P2 double-counted analyst (line 455)** — when App A's analyst row originated from FMP/Finnhub/Yahoo,
  keying it under `congress.trade` made the cascade blend the *same* consensus as two independent votes,
  skewing `analystScore`. **Fixed**: key App A's `analystBySource` entry under its upstream `source`
  (e.g. `fmp`) when present, so `Object.assign` dedupes it against the direct provider when that provider
  also runs; fall back to `congress.trade` only when the source is unknown.
- Tests reworked to assert the new sub-call behavior (paid provider always runs, receives the hint,
  preserves its unique insider/senate fields for covered symbols). Docs: `congress-trade-consume.md` §1b +
  config table. tsc clean, data-providers 51/51.

## Codex review round 4 (PR #160, commit 2567078) — short-circuit edge cases
Three more P2s on the round-3 mechanism, all valid:
- **P2 stale backfills (`rowIsFresh`, line 384)** — the guard used `updatedAt || date`, so a row
  *backfilled today* (fresh `updatedAt`) but carrying months-old market data (old `date`) passed and could
  override current paid data. **Fixed**: judge freshness by the market-data `date` first (fall back to
  `updatedAt` only when `date` is absent), so old backfilled-only rows correctly fall through.
- **P2 analyst source in the hint (line 630)** — the coverage hint recorded only that `analystRating`
  existed, so FMP skipped `grades-consensus` even when App A's analyst came from Yahoo/Finnhub — dropping
  FMP's *distinct* vote from the blend. **Fixed**: `EnrichmentContext` now carries `analystSource` per
  symbol (App A keys its analyst entry under the upstream provider). FMP skips its consensus sub-call only
  when `analystSource === "fmp"`; otherwise it still fetches and blends its own vote. (P/E stays a
  source-agnostic skip — it's first-wins, so App A's valid P/E wins regardless.)
- **P2 partial FMP cache (line 1618)** — a coverage-trimmed FMP fetch produced a partial row that was
  still written to the normal `fmp` cache, so a later scan with App A off/stale (or the flag off) would
  serve it as a full hit and never refetch P/E/analyst until TTL. **Fixed**: a trimmed fetch is no longer
  cached; covered fields come from App A live each scan, and FMP refetches its uniques.
- Tests: the FMP mock now faithfully models source-aware skipping; added a case proving FMP's own
  consensus is still fetched + blended when App A's analyst is a different source. data-providers 52/52.

Earlier non-outdated threads (cache App A reads, negative-cache empty misses, P1 roadmap docs) were
already addressed in rounds 1–2 — verified against current code, no further change.

## Codex review round 5 (PR #160, commit f66f77f) — App A read robustness + more sub-call skips
Four more valid P2s (the stale-thread duplicates for already-fixed items were verified, no change):
- **Transport errors negative-cached (line 497)** — `getAppAFundamentals`/`getAppAAnalyst` collapse a
  timeout/5xx/401 into `[]`, which the empty-result branch was negative-caching for 1h, suppressing retry
  until TTL even after the outage cleared. **Fixed**: track a `transportError` flag; only negative-cache a
  genuine "both reads OK, nothing fresh" — errors stay uncached and retry next scan.
- **Only the last App A row read (line 438)** — App A can return multiple fresh rows from different
  sources; taking just the last fundamentals/analyst row discarded fields an earlier fresh row supplied.
  **Fixed**: merge the latest non-null value per field across all fresh rows (`latestFund`/`latestAnalyst`);
  the rating/counts/source stay a coherent unit (taken from the latest row that yields a score).
- **FMP price-target call not skipped (line 1640)** — added `skipTargets` (only when App A covers all four
  target fields, since a partial App A target row must still let FMP fill the rest); folded into the
  no-cache-on-trim guard.
- **Contributor double-credit (line 477)** — the cascade credited `congress.trade` as a contributor when it
  saw App A's `analystBySource`, even if a same-source direct provider later overwrote that key, so
  `MarketScan.source` could list it with no surviving field. **Fixed**: track the last writer per analyst
  key and credit only the providers whose entry survived the blend. +2 cascade tests.

**Flag split (owner chose to split, 2026-06-25):** the fundamentals/analyst tier now has its OWN flag
`CONGRESS_TRADE_FUNDAMENTALS_ENABLED` (default off), independent of `CONGRESS_TRADE_READS_ENABLED` (price
reads). New `congressFundamentalsEnabled()` gates `getAppAFundamentals`/`getAppAAnalyst`, the
`CongressTradeEnrichmentProvider` registration, and the short-circuit. So enabling price cache-aside no
longer silently gives App A precedence over the direct fundamentals providers. `.env.example` +
`congress-trade-consume.md` (§1b heading + config table) updated. Owner set the new flag on in
agentic-trading Infisical prod.

## Codex review round 6 (PR #160, commit 5cd2cbb)
- **TTL (line 520)** — positive App A hits used the hard-coded 6h `DEFAULT_TTL_MS`; now use the shared
  `ttlMs()` (`NEWS_CACHE_TTL_MS`) like the other enrichment providers, so lowering/disabling that TTL forces
  fresher App A reads. (Negative misses keep their deliberate short 1h TTL.)
- **Read window (line 437)** — the App A reads omitted `from`, downloading full history only for `rowIsFresh`
  to discard most of it; now pass `from = today − CONGRESS_TRADE_MAX_STALE_DAYS` to both endpoints.
- **FMP target-skip caching (line 1798)** — `skipTargets` marked a row `trimmed` (uncached) even when
  `FMP_PRICE_TARGETS_ENABLED` was off and no target call would have happened, so FMP repeated all calls every
  scan; now a skipped target only counts as trimmed when targets were actually going to be fetched.

## Codex review round 7 (PR #160, commit 57e4fed)
Three new valid P2s (the rest of the batch were duplicate/outdated threads for items fixed in rounds 4–6):
- **Non-positive App A targets (line 485)** — App A can carry a `0`/negative price-target sentinel; the
  direct FMP parser keeps only positives, and under the short-circuit a covered target also makes FMP skip
  its target call, so a bad App A target could win first-wins and surface as a $0 target. **Fixed**: added a
  positive-value guard to the `latestAnalyst` target picks (mirrors the P/E / 52-week guards).
- **Paid providers serialized behind unrelated free tiers (line 670)** — the short-circuit awaited ALL free
  providers (Yahoo/Alpaca/Webull/Robinhood/SEC) before any paid provider started, even though only the
  `congress.trade` result feeds the hint. **Fixed**: await ONLY the Congress.Trade tier first, then run every
  other provider (free AND paid) in parallel — paid providers are no longer blocked on unrelated free tiers,
  restoring scan latency. Registration-order reassembly + merge precedence unchanged.
- **Stale PLAN.md flag (line 77)** — the roadmap still said the tier is gated by `CONGRESS_TRADE_READS_ENABLED`;
  updated to `CONGRESS_TRADE_FUNDAMENTALS_ENABLED` (+ `NEWS_CACHE_TTL_MS` caching).

## Codex review round 9 (PR #160, commit a603d08)
Four more valid P2s — two were real bugs introduced by the round 5–7 changes:
- **Cache hit bypassed the coverage hint (FMP)** — the hint only gated the fetch path, so an FMP cache
  HIT returned its cached `analystBySource.fmp` and (last-writer-wins) overwrote App A's fresher fmp-keyed
  analyst. **Fixed**: extracted `skipFlagsFor()` shared by both paths; on a cache hit, when App A covers
  FMP's own consensus, the cached FMP analyst fields are stripped so App A's survive.
- **Partial App A hit cached as complete** — when one endpoint had fresh data and the other none (analyst
  push lagging fundamentals), the partial row was cached at the full TTL, hiding the late half for hours.
  **Fixed**: a partial hit (fundamentals XOR analyst present) is cached at the short negative TTL; only a
  both-halves row gets the full TTL.
- **Donated aggregate double-counted** — App A's donated `analyst[]` rows carry no per-provider source, so
  they key under `congress.trade`; with the short-circuit off, the direct providers also blend the same
  upstream consensus. **Fixed**: the cascade drops a `congress.trade` aggregate vote when granular
  per-source votes exist (keeps it only as the lone signal). +2 tests.
- **STATUS.md handoff flag** — the opening current-state line still said `CONGRESS_TRADE_READS_ENABLED`;
  updated to the separate `CONGRESS_TRADE_FUNDAMENTALS_ENABLED`.

## Codex review round 10 (PR #160, commit cd73f8a)
- **Partial-TTL based on contributed fields** — round 9's partial check used row *existence*
  (`freshFunds.length` vs `freshAnalysts.length`), but a fresh row can carry only invalid/empty values
  (all-non-positive numerics, or an analyst row with no rating/counts/targets) and still be cached as
  "complete" at the full TTL, hiding a usable row pushed minutes later. **Fixed**: compute `partial` from
  whether each field group actually *contributed* a value to `e` (FUND_KEYS / ANALYST_KEYS), not row count.

## Codex review round 11 (PR #160, commit 434441f) — two bugs in the round 9–10 caching fixes
- **Partial App A hit cached despite a transport error** — the positive-cache branch ran before the
  `!transportError` guard (which only protected the empty branch), so if one endpoint returned data and the
  other ERRORED, the surviving half was cached, suppressing retry of the failed side for the whole TTL.
  **Fixed**: the result is still returned for the scan, but it's only *cached* when neither read failed.
- **Stripped FMP cache hit returned as `{}`** — round 9 strips a cached FMP entry's redundant consensus when
  App A covers it; if that entry was analyst-only, stripping left `{}` which was returned as a hit, so FMP's
  unique fields (insider/senate, enabled targets) never refetched until the cache expired. **Fixed**: when
  stripping leaves nothing useful, fall through to `misses` so FMP refetches its unique fields.

## Codex review round 12 (PR #160, commit [codex-autofix]) — two remaining non-outdated findings
- **Future-dated App A rows accepted as fresh** — `rowIsFresh` only checked the *upper* stale bound
  (`now - t <= maxStale`), so a row dated AFTER the scan (clock skew / bad import / accidental future
  as-of date) had a negative age that sailed through and could win the first-wins cascade ahead of
  current providers. **Fixed**: reject `age < -FUTURE_SKEW_MS` (2-day skew so a date-only stamp from a
  timezone ahead of UTC, parsed as UTC midnight, isn't mistaken for the future).
- **Covered FMP cache leftovers returned as a hit** — when the short-circuit strips a cached FMP entry's
  redundant consensus, a remaining field like `peRatio` that App A ALSO covers makes the entry effectively
  empty (App A's first-wins `peRatio` wins), yet `Object.keys(rest).length > 0` treated it as a usable hit
  and FMP's unique fields (insider/senate, enabled targets) were never refetched until TTL. **Fixed**: a
  leftover field counts as useful only when App A's `coveredFields` does NOT also cover it; otherwise fall
  through to `misses` so the fetch path runs.
- The other non-outdated Codex threads this round (rowIsFresh date-first preference, `!transportError`
  negative-cache guard, analyst de-dupe crediting, donated-aggregate `congress.trade` drop, and the
  `CONGRESS_TRADE_FUNDAMENTALS_ENABLED` doc sync in PLAN.md / STATUS.md / `docs/congress-trade-consume.md`)
  were already implemented by earlier rounds; verified against current code and resolved.

## Follow-ups
- Enabling in prod: `CONGRESS_TRADE_READS_ENABLED=on` (price/history cache-aside) **and**
  `CONGRESS_TRADE_FUNDAMENTALS_ENABLED=on` (the fundamentals/analyst tier — gated SEPARATELY since the
  flag split), optionally `ENRICHMENT_SHORT_CIRCUIT_ENABLED=on` (coverage-hint sub-call skips; needs the
  fundamentals flag), plus the B→A push flags (`CONGRESS_SHARE_ENABLED` + `CONGRESS_TRADE_TOKEN`) so App
  A's tables fill — owner/infra action. **All of these are now set on in the agentic-trading Infisical
  prod project (2026-06-25).**
- The A→B nightly-push **receiver route already exists** (`app/api/admin/securities/import/route.ts`).
  Wiring done 2026-06-25: `APP_B_IMPORT_URL` + `APP_B_INGEST_TOKEN` set on App A (Congress.Trade Worker
  secrets). App B still needs the **same `APP_B_INGEST_TOKEN`** + `SECURITIES_IMPORT_HISTORY_TIER_ENABLED`.
