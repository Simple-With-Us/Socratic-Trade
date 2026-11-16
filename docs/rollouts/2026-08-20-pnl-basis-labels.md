# 2026-08-20 — `pnl-basis-labels`: every performance number says what it measures

## Context & Objective
Tranche-1 cluster from the 2026-08-18 review (issues #2914, #2943).  Performance tiles printed numbers without the basis or window they were computed on: "Unrealized P&L" meant different things on Results, Home and iOS; win rate rendered a confident `0%` for an account that had never closed a trade; "Versus the market" covered a window the label never stated.  For a trader judging whether the desk works, a number whose basis is unstated is worse than no number.

## Changes Made
- `src/lib/performance.ts`, `src/lib/benchmark.ts`, `src/lib/types.ts` — performance and benchmark results now carry the basis and window they were computed on, rather than leaving the consumer to guess.
- `app/console/lib/derive.ts` — mark-to-market derivation reports a gross cost basis so a book containing shorts is summed on `|basis|` instead of netting long against short.
- `app/console/page.tsx`, `app/console/results/page.tsx` — tiles state their basis/window; an empty sample reads as no-data rather than a confident `0%`.
- `ios/SocraticTrade/MobileModels.swift`, `ios/SocraticTrade/ResultsView.swift` — the phone shows the same basis/window as the web, so the two surfaces stop disagreeing about what "Unrealized P&L" means.
- Tests: `test/console-live-data-derive.test.ts`, `test/performance-prefetched-pnl.test.ts`, `ios/SocraticTradeTests/AccountMetricsTests.swift`.

## Decisions & Trade-offs
- `deriveMarkToMarket`'s `costBasis` **changed meaning** — net-signed to gross (`|basis|`-summed).  For an all-long book gross and net are identical, so existing behavior and tests are unaffected; the change only matters once a short is open, which is exactly the case it was getting wrong.  The one consumer (`app/console/page.tsx`) was grep-confirmed by the reviewer.
- Where a number is genuinely unavailable the UI shows `-`; where it is a computed no-ratio it shows `n/a`.  These are not interchangeable and the distinction is preserved.

## Verification State
- `npm run lint` 0 errors (769 pre-existing warnings) · `npx tsc --noEmit` clean · `npm test` **7140 passed** / 51 skipped, 0 failures · `npm run build` exit 0.
- `xcodebuild build -scheme SocraticTrade -destination 'generic/platform=iOS'` — **exit 0**.  (`xcodebuild test` still cannot run: `main`'s own test target does not compile — see `docs/rollouts/2026-08-20-web-ios-contract-drift.md`.)
- An independent skeptic read the real diff and returned SOUND_WITH_NITS, confirming the math and honesty fixes by source-reading rather than trusting the report.

## Scope Honesty — what this does NOT close
- `perf-17` is **not** addressed: the SPY benchmark is total-return or price-return depending on which history provider answered, and an intraday tip is misaligned against an EOD close (`src/lib/history.ts`).  The implementer read the provider cascade and confirmed the finding rather than papering over it; fixing it means normalising adjustment semantics across providers, which is its own change.
- Reviewer follow-up, outside this cluster: `src/lib/chat/orchestrator.ts` still feeds raw `liveWinRate`/`paperWinRate` into the coach's tool context with no sample count, so the model can still tell the owner "your win rate is 0%" for an account that has never closed a trade.

## Next Steps
- Close `perf-17` by normalising benchmark adjustment semantics and aligning the intraday-vs-EOD comparison point.
- Thread the sample count into the coach's performance tool context.
