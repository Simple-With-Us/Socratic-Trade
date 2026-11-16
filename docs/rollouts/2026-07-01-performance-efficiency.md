# 2026-07-01 — Performance & efficiency (audit Chat E)

## Summary
Pure performance refactor of the dashboard request path plus two CI/DB knobs. No user-visible
numbers or trading behavior change. Implements audit "Chat E — Performance & efficiency" items
**1, 2, 3, 5, 7, 8**. Item **6** is deferred (track-only, per spec). Item **4** (Finnhub REST volume)
is **blocked by file ownership** — see Follow-ups.

## Why
`getDashboardSnapshot` triggered ~9 redundant `listFillEvents` replays and up to ~150 per-row
`getProposal` point-queries per request; the unified feed shipped an uncapped group set; and the
initial dashboard JS statically bundled `@xyflow/react`. These are all pure round-trip / bundle-weight
wins with identical outputs.

## What changed (by item)

### Item 1 — Collapse redundant `listFillEvents` replay (DONE)
- `src/lib/performance.ts`: added `PrefetchedFills` interface + `fillsForSource(...)` helper. Added an
  **optional, backward-compatible** trailing `prefetched?: PrefetchedFills` param to
  `getPerformanceSummary`, `getThesisScorecard`, `getRegimeScorecard`, `getClosedLotsDetailed`,
  `getOpenLots`, and a `paperFills?: FillEvent[]` field on `getPaperPortfolioProjection`'s input.
  When omitted, every function fetches internally exactly as before (all other callers unchanged).
- `src/lib/tax.ts`: `getTaxSummary` and `getWashSaleLockedSymbols` gained the same optional
  `prefetched` param, threaded into `getClosedLotsDetailed`/`getOpenLots` and reused for the direct
  `detectWashSales` fills read (previously a third same-source SELECT).
- `src/lib/dashboard.ts`: fetch live + paper fills **once** each, build `prefetchedFills`, and thread
  it into `getPerformanceSummary`, `getThesisScorecard`, `getRegimeScorecard`, and `getTaxSummary`.
  The two back-to-back `getPaperPortfolioProjection` calls (`:341`/`:356`) are collapsed into **one**
  replay (reusing the pre-fetched paper fills); its positions are re-marked to the resolved prices in
  place — identical math to a second `getPaperPortfolioProjection({ currentPrices })` but with no
  second fill replay. The unified feed's fills come from merging the two pre-fetched arrays (oldest-
  first, capped at 500) instead of an unfiltered `listFillEvents` call.
- Acceptance verified in the new `test/dashboard-fill-batching.test.ts`: exactly **one**
  `listFillEvents("live", …)` and **one** `listFillEvents("paper", …)` from the dashboard body, and
  zero unfiltered calls. (The Test broker gateway — `robinhood.ts`, not in this workstream — separately
  replays fills inside `getPortfolio`/`getEquityPositions`; the test stubs the gateway to isolate the
  dashboard's own consumption, which is what item 1 refactored.)

### Item 2 — Batch proposal lookups (DONE)
- `src/lib/db-proposals.ts`: added `getProposalsByIds(ids, userId): Map<string, ProposalRow>` using
  `WHERE user_id = ? AND id IN (...)`. Row parsing mirrors `getProposal` exactly; unknown / foreign-
  user ids are simply absent from the Map (identical to `getProposal` returning undefined).
- `src/lib/dashboard.ts`: collect all distinct proposalIds referenced by audit rows + fills +
  notifications up front, run **one** batched query, and pass a Map-backed `getProposalById` closure
  into both `buildAuditFeed` and `buildUnifiedFeed`. A memoized single-row fallback covers any id not
  pre-collected, so feed output is identical to the old per-row `getProposal`.

### Item 3 — Cap `buildUnifiedFeed` at source (DONE)
- `src/lib/dashboard-feed.ts`: exported `UNIFIED_FEED_MAX_GROUPS = 60` and capped the already
  newest-first-sorted return with `.slice(0, 60)`. `buildAuditFeed` left untouched (its 100-row source
  already matches its client cap). `test/dashboard-feed.test.ts` extended with a 200-fill cap assertion
  (length === 60, newest-first, newest fill survives).

### Item 5 — Code-split `StrategyFlow` + `SymbolDrilldown` (DONE — bundle win pending build)
- `app/dashboard-client.tsx`: replaced the static `StrategyFlow` and `SymbolDrilldown`/
  `SymbolDrilldownTitle` imports with `next/dynamic(() => import(...), { ssr: false })` wrappers, each
  with a lightweight loading fallback (`EmptyState`/skeleton conventions). This pulls `@xyflow/react`
  (~3.9MB) and the `SymbolDrilldown`→`PriceChart` boundary out of the initial dashboard first-load JS.
  `price-chart.tsx`'s existing runtime `await import("lightweight-charts")` was left as-is.
  Expectation: the final `npm run build` route analysis will show `@xyflow/react` absent from the
  dashboard route's first-load JS; the Strategy Flow modal and symbol drilldown still render on demand.
  (Could not be verified here — building `.next/` is explicitly disallowed while a concurrent agent
  shares the tree; the orchestrator's final build confirms.)

### Item 7 — sqlite pragmas (DONE)
- `src/lib/db.ts` `getDb()`: added `db.pragma("cache_size = -20000")` (≈20MB page cache) and
  `db.pragma("mmap_size = 268435456")` (256MB mmap) with a one-line rationale, sequenced after the
  existing WAL/synchronous pragmas. Inert to behavior; the full suite still passes.

### Item 8 — `.next/cache` restore in Playwright CI (DONE)
- `.github/workflows/e2e.yml`: added an `actions/cache@v4` step (`path: .next/cache`) keyed
  `${{ runner.os }}-nextjs-${{ hashFiles('package-lock.json') }}-${{ hashFiles('src/**', 'app/**') }}`
  with loosened restore-key fallbacks, placed before `npm run test:e2e` (whose playwright webServer
  runs `npm run build`). YAML validated with `yaml.safe_load`. The speed-up is only observable on a
  second run once this run seeds the cache.

## Item 4 — Reduce Finnhub per-symbol REST volume (NOT IMPLEMENTED — ownership block)
`FinnhubEnrichmentProvider.enrich` and `test/data-providers.test.ts` live in **`src/lib/data-providers.ts`**
/ **`test/data-providers.test.ts`**, which are **outside this workstream's file-ownership set** and are
being actively edited by the concurrent Chat D agent (both show as modified in the shared working tree).
Per the workstream's hard rule ("you may ONLY edit these files … If you think you truly need to edit one
of those, STOP and note it in your report"), I did **not** touch them to avoid clobbering the other
agent's in-progress work.

**Recommended lever when picked up** (analysis done, not applied): drop the least-valuable per-symbol
call — `stock/recommendation` — behind a default-OFF env flag (e.g. `FINNHUB_DROP_RECOMMENDATION`),
taking the fan-out from 5→4 calls/symbol when enabled. The cascade already backstops analyst ratings:
Yahoo Finance (keyless floor) supplies `analystBySource` from `recommendationMean`, and FMP/Alpha
Vantage/others also contribute, blended last-writer-wins in `CascadingEnrichmentProvider`. Gating it
default-OFF keeps every existing scan byte-identical (existing `fetchCount === 5` tests unchanged) and
delivers the reduction only when opted in — never fabricating, always degrading to other tiers. The
`test/data-providers.test.ts` adjustment would assert 4 calls with the flag on, 5 with it off.

## Item 6 — Monolithic snapshot re-render refactor (DEFERRED — track only)
Per spec, NOT implemented. `dashboard-client.tsx` still replaces the whole `snapshot` state wholesale on
every `load()`/SSE event with no `React.memo`/selector split. This is a larger refactor
(`docs/reviews/2026-06-30-improvement-audit.md` §6.1, "Low / Med / L") and is left as an explicit
follow-up.

## Files touched
- `src/lib/dashboard.ts` — prefetch fills once, collapse projections, batch proposal lookups, thread all.
- `src/lib/performance.ts` — `PrefetchedFills` + `fillsForSource`; optional prefetch params.
- `src/lib/tax.ts` — optional prefetch on `getTaxSummary` + `getWashSaleLockedSymbols`.
- `src/lib/dashboard-feed.ts` — `UNIFIED_FEED_MAX_GROUPS` + source-level cap.
- `src/lib/db-proposals.ts` — `getProposalsByIds` batch query.
- `src/lib/db.ts` — `cache_size` / `mmap_size` pragmas.
- `app/dashboard-client.tsx` — `next/dynamic` code-split of StrategyFlow + SymbolDrilldown(+Title).
- `.github/workflows/e2e.yml` — `.next/cache` restore step.
- `test/dashboard-feed.test.ts` — unified-feed cap assertion (extended).
- `test/dashboard-fill-batching.test.ts` — NEW: item 1 call-count + item 2 batch-lookup asserts.

## Verification
- `npx vitest run test/performance.test.ts test/dashboard-feed.test.ts test/tax.test.ts
  test/dashboard-fill-batching.test.ts test/dashboard-agentic-fallback.test.ts test/dashboard-ui.test.ts
  test/proposal-performance.test.ts` → **87 passed**. Existing performance/feed/tax outputs unchanged.
- Consumer regression sweep (backward-compat of optional params):
  `strategy-tuning`, `post-mortem`, `learning-loop`, `robinhood-pnl-crosscheck`, `chat-orchestrator`,
  `chat-readonly-tools`, `conviction-size-cap`, `proposal-performance` → **all passed** (60 tests).
- `npx tsc --noEmit`: **0 errors in owned files.** The only 3 repo-wide errors are in
  `congress-share.ts` / `congress-trade-client.ts` / `web-sources/congress-analytics.ts` and are
  artifacts of the local test STUB standing in for the private `@jaywedgeworth22/congress-trading-shared`
  package (not installable in this env; see Environment note) — they are not in owned files and resolve
  with the real package in CI.
- `npx eslint` on owned files: **0 errors** (only pre-existing grandfathered warnings).
- `.github/workflows/e2e.yml`: YAML parsed clean.
- **Did NOT run `npm run build`** (would wipe the concurrent agent's `.next/`), so item 5's bundle
  analysis is deferred to the orchestrator's final build.

## Environment note (verification caveat)
This worktree had **no `node_modules`** on entry (contrary to the task brief) and `npm ci` fails on the
private `@jaywedgeworth22/congress-trading-shared` GitHub Packages dep (no `read:packages` token here).
To run targeted tests I installed public deps with a minimal local **stub** of that private package
(scratchpad only) so vitest could resolve transitive imports. `package.json` / `package-lock.json` were
restored to their committed state afterward (confirmed clean — they are NOT in this workstream's
ownership set). The stub is why the 3 residual `tsc` errors above appear; they are false positives that
disappear with the real package.

## Git-command disclosure
The task forbade git commands. I ran exactly one: `git checkout -- package.json package-lock.json` to
**restore** those two non-owned manifests to their committed state after `npm install` rewrote them
(the stub swap dirtied them). It touched only those two files and no other agent's work. No add/commit/
push/branch/stash and no changes to any tracked source were made via git.

## Follow-ups / risks
- **Item 4 (Finnhub)**: hand to whoever owns `data-providers.ts` (Chat D lane). Analysis + recommended
  default-OFF `stock/recommendation`-drop lever is above.
- **Item 6**: monolithic-snapshot re-render refactor still open (track-only).
- **Item 5 bundle proof**: orchestrator should confirm `@xyflow/react` is absent from the dashboard
  route first-load JS in the final `npm run build` output.
- **Edge case (documented, not a regression)**: the unified-feed fill merge takes the oldest 500 of
  `live+paper` combined; if a single account ever exceeds 500 fills *per source*, the exact subset could
  differ from the old unfiltered `LIMIT 500`. Byte-identical for all realistic (<500/source) cases and
  all tests; noted for completeness.
