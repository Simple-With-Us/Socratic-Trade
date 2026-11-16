# 2026-07-08 - Live bulk approval typed-confirm flow

Branch: `codex/live-bulk-typed-confirm` (worktree `/Users/jay/.codex/worktrees/socratic-live-bulk-typed-confirm`).

## Summary

- Extended `/console/approvals` bulk approval to include selected LIVE proposals.
- LIVE bulk approval opens one aggregate typed-confirm sheet only when `policy.requireTypedConfirmation` is enabled.
- When typed confirmation is disabled, selected LIVE proposals approve with the same one-click bulk action as paper proposals.
- Bulk reject remains the existing inline one-click confirm path; no typed phrase was added there.
- Bulk approve now submits to `/api/proposals/bulk-approve`; the route computes selected live membership server-side, validates the one aggregate phrase, then executes each row through the normal `executeProposal` path so placed, blocked, and failed results stay row-honest.
- PR review follow-up capped bulk approvals at 20 approvals, reports non-placed/non-blocked approve results as failed rows with reasons, keeps the per-proposal live-confirm contract symbol-specific, and stabilizes the sheet close handler so typing does not reset focus.

## Why

#807 intentionally left LIVE proposals out of bulk approve. MONET confirmed the owner constraints before implementation:
bulk reject must stay one-click, LIVE bulk approve may ask for one aggregate typed phrase only when the owner-adjustable
`policy.requireTypedConfirmation` setting is on, and the implementation must not invent a new broker execution path.
The PR review correctly required server-authoritative batch membership for the aggregate phrase, so the final shape is a
thin batch route over the existing `executeProposal` path.

## Files

- `app/console/approvals/page.tsx`
- `app/console/approvals/triage.ts`
- `app/api/proposals/bulk-approve/route.ts`
- `app/console/lib/api.ts`
- `src/lib/strategy.ts`
- `test/approvals-triage-model.test.ts`
- `test/order-confirmation-status.test.ts`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-07-08-live-bulk-typed-confirm.md`

## Verification

```bash
git diff --check
node --check app/console/approvals/triage.ts
./node_modules/.bin/vitest run test/approvals-triage-model.test.ts
npm run lint
npx tsc --noEmit
npm test -- --reporter=dot --maxWorkers=2
npm run build
npx vitest run test/approvals-triage-model.test.ts test/order-confirmation-status.test.ts
npx tsc --noEmit
npm run lint -- --quiet
npm test -- --reporter=dot --maxWorkers=2
npm run build
```

Passed:

- `git diff --check`
- `node --check app/console/approvals/triage.ts`
- Focused triage test: 1 file / 2 tests
- `npm run lint`: 0 errors, 353 grandfathered warnings
- `npx tsc --noEmit`: clean
- Full Vitest: 301 files / 3101 tests (low workers to avoid local resource SIGTERM)
- `npm run build`: passed with only the existing Sentry Edge-runtime warning
- Review-fix focused tests: 2 files / 8 tests
- Review-fix `npx tsc --noEmit`: clean
- Review-fix `npm run lint -- --quiet`: clean
- Post-merge-forward full Vitest: 302 files / 3112 tests
- Post-merge-forward `npm run build`: clean

## Follow-ups

- PR #1174 review threads were resolved, CI passed, and the PR merged to `main` as `8bc0967f`.
- Production deployment is recorded in `docs/rollouts/2026-07-09-codex-lanes-prod-release.md`.
