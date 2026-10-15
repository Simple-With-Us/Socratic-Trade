# 2026-10-15 — Ops performance rows say when an account is parked

Thu, Oct 15, 2026

## 1. Context & Objective

ST-3875's measurement ranks are already on `main`.  The leftover code gap was that
`GET /api/ops/performance` still omitted the park decision, so a deliberately quiet account and a
broken one looked the same in the performance report.  This adds the flag.  It does not park or
re-arm any account.  That call stays with the owner.

## 2. Changes Made

Each account row now carries `parked`, `parkedReason`, and `parkedAt`, copied from the connected
account in the same shape the ops account-control summary already uses.  The facts sit on the
shared account base, so the priced book, the never-synced branch, and the per-account error branch
all include them.

- `src/lib/ops-performance.ts`
- `test/ops-performance.test.ts`
- `docs/runbooks/ops-performance-endpoint.md`
- `docs/rollouts/2026-09-27-st-account-parked.md` (the old follow-up now points here)
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-10-15-ops-performance-parked-flag.md`

## 3. Decisions & Trade-offs

- Report only.  No scheduler, policy, or broker change, and no account is parked by this work.
- Same three fields as `accountSummary` in `src/lib/ops-account-control.ts`, including a null
  reason or time when the column is empty.  A missing value stays null rather than `""`.
- `/api/ops/snapshot` still does not carry the flag.  Out of scope for this change.
- The existing 60s snapshot cache applies.  A park made inside that window can lag one response.

## 4. Verification State

```
npm run lint
                                          # exit 0 (warnings only; the gate fails on errors)
npx tsc --noEmit
                                          # exit 0
npm test
                                          # exit 0 on CI verify-hosted for this PR
npm run build
                                          # exit 0
```

Targeted ops-performance and parked-account tests were also run locally during development
(`test/ops-performance.test.ts`, `test/ops-performance-measurement.test.ts`,
`test/account-parked-state.test.ts`, 36 passed).  That slice is not listed above because rollout
verification follows the repo gate order only.

## 5. Next Steps & Blockers

- Owner decision, unchanged: park, re-arm, or investigate Alpaca Standard, Tradier live, Public,
  and Agentic.  This change does not make that call.
- `/api/ops/snapshot` account rows still omit `parked`.

## 6. Zero-Code Findings

None.  The flag was already stored and already returned by ops account control.
