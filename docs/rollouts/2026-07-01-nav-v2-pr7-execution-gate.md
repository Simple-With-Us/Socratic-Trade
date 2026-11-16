# 2026-07-01 — NAV_V2 PR #7 (⛔ gate): view/execution decouple + write-time validation

Branch: `claude/settings-navigation-redesign-a3k1yv-mce45j` (restarted from `main` after #305/#2–#6 merged).
The delivery plan's ⛔ **gate** — the first real-money safety migration. **Not flag-gated** (removing a
coercion must not depend on a client flag). No account-switching chrome (#9–#11) may merge before this.

**⚠️ Real-money code, changed in a cloud env without browser QA — review + preview-QA before merge.**

## Key finding: most of PR #7 was already implemented
A read-only map of the arming/execution machinery (via subagent) found the plan's line anchors were from an
older HEAD and that the core safety properties **already exist and are tested**:
- **Autonomy-reset-on-restart** — `scheduler.reconcileAutonomyOnBoot()` (scheduler.ts:56-98) halts every
  account with `systemState="active"` on boot unless per-user `autoResumeOnBoot` / operator
  `AUTONOMY_RESUME_ON_BOOT=1`. Tested: `deep-safety-fixes.test.ts:132-150`.
- **Scheduler fan-out** — iterates every connected account and gates on each account's own `systemState`;
  the active-account pointer has **zero execution effect** (scheduler.ts:218-310).
- **View pointer is view-only** — `setActiveConnectedAccount` flips `is_active` only; **mobile already only
  flips the pointer** (`mobile-api.ts` `account.activate`), no execution mutation.
- **`applyProfileToAccount` already preserves `systemState`** (copy-preset-in never arms/disarms). Tested:
  `strategy-copy-to-account.test.ts:46-65`.
- **API auth already ignores body identity** (`resolveRequestUserId` reads a verified header) and enforces
  per-user ownership on account/profile queries.

So the actual **remaining** coupling was narrow. This PR closes it.

## What changed (`src/lib/db-profiles.ts`)
1. **Seed decouple (fail-closed).** The three not-active→halted seed-coercion points were gated on the
   ephemeral active-account pointer (`account.id !== activeId && systemState === "active"`). Replaced with an
   **unconditional fail-closed floor**: a freshly-seeded account never inherits `"active"` — it seeds
   `"halted"` regardless of which account is the view pointer. This removes the last view→execution coupling
   at seed time and is strictly safer (even the active account no longer auto-arms on first touch; arming is
   an explicit per-account action). Established rows are untouched (they read their own `system_state`).
2. **Ambient mirror neutralized.** `mirrorPolicyToActiveAccount` → **`copyPolicyConfigToActiveAccount`**:
   activating/creating/updating a *library* profile still propagates strategy CONFIG (prompt/weights/caps)
   to the active account, but now **preserves that account's run-state** (`systemState`) — a library edit can
   no longer arm or disarm an account as a side-effect (it read+wrote the base policy's `systemState` before).
   Uses read-only `peekPolicy` (no seeding) to read the current state.
3. **Explicit write-time ownership guard.** New exported `assertConnectedAccountOwnedByUser(userId, id)` — the
   plan's "real safety boundary" made explicit — used by `applyProfileToAccount`. A stale/malicious tab cannot
   commit a write against an account the session user does not own, regardless of the id it supplies.

### Deviation from the letter of the plan (documented)
The plan says "fully remove the ambient mirror + split into explicit verbs." Full removal without the
copy-on-bind Settings UI (staged to the shell, PR #9) would leave a UX gap (activating a profile would stop
propagating config to the account). The **safety-first** choice here — make the mirror
`systemState`-preserving (config-only) — removes the real hazard (side-effect arm/disarm) while keeping config
propagation, and is verifiable by tests. The full verb-split + copy-on-bind UI lands with the shell.

## Tests (all new, + merge-gate)
- `decouple-no-coercion.test.ts` — switching the view pointer never changes another account's run-state;
  a fresh account seeds `halted` even when it IS the active pointer (fail-closed, no auto-arm).
- `copy-config-preserves-arming.test.ts` — activating an "active" library profile never arms a halted
  account (config propagates, run-state preserved); activating a "halted" profile never disarms an armed one.
- `write-time-accountid-validation.test.ts` — a write against another user's / a non-existent account is
  rejected; an owned-account write succeeds.
- `mobile-view-scope.test.ts` — the real mobile `account.activate` command flips the pointer but changes no
  account's run-state.
- `pr7-merge-gate.test.ts` — structural: `mirrorPolicyToActiveAccount` gone, no `activeId` view-pointer seed
  coercion, `applyProfileToAccount` enforces the ownership guard.

## Verification
`tsc` clean · `lint` 0 errors · `npm test` 208 files / 2032 tests (+5 files / +12) · `build` success. The
pre-existing safety tests (`per-account-policy-isolation`, `deep-safety-fixes`, `strategy-copy-to-account`,
`policy`, `account-scope`) stay green — the change only affects the fresh-seed path and the mirror's run-state
handling.

## Rollback / safety
This *removes* hazards (view→execution seed coupling; library-edit arm/disarm side-effect) and is fail-closed,
so a straight revert restores the coupling — prefer forward-fix. The change is unconditional by design.

## Follow-ups
- Full verb-split (`activateAccount` view-switch vs `applyProfileToAccount` copy) + copy-on-bind Settings UI
  land with the shell (PR #9).
- `armed_at`/`armed_by` provenance columns remain optional (autonomy changes are already audited via
  `audit_events`); add only if per-arm provenance becomes a UI requirement.
