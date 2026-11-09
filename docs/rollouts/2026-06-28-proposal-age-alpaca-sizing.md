# 2026-06-28 — Proposal Age, Alpaca Brackets, and Hidden Sizing Caps

## Summary

- Proposal cards now show relative age for decisions under 24 hours old, then date/time for older decisions.
- Settings now writes dollar-vs-percent risk controls as mutually exclusive fields in one policy request, and the policy API normalizes legacy hidden cap pairs.
- Alpaca native bracket orders no longer attempt impossible sub-one-share dollar brackets.
- Alpaca REST order errors now include response status/body detail, with a clearer hint for bare 403 responses.

## Why

Live inspection of recent proposals showed $50-$70 buy orders on a roughly $100k brokerage account. The active policy carried both `maxOrderNotional=100` and `maxOrderPctOfNav=5`; the backend correctly treated the smaller value as the effective cap, but the UI made it look like only the percent cap was active. Those small orders then failed when routed as Alpaca native brackets because a dollar bracket below the reference price floors to zero whole shares. That produced `Alpaca bracket dollar order is too small for a whole-share bracket at the reference price.`

`Placement Uncertain` remains the right status after a broker-placement attempt errors: the app wrote a placement intent before the broker call returned, and it should not pretend the broker definitely rejected or accepted the order without reconciliation. This rollout reduces avoidable placement failures and improves diagnostics instead of hiding that state.

The observed `Request failed with status code 403` needs broker response detail to diagnose precisely. A bare 403 usually means Alpaca forbade the request for account/permission/position reasons, such as attempting a sell/cover that the broker does not consider backed by a matching open position. The client now surfaces Alpaca's response body when present.

## Files

- `app/api/policy/route.ts`
- `app/dashboard-client.tsx`
- `src/lib/alpaca.ts`
- `src/lib/policy-normalization.ts`
- `src/lib/strategy.ts`
- `test/antigravity-cheap-wins.test.ts`
- `test/policy-normalization.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-7-strategy.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-28-proposal-age-alpaca-sizing.md`

## Verification

- `npm ci` — installed this isolated worktree's dependencies.
- `npx tsc --noEmit` — passed.
- `npx vitest run test/policy-normalization.test.ts test/antigravity-cheap-wins.test.ts` — passed, 13 tests.
- `npm test` — passed, 154 files / 1,492 tests after merging `origin/main`.
- `npm run build` — passed.
- First full `npm test` run failed after normalization was too broad in DB/profile merge helpers; the patch was narrowed to the policy API boundary and the suite passed.

## Follow-ups

- Re-run production with the normalized policy so the hidden `$100` cap is removed from the active account's stored policy.
- If Alpaca still returns 403, inspect the now-surfaced response body and compare the attempted side/quantity against broker-held positions and account trading permissions.
- `Placement Uncertain` can be made more actionable later with broker-side order reconciliation against recent Alpaca order IDs, but it should not be removed as a safety state.
