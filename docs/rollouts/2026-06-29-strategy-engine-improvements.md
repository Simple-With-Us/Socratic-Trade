# 2026-06-29 — strategy-engine-improvements

## Summary
Three strategy-engine improvements implemented in the main integration worktree via Cursor:
1. Bear (Red Team) now receives structured market data alongside the Bull's prose — including technical indicators, factor breakdowns, smart-money signals, and macro context — with explicit instructions to fact-check price claims.
2. Market holiday / early-close calendar prevents strategy runs on full-closure days (NYSE holidays, weekends) with an audit trail.
3. "Do nothing" threshold (`minProposalScoreThreshold`) drops sub-threshold candidates before the LLM sees them, and skips the LLM call entirely when no candidate clears the bar.

## Why
- The Bear debate was an echo chamber — it could only read the Bull's narrative prose without the structured data to independently verify price claims, factor scores, or signal readings.
- The system would attempt to trade on Christmas, New Year's, and other market-closed days because no holiday awareness existed.
- When every candidate was mediocre (e.g., all below a 30/100 scan score), the LLM still generated proposals — "sit on your hands" was not an option.

## Files
- `src/lib/strategy.ts` — Added `technicalScore`, `technicalDirection`, `technicalSignals` to `compactCandidateForPrompt`. Enhanced Bear system prompt with explicit structured-data verification instructions. Added market-closed guard (`isTradingDay()`) at top of `runStrategyOnce` with audit event. Added `minProposalScoreThreshold` filtering before LLM call with empty-candidate skip path.
- `src/lib/market-calendar.ts` (NEW) — US market holiday / early-close calendar. Exports `isMarketOpen()`, `isTradingDay()`, `nextMarketOpen()`, `getEarlyCloseDays()`. Covers 2025–2027 NYSE holidays plus early-close days (day before Independence Day, Black Friday, Christmas Eve).
- `src/lib/types.ts` — Added `minProposalScoreThreshold` (0–100) to `TuningSettings` interface, default 0 (no filtering).
- `app/dashboard-client.tsx` — Added `Min proposal score threshold` number field (0–100) in Settings → Tuning section with explanatory description.

## Verification
- `npx tsc --noEmit` — clean
- `npm test` — 156 files / 1508 tests passed
- `npx eslint` on changed files — warnings only (pre-existing), no errors

## Follow-ups
- The holiday calendar currently only guards the strategy run; the scheduler/timer that triggers runs should also respect `nextMarketOpen()` to avoid waking up every N minutes on a holiday just to hit the guard.
- `isMarketOpen()` could be wired into the Robinhood live-trade path as an additional pre-execution gate (defense in depth).
- `market-calendar.ts` uses `getGoodFriday` and other helpers from `market-hours.ts` — consider consolidating the holiday computation into one module in a future cleanup.
