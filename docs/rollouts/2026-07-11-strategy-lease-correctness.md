# 2026-07-11 — Strategy lease ownership and scheduler default correctness

Branch: `codex/strategy-lease-correctness`

## Summary

- `executeProposal` now mints an invocation-unique owner token
  (`execute-<proposalId>-<uuid>`). Duplicate calls for one proposal no longer re-enter under the
  same owner or risk one invocation releasing the other's lease.
- New `strategy-lock-guard.ts` renews the five-minute account-scoped strategy lease every minute.
  A refused renewal or thrown DB error is caught inside the timer, recorded as sticky ownership
  loss, and never escapes as an uncaught interval error.
- Both the autonomous run loop and approval execution synchronously re-prove ownership at the final
  safe boundary before writing a `placing` intent and calling `placeEquityOrder`. The autonomous
  loop also checks at the start of each proposal and immediately after broker health, tradability,
  initial review, and bump re-review awaits. Non-placement blocked/proposed state is therefore not
  written by an invocation that lost ownership during broker I/O. Once ownership is lost, the
  invocation cannot continue into another broker placement.
- All post-acquire setup is inside the cleanup scope. If the strategy-run receipt insert throws,
  the heartbeat stops and the owner token is released instead of being renewed indefinitely.
- Approval ownership loss returns a typed `busy` result, leaves the proposal pending, and never calls
  the broker. An autonomous run that loses ownership after earlier proposal work preserves those
  completed proposal results in its failed receipt rather than returning an empty list.
- Approval setup, tradability, initial review, and bump re-review now each re-prove ownership before
  protective-reprice or non-placement status writes. Autonomous setup does the same before
  reconciliation phases, market scan/snapshot, volatility/budget policy writes, and proposal-loop
  persistence. A loss during a block notification cannot subsequently demote account authority.
- Removed obsolete teardown calls from account-deletion preparation and the usage-budget skip. They
  did not carry the actual owner token (and the skip already runs through the authoritative
  `finally` release).
- `SCHEDULER_SINGLE_LEADER` is default-on for unset, empty, and whitespace-only values. Explicit
  `false`, `off`, `0`, or `no` values still disable it for diagnostics; unrecognized values fail
  safe to enabled.
- The scheduler liveness heartbeat now runs only after a successful leader claim. A direct follower
  regression proves an idle process cannot keep `scheduler:lastTick` fresh while the leader is dead.
- Current-main reconciliation removed the obsolete `heartbeatTimer` cleanup accidentally carried by
  the newly merged broker-health early return; the guard's `finally` is the single stop/release owner.
- Final account-binding reconciliation snapshots the connected-account id before lease acquisition
  and uses it for every later policy/account read and write. An active-account switch during guard
  startup can no longer redirect the run or its failed receipt.
- Pending-proposal expiry/revalidation accept a run-owned assertion callback and stop between rows;
  RAG, episodic retrieval, Green generation, ATR/volatility history, Red review, correlation/risk
  receipts, decision observation, and final macro evidence all re-prove after their awaited work.
- Durable proposal truth wins over ancillary lease loss: non-placement results are recorded before
  notification assertions, and broker placement/reconciliation completes its status/fill/result
  boundary before checking ownership. Approval preserves a terminal block instead of returning busy.
- SIGTERM/SIGINT retain the scheduler leader lease until its TTL instead of releasing while detached
  protective-order work may be unresolved; only `beforeExit` releases after the event loop drains.
- Scheduled auto-tuning is skipped after failed runs, is bound to the scheduled account, and takes the
  same renewed account strategy lease plus an account-scoped LLM reservation before any tuning work.

## Why

The strategy lock already stored an owner and expiry, but approval used the deterministic owner
`execute-<proposalId>`. Two simultaneous approvals of the same card therefore looked like one
re-entrant owner; either caller could release the shared lease while the other still evaluated or
placed. Separately, the heartbeat ignored a `false` renew and let a thrown renew escape its interval,
so an invocation could continue toward the broker after it no longer owned the lease. An empty
single-leader env value also accidentally disabled scheduler coordination despite the intended
default-on posture.

## Files

- `src/lib/strategy-lock-guard.ts`
- `src/lib/strategy.ts`
- `src/lib/strategy-execution.ts`
- `src/lib/proposal-revalidation.ts`
- `src/lib/strategy-risk.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/auto-tune-scheduler.ts`
- `src/lib/backtest.ts`
- `src/lib/account-deletion.ts`
- `src/lib/scheduler.ts`
- `src/lib/scheduler-lease.ts`
- `test/strategy-lock-guard.test.ts`
- `test/strategy-lock-loss-integration.test.ts`
- `test/scheduler-single-leader-default.test.ts`
- `test/scheduler-leader-heartbeat.test.ts`
- `test/scheduler-followup-lease.test.ts`
- `test/auto-tune-scheduler-lease.test.ts`
- `test/backtest-account-scope.test.ts`
- `test/proposal-revalidation.test.ts`
- `test/correlation-cluster-gate.test.ts`
- `test/risk-receipts.test.ts`
- `.env.example`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/ops-observability-security.md`
- `docs/improvement-program-2026-06-26.md`
- `docs/settings-navigation-redesign/appendix-B-capability-inventory.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-26-scheduler-lease.md`
- `docs/rollouts/2026-07-11-strategy-lease-correctness.md`
- `package-lock.json` (reverts an unrelated autofix normalization; no dependency change)

## Verification

- `npm ci --no-audit --no-fund` — installed the locked 767-package dependency set in the isolated
  worktree. It initially ran under the host's Node 26.
- First Node 24 focused run failed only because `better-sqlite3` had been installed for Node 26
  (`NODE_MODULE_VERSION 147` vs required `137`).
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm rebuild better-sqlite3` — rebuilt the native module
  for the repo's Node 24 runtime.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/strategy-lock-guard.test.ts test/scheduler-single-leader-default.test.ts test/approval-lock.test.ts test/account-deletion.test.ts test/account-delete-cleanup.test.ts test/usage-budget-strategy-integration.test.ts`
  — **6 files / 34 tests passed**.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint src/lib/strategy-lock-guard.ts src/lib/strategy.ts src/lib/strategy-execution.ts src/lib/account-deletion.ts src/lib/scheduler.ts src/lib/scheduler-lease.ts test/strategy-lock-guard.test.ts test/scheduler-single-leader-default.test.ts`
  — **0 errors / 35 pre-existing warnings** in the large split strategy modules.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — **clean**. It completed slowly while
  another isolated worktree was also typechecking; no diagnostic was emitted. This ran before the
  final parser tightening from truthy-list to explicit-false-list semantics; that final same-type
  expression was covered by the 11-case scheduler test and scoped ESLint, while the parent owns the
  serialized final-tree gate.
- Final current-tree rerun of the six focused files — **6 files / 34 tests passed**. A scoped rerun
  of `test/scheduler-single-leader-default.test.ts` was **11/11**, and ESLint on the parser/test was
  **0 errors / 1 inherited scheduler warning**.
- Adversarial-review regression slice:
  `test/strategy-lock-guard.test.ts`, `test/strategy-lock-loss-integration.test.ts`,
  `test/scheduler-single-leader-default.test.ts`, and `test/approval-lock.test.ts` — **4 files /
  22 tests passed**. It forces the initial run insert to throw and proves lock reacquisition, and
  forces approval ownership loss immediately before placement and proves typed busy/pending/no broker
  call behavior.
- Post-review `npx tsc --noEmit` — **clean**. Scoped ESLint across touched runtime/test files —
  **0 errors / 35 inherited warnings**. `git diff --check` — **clean**.
- Current `origin/main@e395e65a` merged cleanly. Final ordered Node 24 gate:
  focused **7 files / 36 tests**, `npm run lint` **0 errors / 404 inherited warnings**,
  `npx tsc --noEmit` clean, `npm test` **334 files / 3,764 tests**, and `npm run build` green.
- The first production build caught an import trace from `strategy-lock-guard.ts` through
  `node:crypto`, which webpack does not handle in the client-reachable scheduler graph. The UUID
  helper now uses `globalThis.crypto.randomUUID()` and adds no client bundle dependency. After that
  fix, focused **3 files / 11 tests**, TypeScript, scoped ESLint, the full **3,764-test** suite, and
  the production build all reran green.
- Review autofix `9d2ba1fb` was pushed by `github-actions[bot]`; gitleaks, hosted verify, and smoke
  correctly refused that untrusted actor. No CI trust policy was changed. A human-authored follow-up
  merged current `origin/main`; trusted runtime/test reconciliation commit `b19650ac` owns the
  corrected code. A later human merge brought the branch through `main@7c01f87e` (Alpha health lane)
  without runtime conflicts.
- The first scoped rerun used the shell's Node 26 and failed only on the expected native SQLite ABI
  mismatch (`NODE_MODULE_VERSION 147` vs the worktree's 137 build). The committed source was not
  implicated. `npm ci --no-audit --no-fund` under Node 24 refreshed the exact locked shared-v1.5
  dependency after current-main reconciliation.
- Before that refresh, `npx tsc --noEmit` found only the stale installed shared-v1.4 exports; after
  the locked install, TypeScript completed cleanly.
- `PATH=/opt/homebrew/Cellar/node@24/24.18.0/bin:$PATH npx vitest run test/strategy-lock-guard.test.ts test/strategy-lock-loss-integration.test.ts test/scheduler-single-leader-default.test.ts test/scheduler-leader-heartbeat.test.ts`
  — **4 files / 21 tests passed**.
- Touched ESLint on `strategy.ts`, `scheduler.ts`, and the four lease/scheduler regression files —
  **0 errors / 33 inherited warnings**. `npx tsc --noEmit` — **clean**. `git diff --check` — **clean**.
- The first trusted human rerun at `ed3793e3` completed hosted Security, Playwright smoke, and full
  verify (lint, TypeScript, full tests, production build) green. A second Codex review then found the
  approval/setup gaps above; autofix `3bfd3122` again arrived from `github-actions[bot]` and was
  adversarially tightened rather than trusted as-is. Its unrelated `fsevents` lockfile flag was
  removed so the final dependency graph stays byte-identical to current main.
- Current second-review Node24 slice:
  `test/strategy-lock-guard.test.ts`, `test/strategy-lock-loss-integration.test.ts`,
  `test/scheduler-single-leader-default.test.ts`, `test/scheduler-leader-heartbeat.test.ts`,
  `test/approval-lock.test.ts`, `test/broker-minimum-bump-execute.test.ts`, and
  `test/protective-exit-reprice.test.ts` — **7 files / 38 tests passed**. Touched ESLint — **0 errors /
  34 inherited warnings**. `npx tsc --noEmit` — **clean**. `git diff --check` — **clean**.
- Final adversarial reconciliation on merged `origin/main@67e1536d`:
  `test/proposal-revalidation.test.ts`, `test/strategy-lock-loss-integration.test.ts`,
  `test/scheduler-followup-lease.test.ts`, `test/auto-tune-scheduler-lease.test.ts`,
  `test/scheduler-leader-heartbeat.test.ts`, `test/scheduler-single-leader-default.test.ts`,
  `test/correlation-cluster-gate.test.ts`, and `test/risk-receipts.test.ts` — **8 files / 59 tests
  passed** under Node 24. This directly covers active-account switching after the account snapshot,
  loss between proposal-maintenance rows, loss after Red/correlation awaits, durable proposed/blocked
  notification outcomes, final-macro loss after a successful placement, signal-shutdown fencing,
  failed-run tuning suppression, scheduled-account propagation, and tuner lease contention.
- Compatibility slice: `test/strategy-tuning.test.ts`, `test/learning-loop-backlog.test.ts`,
  `test/learning-loop-followon.test.ts`, `test/learning-loop-autotuning-db.test.ts`, and
  `test/backtest.test.ts` — **5 files / 116 tests passed** under Node 24.
- A final independent reviewer found four missed boundaries and each was corrected before the full
  gate: `getStrategyPrompt` now receives the snapshotted account; `runWalkForwardOOS` propagates its
  account into factor-observation reads; a lost `transitionProposalIfPending` race returns the current
  persisted proposal status without a false block notification; and scheduler follow-up time is read
  only after the strategy run completes. The post-fix combined Node 24 rerun covered **11 files / 129
  tests**, including the new `test/backtest-account-scope.test.ts`, and passed.
- Final touched ESLint — **0 errors / 36 inherited warnings**. Three `npx tsc --noEmit` checks
  completed cleanly during implementation. A final core rerun after docs/current-main refresh passed
  **4 files / 25 tests**; `git diff --check` is clean. The implementation worker deferred the full
  Vitest suite and production build to the root lane's serialized gate below.
- Root serialized final gate under Node 24 after the post-review commit: `npm run lint` passed;
  `npx tsc --noEmit` passed; `npm test` passed **341 files / 3,801 tests**; and `npm run build` passed
  with only the inherited Next middleware deprecation, Edge/Sentry trace, and webpack cache warnings.

## Follow-ups and boundaries

- Draft PR #1429 remains open. The root lane intentionally converted it from ready while this final
  reconciliation was in flight and owns the trusted push, hosted checks, readiness, merge, and
  production verification; the final local full gate now includes every review fix.
- No scheduler provider-boundary locking, production environment/configuration, PR, merge,
  deployment, or live runtime mutation is part of this change. The branch-neutral live effort board
  was updated with implementation and review receipts.
- Current-main reconciliation is complete. The final full ordered gate and hosted rerun remain after
  the second review reconciliation; production verification remains contingent on the ready PR
  landing through the normal auto-deploy path.
- The bot's docs-only follow-up `3f4c53fc` incorrectly claimed one pre-tradability assertion covered
  all later awaits and that auto-merge should remain enabled. Human reconciliation corrected the
  code/docs, disabled auto-merge, and keeps the PR open pending the serialized final gate.
