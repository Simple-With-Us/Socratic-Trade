# 2026-09-27 — Review rank 8: parked account state, so a quiet account can say why

Sun, Sep 27, 7:10pm

## 1. Context & Objective

Review rank 8 (2026-09-25): *"Decide what to do with the dormant accounts... For each: park it,
re-arm it, or investigate."*

The decision could not be made, because nothing in the state vocabulary could express it.  The
review named four accounts it could not interpret — Alpaca Standard (last run Jul 6), Tradier live
(exit-only, no snapshots), Public (no snapshots), Agentic (last run Jul 27, 26.8% placement
failures) — and reported each as an unexplained zero or an unknown balance.

`systemState: "halted"` says trading stopped.  `isDraining` says the account is being
disconnected.  **Neither says a person looked at the account and decided it should stay quiet.**
That missing third state is what this adds.

## 2. Changes Made

- **Schema** — `connected_accounts.parked INTEGER DEFAULT 0`, `parked_reason TEXT`,
  `parked_at TEXT`, added by guarded `ALTER TABLE` (same pattern as the existing `is_draining`
  migration) in `db.ts`.
- **Type** — `ConnectedAccount.parked?`, `.parkedReason?`, `.parkedAt?` in `types.ts`.
- **Mappers** — all four `connected_accounts` row mappers in `db-api-keys.ts` read the three
  columns, defensively (an un-migrated database degrades to "not parked" rather than throwing
  inside an account mapper).
- **Ops surface** — `park_account` and `unpark_account` actions in `ops-account-control.ts`, which
  the review named as the dependency (#3754, already merged).  A park **requires** a reason
  (≤ 500 chars) and audits both directions; `accountSummary` now carries the parked facts so every
  ops response can explain a quiet account.
- **Scheduler** — a parked account is skipped before the execution state is derived, so no broker
  gateway is even constructed, and the skip is audited as `scheduler_account_parked_skip` with the
  reason and timestamp attached.

## 3. Decisions & Trade-offs

- **Parking does NOT halt.**  It records the decision; halting stays the separate
  `set_system_state` action.  If park also halted, the two would be one flag and the distinction this
  exists to create would evaporate on first use.  The ops response says so explicitly.
- **Un-parking does NOT arm.**  Same reasoning, and the response says so too.
- **A reason is mandatory.**  A park with a blank reason is indistinguishable from the broken
  accounts this exists to tell apart, so it is rejected rather than accepted-and-useless.
- **Re-parking with a *different* reason is refused (409) and surfaces the existing one**, so a
  blind re-park cannot silently overwrite someone else's decision.  Re-parking with the *same*
  reason is idempotent, not an error.
- **Refuses to park a draining account** (409) — that is a disconnect, not a park, and recording it
  as one would assert something untrue.
- **Un-park clears the reason and timestamp together**, so no stale "why" can outlive the decision
  it belonged to.
- **`lastSkipReason` was deliberately NOT added** to the per-account schedule.  There is no such
  field, and inventing one would add a shape nothing else reads; the audit row is the record.

## 4. Verification State

```
npx tsc --noEmit    0 errors in src/ + app/
npx vitest run test/account-parked-state.test.ts \
    test/account-deletion.test.ts test/connected-accounts-route.test.ts \
    test/connected-account-tenant-guard.test.ts
                                          46 passed (46), 4 files
```

**Failing-first proven**: with the five implementation files stashed and the test kept, **8 of 10
fail**; with the implementation restored, 10/10 pass.  (The two that pass either way are the pure
parser-validation cases, which need no schema.)

## 5. Next Steps & Blockers

- **The decision itself is still the owner's.**  This adds the vocabulary; it does not make the
  call.  The four accounts in the review still need an explicit park / re-arm / investigate.
- No console UI for parking.  The ops endpoint is the surface; a Settings control was not built.
- `ops-performance` / `/api/ops/snapshot` do not yet surface `parked` on their account rows, so a
  report can still show a parked account without saying why.  That is the natural follow-up and is
  the last piece of rank 8's "removes the unexplained zeros".

## 6. Zero-Code Findings

- `listConnectedAccounts` is not the only reader of `connected_accounts` — there are **four** row
  mappers in `db-api-keys.ts` (`listConnectedAccounts` plus three by-id variants).  An early patch
  that only covered two of them typechecked and looked correct while leaving two paths reading a
  parked account as not parked.  Caught because a test that read back through one of the untouched
  mappers failed.
