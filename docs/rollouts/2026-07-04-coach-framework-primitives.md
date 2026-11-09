# 2026-07-04 — Coach/framework primitives slice

## Summary

- Extended the decision-trace coaching POST path so a coach note can stay attached to the case while
  optionally promoting into a durable lesson or a linked framework proposal.
- Added explicit framework owner-verb persistence (`accept` / `rewrite` / `reject`) alongside
  `ownerResponse`, and wired the console framework review controls to send/display that data.
- Extended the decision-trace read route/UI to show linked strategy-run metadata when the case has a
  resolvable `runId`.
- 2026-07-05 merge-forward: replayed the branch on top of `origin/main` @ `0bfa4f1e`, tightened
  run metadata lookup to a direct DB read (no 200-run cap), and added route-level tests for coach
  promotion and framework rewrite validation.

## Why

This is the focused Codex slice for issue #473 from the coaching/framework backlog: close the dead-end
between trace coaching and the existing lesson/framework primitives, make the missing owner rewrite verb
real instead of implied, and surface run context where the backend already has it.

## Files

- `src/lib/types.ts`
- `src/lib/db.ts`
- `src/lib/db-execution.ts`
- `src/lib/db-socratic.ts`
- `app/api/socratic/decisions/[id]/route.ts`
- `app/api/socratic/decisions/[id]/coach/route.ts`
- `app/api/socratic/framework/[id]/route.ts`
- `app/console/decisions/[id]/page.tsx`
- `app/console/page.tsx`
- `test/socratic-db.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-04-coach-framework-primitives.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Verification

- `git fetch origin && git merge --no-edit origin/main` — initial merge blocked by local doc edits
  (`PLAN.md`, `STATUS.md`, `docs/EFFORT-LOG.md`); branch state stashed, merge-forwarded to
  `origin/main` @ `0bfa4f1e`, then replayed cleanly with no conflict markers.
- `npm ci` — passed; install completed in this worktree with the existing `allow-scripts` warnings.
- `npm test -- test/socratic-db.test.ts` — passed (1 file / 3 tests).
- `./node_modules/.bin/tsc --noEmit --pretty false` — passed.
- `./node_modules/.bin/eslint . --quiet` — passed with 0 errors.
- `npm test` — passed (256 files / 2507 tests).
- `npm run build` — passed; build output includes `/api/socratic/decisions/[id]`,
  `/api/socratic/decisions/[id]/coach`, `/api/socratic/framework/[id]`, `/console`, and
  `/console/decisions/[id]`.

## Follow-ups

- If the owner wants future-run "consumed this lesson" receipts rather than just linked source-run
  metadata, that needs a separate retrieval-usefulness / consumption-ledger slice; this branch only
  surfaces data already locally available.
- PR #810 is now open as READY and `gh pr merge --squash --auto` is armed; remaining work is
  waiting for GitHub `verify` to go green and land it.
