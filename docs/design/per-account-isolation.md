# Design: Per-account state isolation

Status: PR 1 IMPLEMENTED + DEPLOYED (#128); PR 2 (copy-to-account) IMPLEMENTED —
see `docs/rollouts/2026-06-24-per-account-isolation.md` +
`docs/rollouts/2026-06-25-strategy-copy-to-account.md`. PR 3 (sell-to-fund-buy) pending.
Owner decision captured 2026-06-24: **full isolation**, with the explicit
exception that *shareable-type* learning (the kind a user can opt to pool
globally) always flows across that one user's own accounts rather than being
walled off per account. Strategies become a **copyable named library**.

This is staged PR 1 of the three follow-ons after the safety fixes (#122) and
the dead-field cleanup (#124). PR 2 (shared saved-strategy library +
copy-to-account) and PR 3 (sell-to-fund-buy 3-way) build on this.

---

## 1. Current state (what this changes)

Already isolated per account — keyed by `(user_id, account_number)`, NO change:
`trade_proposals`, `fill_events`, `portfolio_snapshots`,
`synthetic_trailing_stops`, daily-notional / order-count / PDT accounting
(`db-execution.ts`).

Shared across all of a user's accounts today — the gap this PR closes:
- **Policy / strategy** — `strategy_profiles` (risk caps, scoring weights, prompt)
  **and `policy.systemState`** (active / halted / close_only / liquidating — i.e.
  the kill-switch and Start/Stop run mode). `getPolicy(userId)` (`db-profiles.ts`)
  reads the active profile and injects the active account's fields.
- **Run-state / run-lock** — `strategy_run_lock:${userId}` (`db-execution.ts`)
  serializes runs across ALL of a user's accounts; `strategy_runs` is not
  account-tagged; the scheduler's in-memory `userSchedules` is keyed by user.
- **Performance-derived learning** — `skipped_candidate_counterfactuals`,
  `counterfactual_learning_watermarks` (`db-learning.ts`).
- **Audit / notifications** — `audit_events`, `notification_events` (user-level,
  not filterable by account).

Stays user-level by design (the owner's exception):
- **Fact-tier `learned_context`** — the globally-shareable kind (symbol facts,
  patterns). Always flows across a user's accounts; still escalates to the shared
  pool on opt-in. NO account column.

---

## 2. Identity key — `connected_account_id`

New per-account state keys off `connected_accounts.id` (the stable, **non-null**
account identity, including `test-{userId}`), NOT `account_number` (nullable;
broker-assigned; absent for fresh/Test accounts).

Trade-off / known inconsistency: the legacy per-account tables key off
`account_number`. We do NOT retrofit them in this PR (they work, and churning the
hottest execution tables is risky). New tables use `connected_account_id` and we
document the dual scheme. A future cleanup can unify. Every new table gets an FK
to `connected_accounts(id)` so `deleteConnectedAccount` cascades cleanly.

---

## 3. Strategy library vs. live account policy (the core split)

**`strategy_profiles` becomes a user-level, named, copyable LIBRARY** — "saved
strategies" robust enough to capture the full config (policy JSON + prompt +
scoring weights + the knobs PR 2 will add). It is NOT account-bound and is NOT
the live running state.

**New table `account_strategy_state`** holds each account's **live** state:

```sql
CREATE TABLE IF NOT EXISTS account_strategy_state (
  user_id              TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  policy               TEXT NOT NULL,            -- TradingPolicy JSON (live)
  prompt               TEXT,
  scoring_weights      TEXT,                     -- ScoringWeights JSON
  system_state         TEXT NOT NULL DEFAULT 'halted',  -- active|halted|close_only|liquidating
  derived_from_profile_id TEXT,                  -- nullable ref to the library strategy it was copied from
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (user_id, connected_account_id),
  FOREIGN KEY (connected_account_id) REFERENCES connected_accounts(id) ON DELETE CASCADE
);
```

- `getPolicy(userId, connectedAccountId?)` resolves the account (default = active
  account, exactly as today) and reads its `account_strategy_state` row.
- **Migration-on-read (seamless for existing users):** if no row exists for an
  account, lazily seed it from the user's current active `strategy_profiles` row
  (or the legacy `user_settings['policy']`), then persist. Day-one behavior for an
  existing single-account user is byte-identical; additional accounts inherit a
  copy on first touch. No bulk data migration, no downtime.
- `setPolicy` / Start / Stop / kill-switch write the *account's* row, so
  systemState and risk caps are independent per account.

PR 2 then becomes natural: "apply library strategy X to account Y" = read the
`strategy_profiles` row → write `account_strategy_state` for Y
(`derived_from_profile_id = X`). Copy, not link, so later edits don't retro-mutate
running accounts.

---

## 4. Run-state / scheduler

- Run-lock key: `strategy_run_lock:${userId}` → `:${connectedAccountId}` so two of
  a user's accounts can run concurrently.
- `strategy_runs`: add nullable `connected_account_id`; `insertStrategyRun` /
  `getLastStrategyRunStartedAt` gain an account param.
- Scheduler `userSchedules` becomes keyed by `${userId}:${connectedAccountId}`;
  it iterates a user's *active-for-autonomy* accounts (those whose
  `system_state = active`), rehydrating each account's cadence clock from that
  account's last run. Cadence (`runCadenceMinutes`) is per-account (it lives in
  the per-account policy).

---

## 5. Learning split (the owner's exception, concretely)

- `skipped_candidate_counterfactuals` + `counterfactual_learning_watermarks`: add
  `connected_account_id`. These are performance-derived (tied to an account's own
  trades/regime), so each account tunes scoring weights on its own realized
  outcomes. Thesis stats already come from `fill_events` (per-account), so this
  closes the last cross-account-bleed in the tuning loop.
- `learned_context` (all tiers) + `learned_context_pending`: **unchanged, stay
  user-level.** Fact-tier is the shareable kind → always user-wide per the owner's
  rule. Risk / strategy-directive tiers are user *intent* (e.g. "never short"),
  which is also naturally user-wide; flagged here as a deliberate choice we can
  revisit if a user ever wants account-specific directives.

---

## 6. Audit / notifications

Add nullable `connected_account_id` to `audit_events` and `notification_events`.
Nullable because some events are account-agnostic (login, key changes). Writers
pass the account when in an account context; readers gain an optional account
filter. Default reads stay user-wide (back-compat).

---

## 7. Account deletion + tenant guard

- Extend `deleteConnectedAccount` and the account-deletion purge
  (`account-deletion.ts`) to remove `account_strategy_state` and the per-account
  learning rows (FK `ON DELETE CASCADE` covers `account_strategy_state`; explicit
  deletes for the learning tables that key on it).
- All new CRUD carries the same `user_id` tenant check hardened in #122.

---

## 8. Touched modules (implementation map)

- `db.ts` — `migrate()`: new `account_strategy_state` table + `ALTER` adds of
  `connected_account_id` to `strategy_runs`, `skipped_candidate_counterfactuals`,
  `counterfactual_learning_watermarks`, `audit_events`, `notification_events`
  (bump `SCHEMA_VERSION`).
- `db-profiles.ts` — `getPolicy`/`setPolicy` account-aware + migration-on-read;
  `strategy_profiles` reframed as library (CRUD largely unchanged; semantics
  documented). New `account_strategy_state` CRUD lives here (it owns policy).
- `db-execution.ts` — account-scoped run-lock + `strategy_runs`.
- `db-learning.ts` — account param on counterfactual + watermark CRUD.
- `db-notifications.ts`, `db.ts` `audit()` — optional account tagging.
- `scheduler.ts` — per-account schedules + cadence rehydrate.
- `account-deletion.ts`, `db-api-keys.ts` `deleteConnectedAccount` — purge new rows.
- `types.ts` — `SystemState` moves to per-account state shape if needed; add
  `connectedAccountId` threading where call sites need a specific account.

## 9. Test plan

- Migration: fresh DB + an old DB with an existing active profile → on-read seed
  produces identical policy; existing tests stay green.
- Isolation: two accounts for one user → independent systemState, risk caps,
  Start/Stop; a run on account A doesn't block account B; counterfactuals don't
  cross.
- Learning exception: a fact-tier `learned_context` written under account A is
  visible to account B (user-wide); a counterfactual under A is NOT visible to B.
- Deletion: deleting account A purges its strategy-state + counterfactuals, leaves
  account B and user-wide facts intact; tenant guard blocks cross-user access.
- Full trio (`tsc` / `npm test` / `npm run build`) green.

## 10. Genuine forks for owner sign-off

1. **Keying** — new state on `connected_account_id` (recommended; non-null, FK
   cascade) while legacy execution tables keep `account_number`. OK to live with
   the dual scheme for now? (Alternative: also retrofit legacy tables — larger,
   riskier.)
2. **Risk / strategy-directive learned-context tiers** — keep user-wide
   (recommended) or isolate per account? (Fact-tier is settled: user-wide.)
3. **Scope of this PR** — land schema + `getPolicy`/run-state/learning isolation
   here; defer the Settings UI for per-account Start/Stop + the strategy-library
   browser to PR 2? (Recommended: yes, keep PR 1 backend-only + minimal wiring.)
</content>
