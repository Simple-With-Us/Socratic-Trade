# 2026-08-10 — Drilldown: all sections collapsible, Sources starts closed + SPY-freshness fix

## Context & Objective

Three owner items in one message: (1) why does ST's "Congress.Trade" source label show up on
non-congressional data — investigated, answer below, no code change needed; (2) on the symbol
drilldown, make Sources collapsed by default and every other section open by default; (3) give
every section a top-right show/hide button like Congress.Trade's Trends page. While digging into
a related benchmark question ("why is SPY stale"), found and fixed a real bug: the imported-EOD
history tier had no freshness check and was silently winning the fetch cascade over live
providers with a 16+ day old batch.

## Item 1 — "Congress.Trade" source label (investigation only, no fix)

Not circular sourcing and not a mislabeling bug in the strict sense. `MarketScan.source`
(`src/lib/market.ts`) is a single `+`-joined string that mixes two different concepts:
per-field data-provider attribution, and `overlaySources` — categories that influenced a stock's
*ranking score*. `"congress"`/`"congress.trade"` is added to `overlaySources` whenever a
congressional-trading signal contributed to a stock's score (`market.ts:494-518`) — legitimate,
since congressional disclosures genuinely are Congress.Trade's system of record
(`CONGRESS_TRADE_AS_CONGRESS_SOURCE` default ON). The actual fundamentals-peer-read tier
(`CongressTradeEnrichmentProvider`, `data-providers.ts:786`) is real but opt-in and verified OFF
via env defaults in this environment. The per-field Sources drilldown table is correctly scoped
and never attributes a fundamentals field to Congress.Trade unless that tier is on.

The likely source of the "so many" perception: the blended scan-table tooltip
(`app/console/page.tsx:793-799`, `formatSourceList(scan.source)`) shows "Quote sources: ... 
Congress.Trade" on any stock where a congressional signal nudged the ranking — which reads as
"we fetched data from Congress.Trade" when it actually means "this stock's score includes a
congressional-trading signal." No code change made — this is a labeling clarity question, not a
correctness bug, and wasn't an explicit fix request. Flagging as a candidate follow-up: relabel
the overlay-contribution entries distinctly from provider-attribution entries in that tooltip.

## Item 2 & 3 — Drilldown sections: unified collapsible shell

`app/console/ui/drilldown-sections.tsx` had two shells: `Section` (plain, non-collapsible; used
by Exposure/SignalSummary/DerivedTiles/Factor/Analyst) and `Disclosure` (collapsible `<details>`,
used by Fundamentals/Evidence/Sources — all three defaulted to collapsed since no call site
passed `defaultOpen`, and none of the three had a visible show/hide cue at all).

Unified onto one `Disclosure` shell for all 8 sections:
- `defaultOpen` now defaults to `true`. `SourcesSection` is the only explicit
  `defaultOpen={false}`.
- Added a top-right show/hide cue matching the existing `Card` collapsible pattern in
  `primitives.tsx` (`.con-disclosure-label`, "EXPAND >" / "COLLAPSE ⌄" — the codebase's own
  established idiom, not a copy of Congress.Trade's raw CSS; same visual role as CT Trends'
  "SHOW ↓"/"HIDE ↑" text-cue-in-top-right pattern the owner referenced). Works at all
  breakpoints (unlike CT's Trends page, which forces sections open on desktop — the drilldown is
  a drawer, not a dense dashboard, and the owner asked for a show/hide button, not a
  desktop-locked one).
- Title text now consistently wrapped in `.con-card-title` (uppercase, letter-spaced) across all
  8 sections — the 3 former `Disclosure` sections never had this styling; unifying fixed the
  visual mismatch as a side effect.

## Item (found along the way) — SPY/imported-EOD freshness bug, real fix

`src/lib/history.ts`'s `fetchDailyOHLC` provider cascade checks `imported-eod` FIRST, ahead of
every live fetch (massive/roic/tradier/tiingo/marketstack/yahoo). `fetchImportedHistory` only
density-guarded (`SECURITIES_IMPORT_MIN_BARS`, default 200 bars) — it never checked recency. A
one-time gap-fill batch from Congress.Trade has no reason to ever be re-POSTed, so a dense-but-
stale batch permanently won the cascade over live providers below it. Observed: SPY closes stuck
at 2026-07-24 while the account window ran through 2026-08-10 (16+ days stale), correctly
triggering the existing "dead feed, not a flat market" honest-degradation message in
`benchmark.ts` — but the upstream cause (a stale source winning over live ones with zero
recency check) was a real bug.

Fixed: `fetchImportedHistory(symbol, now)` now applies the same `isBarSeriesFresh(bars, 3, now)`
guard the local SQLite cache tier already uses just above it in the same function — a stale
imported batch now returns `null` and falls through to the live providers, exactly as intended.

## Changes Made

- `app/console/ui/drilldown-sections.tsx` — unified `Section`+`Disclosure` into one collapsible
  shell with a show/hide cue; all 8 sections now collapsible; `SourcesSection` explicit
  `defaultOpen={false}`.
- `src/lib/history.ts` — `fetchImportedHistory` takes `now`, applies `isBarSeriesFresh` (3-day
  tolerance, matching the sibling local-cache tier); call site threads `now` through.
- `test/securities-import.test.ts` — updated 2 existing fixtures to use dates fresh relative to
  their test's `now` (they were previously incidentally stale by ~4 months, which would have
  broken under the new guard even though staleness wasn't what they were testing); added a new
  test proving a dense-but-stale import correctly falls through to `null` instead of serving.

## Decisions & Trade-offs

- Item 1: investigation only, no code change — the owner asked "why," not "fix it." Proposed the
  relabeling fix as a follow-up rather than shipping it unasked, since it touches a
  data-presentation/trust surface and deserves a deliberate look at the tooltip copy.
- Show/hide cue works at all breakpoints, deliberately diverging from CT Trends' mobile-only +
  forced-open-on-desktop behavior — the owner's ask was for the show/hide affordance itself, not
  CT's specific desktop-lock quirk, and the drilldown is a narrower drawer context where that
  quirk doesn't obviously apply.
- Freshness tolerance for `imported-eod` reuses the existing 3-day constant from the local-cache
  tier rather than introducing a new env knob — consistent with the sibling check right above it
  in the same function; can be split into its own configurable value later if 3 days proves wrong
  for a one-time-import use case specifically.

## Verification State

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (728 pre-existing grandfathered warnings, none new).
- `npx vitest run test/securities-import.test.ts test/benchmark.test.ts test/history.test.ts` —
  all passing (48 + 25 tests, plus the new staleness-guard test verified as part of the 48).
- No local dev server used per standing owner instruction (real-website-only); this change has
  NOT been visually verified in a running browser — only code-reviewed and gate-verified. Visual
  confirmation should happen against the real site post-deploy.
- Full `npm test`/`npm run build` deferred to the landing operator (`scripts/land.sh`).

## Next Steps & Blockers

- Post-deploy: confirm the drilldown drawer renders all 8 sections open except Sources, with a
  working top-right show/hide cue, on the real site.
- Post-deploy: confirm SPY (and any other imported-eod-tier symbol) picks up a live series if its
  imported batch is stale, instead of staying pinned to the last import.
- Candidate follow-up (not done here, owner didn't ask): relabel the overlay-contribution
  "Congress.Trade" entries distinctly from provider-attribution entries in the scan-table
  tooltip, since that blended string is the likely source of the "why so much Congress.Trade"
  perception.
