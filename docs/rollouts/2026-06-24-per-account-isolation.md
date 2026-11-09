# 2026-06-24 — Per-account state isolation (PR 1 of 3) — IN PROGRESS

Branch: `claude/per-account-isolation`. Design: `docs/design/per-account-isolation.md`.

## Summary (what's done so far)
Staged PR 1 of the three follow-ons after #122 (safety) and #124 (dead-field
cleanup). Goal: each connected account runs its own isolated state instead of all
of a user's accounts sharing one. Owner decision: **full isolation**, except
shareable-type (fact-tier) learning stays user-wide; `strategy_profiles` becomes a
copyable named **library** and each account has its own **live** state.

Landed on the branch so far (each verified green):
1. **Schema foundation** (`db.ts migrate()`): new `account_strategy_state` table
   (per-account live policy + `system_state`, keyed by `connected_accounts.id`,
   PK `(user_id, connected_account_id)`, no hard FK — deletion handled in code).
   Nullable `connected_account_id` columns + indexes added to `strategy_runs`,
   `skipped_candidate_counterfactuals`, `counterfactual_learning_watermarks`,
   `audit_events`, `notification_events`.
2. **Core policy + system-state isolation** (`db-profiles.ts`):
   `getPolicy(userId, connectedAccountId?)` reads the account's live row (seeded
   lazily from the user-level base on first touch — byte-identical day one);
   `setPolicy`/`setStrategyPrompt`/`create|update|activateStrategyProfile` all
   mirror into the active account's live row so it never goes stale. Activating a
   library strategy copies it into the active account's live state.
   `test/per-account-policy-isolation.test.ts` proves independent policy +
   per-account `systemState` + broker-derived `paperMode`.
3. **Run-state / run-lock per account** (`db-execution.ts`, `strategy.ts`):
   `acquireStrategyLock`/`releaseStrategyLock`/`insertStrategyRun`/
   `getLastStrategyRunStartedAt` gained an optional `connectedAccountId`
   (back-compat: legacy user-wide key when omitted; no-account release clears ALL
   the user's locks for teardown). `runStrategyOnce` and the manual-approval path
   key the lock + run record by the active account's id, so one account's run no
   longer blocks another and runs are attributed per account. Tests added for
   per-account lock concurrency + per-account cadence clock.

## Why
See `docs/design/per-account-isolation.md` §1–3. The library-vs-live split makes
PR 2 (shared strategy library + copy-to-account) a natural follow-on.

## Files (so far)
- `src/lib/db.ts` — schema (new table + tag columns).
- `src/lib/db-profiles.ts` — account-aware getPolicy/setPolicy/getStrategyPrompt/
  setStrategyPrompt + `account_strategy_state` helpers + write-through mirrors.
- `test/per-account-policy-isolation.test.ts` — new.
- `docs/design/per-account-isolation.md`, `STATUS.md`, this note.

## Verification (run)
- `npx tsc --noEmit` — clean.
- `npm test` — 1064/1065 (+3 new; only the pre-existing `cache-provenance` date flake).
- `npm run build` — green.

## All slices COMPLETE (2026-06-24)
All five slices below are implemented + verified (tsc clean; 1075/1076 — only the
unrelated `cache-provenance` macro-cache timing flake; build green):

4. **Audit / notification account tagging** (`db.ts` `audit()`, `db-notifications.ts`,
   `notifications.ts`, `db-learning.ts`): `audit()` + `insertNotificationEvent` take an
   optional `connectedAccountId`; the `signal_snapshot`, `proposal_rejected`, and
   notification writes thread the active/target account. `listSignalSnapshotAuditAfter`
   gained an account filter (rowid is globally monotonic so per-account watermarks
   advance independently). Done before learning, since the counterfactual loop reads
   `audit_events`.
5. **Performance-derived learning per account** (`db-learning.ts`,
   `counterfactual-learning.ts`, `performance.ts`, `strategy-tuning.ts`,
   `strategy.ts`): skipped-candidate counterfactuals are tagged + read per account;
   the tuner + dashboard readouts filter by the active account. `counterfactual_learning_watermarks`
   is now keyed `(user_id, connected_account_id)` via a one-time PK-rebuild migration
   (account-agnostic row uses `''` sentinel, never NULL, so composite-PK upsert is
   well-defined). Maturation loop stays user-wide (self-dedupes via recheck guard;
   matured rows keep their tag). Fact-tier `learned_context` stays user-wide (owner rule).
6. **Scheduler multi-account iteration** (`scheduler.ts`, `strategy.ts`,
   `db-api-keys.ts`, `db-profiles.ts`): `runStrategyOnce(userId, { connectedAccountId })`
   override runs the whole loop against a target account (tuning is NOT invoked in the
   run path, so the override is self-contained around the `policy` object). Scheduler
   schedule state keyed `(userId, accountId)`; per-account cadence rehydrate; iterates
   each user's connected accounts and runs each whose own `systemState === "active"`.
   SAFETY GUARD: a freshly-seeded non-active account seeds `systemState: "halted"`
   (never inherits `"active"` from the base policy) so the multi-account scheduler can't
   silently start trading a dormant account; the boot interlock now reconciles every
   account too. Added `getConnectedAccount(id, userId)`.
7. **Deletion purge** (`db-api-keys.ts` `deleteConnectedAccount`, `account-deletion.ts`):
   deleting a connected account purges its `account_strategy_state`, `strategy_runs`,
   `skipped_candidate_counterfactuals`, watermark, `audit_events`, `notification_events`
   (by `connected_account_id`) + its run lock. Full-user deletion list gained
   `account_strategy_state` and now clears all per-account run locks (prefix LIKE).

## Verification
- `npx tsc --noEmit` clean.
- `npm test`: 1075/1076 (sole failure = pre-existing `cache-provenance` macro-cache
  timing flake, unrelated — confirmed it touches no isolation code).
- `npm run build` green.
- New tests in `test/per-account-policy-isolation.test.ts`: policy/system-state/paperMode
  isolation, run-lock per account, cadence clock per account, watermark isolation,
  matured-counterfactual per-account read, non-active-account-never-auto-arms safety
  guard, deletion purge.

## Follow-ups / notes
- In-memory `accountSchedules` keeps a stale entry after an account is deleted until the
  next process restart — harmless (the account is gone so it's never iterated).
- Multi-account autonomy is opt-in per account by design; arming a second account
  requires explicitly setting its `systemState` to `"active"`.

## Follow-ups / risks
- Dual keying scheme (new state on `connected_account_id`; legacy execution tables on
  `account_number`) is deliberate for now; documented in the design doc §2.
- Separate from this PR: the session's hidden-limits audit (Voyage ingest cadence,
  scan enrichment top-30, Alpaca stream symbol drop) — surfaced to owner, not fixed.
</content>
