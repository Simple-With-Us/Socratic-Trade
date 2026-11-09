# 2026-08-15 — Account-config Title Case

## Context & Objective

The Connections capabilities sheet mixed Title Case chips (`Connected`, `Disabled`, `Enabled`) with sentence-case values (`Whole shares`, `regular + extended`, `Orders · level 2`).  Owner: follow Title Case like `Fractional Shares` and capitalize the other words the same way.

## Changes Made

- Row label `Fractional shares` → `Fractional Shares`.
- Chip values: `Whole Shares`, `Regular + Extended`, `Regular + Extended + Overnight`, `Regular Only`, `Orders · Level N`, `Positions Only · Level N`.
- Fractional-on chip is `Enabled` (same vocabulary as Short Selling / Margin), not `Yes`.

### Files

- `app/console/lib/labels.ts`
- `app/console/settings/brokers.tsx`
- `test/account-capability-labels.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-15-account-config-title-case.md`

## Decisions & Trade-offs

Fleet copy says values are usually sentence case.  This sheet already shipped `Connected` / `Disabled` / `Enabled` / `Cash Only` as Title Case next to Title Case labels, so the rest of the chips follow that local convention rather than flipping the existing chips to sentence case.

## Verification State

```
npx vitest run test/account-capability-labels.test.ts
```

3/3 pass.  Full land.sh gate on land.

## Next Steps & Blockers

None for this copy pass.
