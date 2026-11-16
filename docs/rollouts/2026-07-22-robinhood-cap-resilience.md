# Robinhood guardrail cap resilience — 2026-07-22

## Summary

Fixed two related policy UX and execution problems:

- Saving unrelated guardrail fields no longer fails solely because a transient Robinhood account
  list call cannot verify an otherwise unchanged selected account.
- Effective opening order and daily spend are account-aware. Oversized absolute settings are capped
  at feasible buying power/NAV, and blank dual-mode guardrails default to percentages.

Account-selection/readiness changes and autonomy activation continue to require broker verification.
Hard policy evaluation still rejects a proposal that exceeds its effective cap; deterministic strategy
sizing and the proposal prompt now use the same cap calculation so ordinary proposals are sized to
the feasible amount instead of failing at placement.

## Why

The mobile settings flow showed `Save refused — Could not verify the selected account right now`.
The policy route verified the broker on every save, including edits unrelated to account readiness,
so a temporary Robinhood account-read failure blocked harmless cap changes. Separately, a user-set
dollar cap could exceed the account's current spend capacity and propagate an infeasible proposal.

## Files

- `app/api/policy/route.ts` — conditional account verification on policy save.
- `app/console/components/policy-form.tsx` — percentage-first mode when both fields are blank.
- `app/console/guardrails/field-defs.ts` — account-aware cap hints.
- `src/lib/policy-caps.ts` — shared effective opening-cap and account-spend resolution.
- `src/lib/policy.ts` — per-order policy enforcement uses the shared effective cap.
- `src/lib/strategy.ts` — deterministic and prompt sizing use the shared effective cap.
- `test/policy-save-resilience.test.ts` — Robinhood save/activation verification regressions.
- `test/policy-caps.test.ts`, `test/console-live-data-derive.test.ts`,
  `test/washsale-modes.test.ts` — effective-cap contract updates and regressions.

## Verification

- `npx vitest run test/policy-caps.test.ts test/policy-save-resilience.test.ts test/policy-account-target.test.ts --maxWorkers=1` — 11/11 passed.
- `npx vitest run test/policy.test.ts test/conviction-size-cap.test.ts test/strategy-tuning.test.ts test/finalized-sizing-review.test.ts test/policy-caps.test.ts test/policy-save-resilience.test.ts --maxWorkers=1` — 95/95 passed.
- `npx vitest run test/washsale-modes.test.ts test/final-size-red-autonomous.test.ts test/console-live-data-derive.test.ts test/policy-caps.test.ts test/policy-save-resilience.test.ts --maxWorkers=1` — 102/102 passed.
- `npm run lint` — passed with zero errors (existing warnings remain).
- `npx tsc --noEmit` — passed on the final code tree.
- `npm run build` — passed; existing Sentry Edge Runtime and build-environment encryption-key warnings remain.
- `npm test` — not claimed complete. The repository Vitest configuration serializes the suite; repeated full runs remained active under concurrent fleet load and were stopped after focused regressions were green.

## Follow-ups

- Land through the protected PR gate and verify the exact auto-deployed SHA.
- Exercise a real Robinhood settings save and proposal placement after deployment.
- Keep daily capacity based on NAV rather than a static buying-power snapshot because sell-to-fund
  actions can increase buying power during a run; buy-side per-order caps use current buying power.
