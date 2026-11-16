# 2026-07-09 — Red Team efficacy console wiring

Branch/worktree: `codex/red-team-efficacy-console` /
`/Users/jay/.codex/worktrees/socratic-red-team-efficacy-console`

## Summary

Wired the existing `getRedTeamEfficacy()` read model into the console's Results screen without
touching any write-side Red Team or strategy code.

- `src/lib/dashboard.ts` now adds `redTeamEfficacy` to the active-account dashboard snapshot and
  extends it with the override split from persisted audit history:
  `overrideVetoes`, `appliedOverrideVetoes`, `vetoDecisions`, and `overrideSharePct`.
- `app/dashboard-types.ts` now types that snapshot payload.
- `app/console/results/page.tsx` now renders a `Red Team veto efficacy` card on Results with:
  overall veto-decision / applied-override / resolved-veto stats,
  20/50 sample gating for reviewer-attribution rows (matching the #1115 style),
  and a recent resolved-veto table that labels missing persisted reviewer models as
  `unattributed` instead of fabricating attribution.
- `src/lib/performance.ts` now includes missing persisted reviewer models as the full-history
  `unattributed` `byModel` bucket, so the console does not mix full-history attributed rows with
  a recent-record-slice unattributed row.
- `app/console/lib/red-team-efficacy.ts` centralizes the UI-side sample gating and attribution
  label logic.
- Added a focused snapshot regression in `test/dashboard-fill-batching.test.ts` that seeds one
  blocking veto plus applied/refused override-path vetoes and asserts the snapshot payload.
- Added `test/red-team-efficacy-ui.test.ts` for the helper logic and the unattributed bucket.
- Added `test/performance.test.ts` coverage proving the `unattributed` rollup is computed from
  full history even when `records` is limited.

## Why

PR #365 landed the scorecard logic and explicitly deferred console wiring. PR #814 made the metric
trustworthy by keeping overridden vetoes out of the missed-opportunity denominator. This lane
finishes the read-side surface only, per MONET's scope correction: Results/snapshot/test/docs,
no `approvals/**`, no `approval-card.tsx`, no `src/lib/red-team.ts`, and no `src/lib/strategy.ts`.

## Files

- `app/console/results/page.tsx`
- `app/console/lib/red-team-efficacy.ts`
- `app/dashboard-types.ts`
- `src/lib/dashboard.ts`
- `src/lib/performance.ts`
- `test/dashboard-fill-batching.test.ts`
- `test/performance.test.ts`
- `test/red-team-efficacy-ui.test.ts`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-07-09-red-team-efficacy-console.md`

## Verification

```bash
npx vitest run test/red-team-efficacy-ui.test.ts test/dashboard-fill-batching.test.ts test/performance.test.ts
npx tsc --noEmit
npm run lint -- --quiet
```

Results:

- `vitest`: passed (`3` files, `43` tests)
- `tsc`: exited `0`
- `lint -- --quiet`: exited `0`

## Follow-ups

- The Results card uses the existing `records` slice from `getRedTeamEfficacy()` (`limit: 12` in
  the snapshot helper) only for the recent-veto table. If the owner wants a full paged history
  later, add a dedicated read route instead of bloating `/api/dashboard`.
- Reviewer-attribution metrics still rely only on persisted `redTeamVerdict.model`; history without
  that field stays visible as `unattributed`. No backfill or inference was added here.
- Override-vs-non-override is only available at the aggregate split level from
  `red_team_veto_overridden` + `socratic_override_applied` audits. If the owner later wants deeper
  persisted per-record override attribution or richer reviewer stamps, that should stay a
  single-adversary follow-up rather than a read-side reconstruction here.
