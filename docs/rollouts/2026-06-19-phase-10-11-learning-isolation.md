# 2026-06-19 - Phase 10/11 learning isolation

## Summary

- Scoped strategy run locks, active-user discovery, paper projections, learning
  scorecards, tax/wash-sale reads, notification audits, dashboard proposal
  callbacks, post-mortem reflections, and prompt cache keys by `userId`.
- Added factor-bucket realized outcome learning and recent skipped-candidate
  counterfactual summaries from existing `signal_snapshot` evidence.
- Fed capped `factorOutcomes` and high-return `skippedCounterfactuals` into the
  Bull prompt, and removed the stateless portfolio/positions prompt omission.
- Added focused tests for user-isolated paper projections, signal efficacy,
  factor scorecards, skipped counterfactuals, per-user run locks, and per-user
  notification events.

## Why

- Phase 11 needs the default-user path to exercise real isolation before adding
  identity/auth. Phase 10 also needed the already-persisted skipped-candidate
  evidence to become actionable learning input instead of inert audit data.

## Files

- `src/lib/dashboard.ts`
- `src/lib/db.ts`
- `src/lib/learning-loop.ts`
- `src/lib/notifications.ts`
- `src/lib/performance.ts`
- `src/lib/post-mortem.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/strategy.ts`
- `src/lib/tax.ts`
- `test/performance.test.ts`
- `test/persistence-notification.test.ts`
- `PLAN.md`
- `STATUS.md`
- `docs/phase-10-signals-learning-ui-v2.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-19-phase-10-11-learning-isolation.md`

## Verification

- `npx tsc --noEmit` - passed.
- `npm test` - passed, 210 tests across 28 files.
- `npm run build` - passed.
- Restarted `npm run dev` after the build and verified `http://localhost:3000`
  returns `200 OK`.

## Follow-ups

- Materialize skipped-name counterfactuals over mature holding windows using
  OHLC bars and watermarks rather than only current-scan prices.
- Add a learning-matrix UI and decide how factor-bucket results should safely
  influence future scoring-weight tuning.
- Finish request-level user resolution across API routes before exposing
  non-local users.
