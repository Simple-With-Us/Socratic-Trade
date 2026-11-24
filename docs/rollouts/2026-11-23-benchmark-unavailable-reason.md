# 2026-11-23: vs SPY card names its reason; ops snapshot carries it

## Context & Objective
Jay reported the Tradier sandbox account showing "Benchmark unavailable right now" on iOS Home. The card hid which of five server reasons applied, and no remote read could see the reason. Goal: show the real reason and make it readable remotely. Nothing is estimated.

## Changes Made
- iOS card words one sentence per server reason (same meaning as the web Results page) and prints the server's detail line.
- `snapshot-timing-unknown` is now audited as `benchmark_unavailable` (it was the one feed-independent reason with no audit row).
- `/api/ops/snapshot` recent audit includes `benchmark_unavailable` with `reason · detail`.
- Files: `ios/SocraticTrade/MobileModels.swift`, `ios/SocraticTrade/HomeView.swift`, `ios/SocraticTradeTests/MobileModelsTests.swift`, `src/lib/dashboard.ts`, `src/lib/ops-snapshot.ts`, `test/ops-benchmark-unavailable.test.ts`.

## Decisions & Trade-offs
- No new route: the existing token-gated snapshot already carries recent audit rows, so one kind was added to its allowlist.
- The audit stays rate-limited by the existing advisory window.

## Verification State
- `npx tsc --noEmit`: no errors in touched files.
- Vitest and iOS tests run in CI (the local install here lacks the built shared package).

## Next Steps & Blockers
- After deploy, read the `benchmark_unavailable` row for the Tradier Sandbox account from `/api/ops/snapshot` and fix the named cause.

## Zero-Code Findings
None.
