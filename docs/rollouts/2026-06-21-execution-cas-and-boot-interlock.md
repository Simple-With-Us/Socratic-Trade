# 2026-06-21 — Execution-section CAS + synthetic-stop re-entrancy + boot-time autonomy interlock

## Summary

Two of the four "deep fix" findings from the 2026-06-21 failure-mode review
(`docs/reviews/2026-06-20-failure-mode-brainstorm.md`). The other two had already
landed on `main` via other agents and are intentionally **not** re-implemented
here (see "Already on main" below).

1. **Execution-section atomicity (review Top #4/#5).** Replaced the non-atomic
   "is it still pending?" re-checks with DB-level compare-and-swap claims so two
   concurrent actors can never both place the same order.
2. **Boot-time autonomy interlock (review Top #3).** A persisted
   `systemState === "active"` no longer silently resumes order placement after an
   unattended restart / crash-loop / DB restore.

## Why

- **#4 (proposal double-execution):** `executeProposal` placed the broker order
  after a plain `status === 'proposed'` read with `await` points in between, and
  `updateProposalStatus` had no status guard. Two concurrent approvals
  (double-click, two tabs, the from-draft flow, or a scheduled run racing a
  manual approve) could both pass the read and both call `placeEquityOrder`,
  doubling a real position. The manual-approve path is not covered by the
  per-user strategy lock, so a lock alone wouldn't close it — an atomic DB claim
  does, regardless of how the callers race.
- **#5 (synthetic-stop re-entrancy):** the monitor is fire-and-forget every 60s
  with no in-flight guard; the active-stop read and the post-order status flip
  were not atomic, so a slow broker call spanning the next tick let the next
  run re-fire the same protective exit. The per-call `crypto.randomUUID()` refId
  also defeated the broker's own client-order-id dedupe.
- **#3 (boot resume):** the scheduler auto-starts on every boot and gated
  autonomy solely on a copyable DB value, so restoring/copying a DB that last
  said "active" resumed unattended live execution with no human in the loop.

## Changes

- `src/lib/db.ts`
  - `claimProposalForExecution(id, toStatus, userId, opts)` — atomic CAS:
    `UPDATE … SET status=? … WHERE id=? AND user_id=? AND status='proposed'`;
    returns `true` only for the winner (better-sqlite3 is synchronous + atomic).
  - `claimSyntheticStop(id, userId)` — atomic `active -> triggered` CAS;
    `revertSyntheticStopClaim(id, userId)` — re-arm on failed placement.
- `src/lib/strategy.ts` — `executeProposal` now claims the proposal via
  `claimProposalForExecution` at BOTH commit points (paper `proposed -> paper`,
  live `proposed -> placing`) before recording a fill / calling the broker; the
  loser returns the already-claimed status.
- `src/lib/synthetic-stops.ts` — claim the stop before placing; skip (and audit)
  if already claimed by a concurrent run; deterministic `refId`
  (`sstop-<id>-<triggerPrice*100>`) for broker dedupe; revert the claim on a
  failed/uncertain placement so a later tick can retry.
- `src/lib/scheduler.ts`
  - Per-user in-flight guard (`globalThis`-pinned) around the synthetic-stop
    monitor so overlapping ticks can't run two monitors for the same user.
  - `reconcileAutonomyOnBoot()` (run once in `startScheduler`): unless
    `AUTONOMY_RESUME_ON_BOOT=1`, revert every user left `active` back to `halted`
    on boot (audited `autonomy_halted_on_boot`). `close_only`/`liquidating` are
    left untouched.
- `test/deep-safety-fixes.test.ts` — 8 regression tests (claim wins-once /
  refuses-non-proposed / user-scoped; stop claim wins-once + revert re-arms;
  boot interlock reverts active→halted, honors the env opt-in, and leaves
  close_only alone).

## Already on `main` (other two deep fixes — not re-done here)

- **Auth layer (Top #1):** `middleware.ts` establishes a trusted identity
  (Cloudflare Access header / dev fallback), strips the spoofable `x-user-id`
  (closes the IDOR), and fails closed in production.
- **Portfolio circuit breaker (Top #7):** `recordAndEvaluateDrawdownBreaker`
  (`src/lib/risk-breaker.ts`) trips `systemState -> close_only` on drawdown /
  daily-loss and fires a `kill_switch` notification; wired in `runStrategyOnce`.

## Verification

Isolated worktree off `origin/main` (`842c2a6`), `node_modules` hardlinked:

- `npx tsc --noEmit` — clean
- `npm test` — all pass (incl. 8 new)
- `npm run build` — green

## Follow-ups / notes

- `AUTONOMY_RESUME_ON_BOOT=1` must be set in the production environment if you
  want a planned restart to resume autonomy without a manual Start.
- The cross-order daily-notional race between a scheduled run and a manual
  approve (both reading pre-trade notional) is *narrowed* but not fully closed by
  the CAS (it guards the same proposal, not shared budget). A shared execution
  lock across run + approve would close it fully — deferred.
- `main` advances rapidly (multiple agents); rebase before merge if conflicts.
