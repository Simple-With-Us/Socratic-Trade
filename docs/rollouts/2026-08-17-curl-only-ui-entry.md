# 2026-08-17 — Console/admin entry for curl-only diagnostics (#2563)

## Context & Objective

Issue #2563: four existing server capabilities (`GET /api/admin/tuning-dry-run`,
`GET/POST /api/admin/learning-ledger`, `GET /api/admin/backtest-ic`, `GET /api/audit`)
had no product UI — only docs/curl.  This change adds console/admin paths so each
capability is reachable without curl.  Server behavior is unchanged.

## Changes Made

Read-only (or already-admin-gated revert) clients for the four routes.  Expensive
admin diagnostics stay on-demand.  Audit filter is client-side over the existing
200-row payload.

- `app/console/lib/operator-diagnostics.ts`
- `app/console/strategy/tuning-dry-run.tsx`
- `app/console/strategy/page.tsx`
- `app/console/lessons/learning-ledger.tsx`
- `app/console/lessons/page.tsx`
- `app/console/activity/audit-log.tsx`
- `app/console/activity/page.tsx`
- `app/admin/backtest-ic/page.tsx`
- `app/admin/backtest-ic/backtest-ic-client.tsx`
- `app/admin/layout.tsx`
- `test/operator-diagnostics-ui.test.ts`
- `test/console-tabs-keyboard.test.ts`
- `docs/phase-7-strategy.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Tuning dry-run sits on Strategy next to AI review (issue's highest-value wiring).
  It is admin-gated; a non-operator sees the existing operator-access copy.
- Learning ledger lives on Lessons.  Revert still goes through `POST /api/admin/learning-ledger`.
- Backtest IC is an admin page because the route is `requireAdmin` and rate-limited.
  Query controls only send params the route already reads.
- Audit query is the Activity **Audit** tab (`GET /api/audit` is user-scoped, not admin).
- No route, guard, or persistence changes.

## Verification State

```
npm run lint          # 0 errors (grandfathered warnings only)
npx tsc --noEmit      # clean
npx vitest run test/operator-diagnostics-ui.test.ts \
  test/console-tabs-keyboard.test.ts \
  test/admin-operation-route-wiring.test.ts \
  test/admin-operation-route-behavior.test.ts \
  test/admin-gate.test.ts \
  test/learning-loop-backlog.test.ts \
  test/learning-loop-followon.test.ts \
  test/admin-operation-guard.test.ts
                      # 8 files / 100 passed
npm run build         # Compiled successfully; /admin/backtest-ic registered
```

Full `npm test` in this cloud VM started failing unrelated network/env cases
(SEC 404, FRED, Voyage, usage-monitor) and then stopped emitting output after
`vector-db-lease-fencing`.  Stopped that run.  Server routes under test above
are unchanged and still pass.

## Next Steps & Blockers

- Verify CI `verify` on the PR.
- Close #2563 when this merges.

## Zero-Code Findings

None — this is the UI wiring the 2026-08-06 product review asked for.
