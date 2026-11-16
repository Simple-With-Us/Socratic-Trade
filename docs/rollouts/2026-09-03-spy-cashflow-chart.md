# 2026-09-03 — Cash-flow-matched S&P overlay (account vs same deposits in SPY)

## Context & Objective

The vs-S&P number already lived on Results (web) and Home / Results / Insights (iOS) as
time-weighted % tiles.  The overlay graph of account dollars versus an S&P tracker funded
with the same deposits and withdrawals was never drawn — `equityIndex` / `benchmarkIndex`
were computed and unused.  Owner asked where the comparison lives and for that dollar
chart, with every addition/withdrawal as a breakpoint and daily cutoff math.

## Changes Made

- Same-cash S&P **dollar shadow**: start with the first snapshot's equity; each later day
  grow that book with that sub-period's SPY return, then apply the verified flow at the
  daily cutoff.  `dollarExcess` = ending account equity − ending shadow.
- TWR % tiles unchanged (manager skill, cash neutralized).
- Benchmark curve now uses **one last snapshot per calendar day** (cap 2500 days) so early
  deposits are not dropped by the newest-100 snapshot window.
- Web: overlay chart + "Same cash in SPY" / "You vs that" dollars on Results, and a
  Versus SPY card on Home that links to Results.
- iOS: same dollars + overlay on Home Performance and Results.  Insights label uses
  `benchmarkSymbol` instead of a hardcoded "SPY".

### Files

- `src/lib/types.ts` — `BenchmarkDollarPoint`; shadow series + `dollarExcess` on comparison
- `src/lib/benchmark.ts` — same-cash shadow next to TWR indexes
- `src/lib/db-fills.ts` — `listDailyPortfolioSnapshots`
- `src/lib/dashboard.ts` — daily curve for the SPY comparison
- `app/console/components/benchmark-chart.tsx` — two-line dollar SVG
- `app/console/results/page.tsx` — dollars + chart on Versus the Market
- `app/console/page.tsx` — Home Versus SPY card
- `ios/SocraticTrade/MobileModels.swift` — optional series decode (old payloads still load)
- `ios/SocraticTrade/AppComponents.swift` — `BenchmarkCompareChart`
- `ios/SocraticTrade/HomeView.swift`, `ResultsView.swift`, `InsightsView.swift`
- `test/benchmark.test.ts`, `test/daily-portfolio-snapshots.test.ts`
- `ios/SocraticTradeTests/MobileModelsTests.swift`

## Decisions & Trade-offs

- Keep TWR % (skill) and add dollar shadow (what you would have had).  They answer
  different questions when capital size changes a lot.
- Flow at daily cutoff after that day's SPY return — same-day deposits do not earn that
  day's S&P move.  Owner allowed daily (not hourly) cutoff for the math.
- Unverified inferred transfers stay excluded from both TWR and the shadow (issue #2557).
- Comparison-account picker on Results still does not compute SPY (no live quotes / SPY
  fetch on that endpoint).  Active account uses the dashboard path.

## Verification State

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/benchmark.test.ts test/daily-portfolio-snapshots.test.ts
```

## Next Steps & Blockers

- After merge, refresh Home and Results on a live account with at least one deposit.
- iOS overlay ships with the next TestFlight; web is Coolify auto-deploy after merge.
- Optional leftover: wire `computeSpyBenchmark` into `/api/connected-accounts/[id]/performance`.
