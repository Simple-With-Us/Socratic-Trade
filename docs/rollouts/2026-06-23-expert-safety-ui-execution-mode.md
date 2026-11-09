# 2026-06-23 - expert safety UI execution mode

## Summary

- Implemented the expert-panel plan's highest-risk slices in the Codex worktree:
  bracket-dollar fail-closed guards, close-only protective maintenance,
  execution-mode persistence, broker-paper accounting fixes, typed live approval
  confirmation, readiness UI, consent fail-closed behavior, Litestream command
  repair, and vector credential lookup hardening.
- Replaced the unsafe "hide mode banner" preference with a compact banner
  preference; the Test/Paper/Brokerage mode cue remains visible.

## Why

- Antigravity and follow-up expert reviews identified real money-path risks:
  bracket dollar orders could derive unsafe whole-share quantities without a
  price anchor, protective exits could be suppressed outside fully active mode,
  broker-paper records were being collapsed into live/Test heuristics, and live
  approvals were not server-confirmed.
- UI review identified that hiding the execution banner made Brokerage mode too
  easy to miss, and that setup/readiness needed an actionable surface.

## Files

- `.env.example`
- `app/api/proposals/[id]/approve/route.ts`
- `app/api/proposals/from-draft/route.ts`
- `app/api/ready/route.ts`
- `app/api/strategy/pause/route.ts`
- `app/dashboard-client.tsx`
- `app/dashboard-types.ts`
- `app/ui/primitives.tsx`
- `package.json`
- `src/lib/alpaca.ts`
- `src/lib/dashboard.ts`
- `src/lib/db-execution.ts`
- `src/lib/db-fills.ts`
- `src/lib/db-proposals.ts`
- `src/lib/db.ts`
- `src/lib/execution-mode.ts`
- `src/lib/performance.ts`
- `src/lib/policy.ts`
- `src/lib/post-mortem.ts`
- `src/lib/scheduler.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/strategy.ts`
- `src/lib/synthetic-stops.ts`
- `src/lib/types.ts`
- `src/lib/vector-db.ts`
- `test/alpaca-brackets.test.ts`
- `test/daily-notional-reset.test.ts`
- `test/execution-mode-persistence.test.ts`
- `test/execution-mode.test.ts`
- `test/policy.test.ts`
- `test/post-mortem.test.ts`
- `test/reconciliation-risk.test.ts`
- `test/strategy-tuning.test.ts`
- `test/synthetic-stops.test.ts`
- `test/vector-db.test.ts`

## Verification

- `npx tsc --noEmit`
- `npx vitest run test/execution-mode.test.ts test/execution-mode-persistence.test.ts test/reconciliation-risk.test.ts test/policy.test.ts test/alpaca-brackets.test.ts test/daily-notional-reset.test.ts test/synthetic-stops.test.ts`
- `npm test`
- `npm run build`
- `PLAYWRIGHT_PORT=4217 npm run test:e2e -- --project=chromium`

## Follow-ups

- Replace the current live-approval `window.prompt` with an in-app typed
  confirmation modal that shows account, mode, symbol, notional, and stale-state
  warnings.
- Implement true candidate-vs-baseline OOS validation for proposed scoring
  weights; the current IC/OOS harness still does not evaluate the actual
  candidate weight vector.
- Finish detailed strategy RAG provenance, provider diagnostics, LLM daily
  budget preflight gates, and mock-enrichment production guards.
- Add broader Playwright coverage for mobile touch targets, keyboard provenance
  flows, and the consent failure modal.
