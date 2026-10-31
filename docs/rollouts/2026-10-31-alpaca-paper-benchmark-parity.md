# Alpaca Paper vs-S&P parity + RAG Sentry flood guard

## Context & Objective

The iOS Home tab showed the performance-vs-S&P card for the Tradier Sandbox account but not for Alpaca Paper.  Sentry issue SOCRATIC-TRADE-2R showed the Alpaca Paper account failing every strategy run (32 events, last 2026-10-30).

## Root cause

The app computes the comparison itself in `computeSpyBenchmarkDetailed` (`src/lib/benchmark.ts`), but its only equity input was local `portfolio_snapshots`.  Those rows are written only by strategy runs (`recordPortfolioSnapshot` in `src/lib/strategy.ts`).  The failing Alpaca Paper runs left fewer than two local snapshot days, so the benchmark returned `insufficient-history`.  The dashboard then left `performance.benchmark` unset and set no explanation for that reason, and iOS rendered nothing (`if let benchmark` in `HomeView.swift`).  Tradier Sandbox had healthy runs, snapshots, and therefore the card.

## Changes Made

- `src/lib/dashboard.ts` — when the local curve has fewer than two distinct days and the active broker is Alpaca, fall back to Alpaca's own daily equity history (`fetchAlpacaDailyEquityHistory`, deadline-guarded by the snapshot budget, two-year window).  Also surface `insufficient-history` / `insufficient-overlap` as `benchmarkUnavailable` instead of silence.
- `src/lib/benchmark.ts` — accept `brokerHistory` points as real equity in the anti-fabrication filter.  Broker EOD equity has no cash/positions split, so flow detection relies on the broker transfer ledger and recorded fills, never an invented cash balance.
- `src/lib/types.ts` — `EquityCurvePoint.brokerHistory` flag; `benchmarkUnavailable` comment updated.
- `app/console/results/page.tsx` — honest copy for the insufficient-history reasons.
- `ios/SocraticTrade/MobileModels.swift` — decode `benchmarkUnavailable`.
- `ios/SocraticTrade/HomeView.swift` — show a short "vs SPY" explanation card instead of a silent blank when no comparison exists.
- `src/lib/vector-db.ts` — 15-minute per-(message, lane) Sentry cooldown in `captureRagSentryMessage`.  A dead embed/vector provider failed every retrieval and minted an event each time (SOCRATIC-TRADE-2G at 507 events, SOCRATIC-TRADE-1X at 162).  The first failure still reports immediately; repeats are logged locally only.
- `test/benchmark.test.ts` — regression test: broker-reported daily equity is a real curve, never `insufficient-history`.

## Decisions & Trade-offs

- The broker-history fallback runs only on the cold path (local curve under two days, Alpaca only), so healthy accounts pay no extra broker call.
- Tradier has no broker equity-history API, so Tradier accounts still rely on local snapshots.  That is now a visible "not enough history" state rather than a blank.
- The underlying Alpaca Paper run failures (SOCRATIC-TRADE-2R) are a production-data question (the failing runs' reasons live in the prod run ledger, not in this repo).  This change removes their user-visible symptom and names the state honestly; the run failures themselves still need a prod-side look.

## Verification State

- `npx tsc --noEmit` — no errors in any touched file (remaining errors are the private `@jaywedgeworth22/congress-trading-shared` package being unavailable in a fresh lane install; pre-existing).
- `./node_modules/.bin/vitest run test/benchmark.test.ts test/performance.test.ts test/dashboard-snapshot-projection.test.ts test/benchmark-feed-visibility.test.ts` — 85 passed.
- New regression test proven to fail with `src/lib/benchmark.ts` reverted and pass with the fix.
- ESLint on touched files — 0 errors.
- Swift was not compiled locally (repo rule: iOS compiles in CI `ios-build`).

## Next Steps & Blockers

- Watch `ios-build` and `verify` CI on the PR.
- Prod-side: read the Alpaca Paper failed-run summaries to find why every run fails (SOCRATIC-TRADE-2R).
