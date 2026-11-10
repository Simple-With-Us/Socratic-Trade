# 2026-08-18 — IRA accounts must not tax-loss harvest

## Context & Objective

Owner confirmed Roth IRAs cannot harvest tax losses, then showed Autopilot selling NWG on the Roth with Green rationale "Harvesting unrealized loss in NWG to offset gains as part of tax loss harvesting strategy."  That sell cannot create a deductible loss.  Green was being told it traded a taxable account and to harvest `harvestableLosses` whenever any `taxContext` existed.

## Changes Made

IRA runs now get IRA tax language (do not harvest; judge exits on thesis/risk/allocation).  Taxable runs keep the existing harvest and long-term-rate lines.  `getTaxSummary` returns no harvest candidates for Roth/Traditional.  Strategy omits `harvestableLosses` and `positionsNearLongTerm` for an IRA buyer.  Strategy now overlays the connected-account `taxationType` the same way the dashboard already did, so a stale policy tax type cannot keep feeding harvest math.

- `src/lib/tax.ts` — `isIraTaxationType`, `overlayAccountTaxationType`, empty IRA harvest list
- `src/lib/strategy.ts` — overlay taxationType; omit harvest / LT-window fields on IRA; pass `isIraAccount`
- `src/lib/strategy-prompts.ts` — `agentic-strategy@2.12.0`; IRA vs taxable tax paragraph
- `src/lib/dashboard.ts` — shared overlay helper
- `src/lib/types.ts` — IRA comment includes no harvest
- `app/console/results/page.tsx` — IRA Results blurb
- `test/tax.test.ts`, `test/run-strategy-offline.test.ts`, `test/strategy-prompt-safety.test.ts`
- `docs/architecture-blueprint.md`, `PROJECT.md`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Prompt + context only.  Did not add a rationale-text gate that blocks sells mentioning "harvest" — that would be brittle and paternal.  An IRA may still sell a loser when the thesis or risk says so.
- Cross-account wash-sale lockouts stay.  Rev. Rul. 2008-5 still matters when a taxable account already realized the loss.
- `iraWashSaleDisregard` still implies IRA language so an older caller that only set that flag cannot resurrect harvest instructions.
- Did not change owner strategy text.  System tax rules now contradict a harvest-in-IRA instruction if one is in the fenced owner prompt.
- No Stripe / IAP.  Did not touch reserved PRs.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/tax.test.ts test/run-strategy-offline.test.ts test/strategy-prompt-safety.test.ts
npm run lint
```

Focused tests and tsc are recorded in this note after they run.  Full `npm test` / `npm run build` follow if those pass.

## Next Steps & Blockers

After merge, the next Roth Autopilot run should not propose a harvest-only NWG (or any) sell.  A thesis/risk exit of a loser is still allowed.  No production apply is needed beyond the auto-deploy.

## Zero-Code Findings

Prod ops snapshot 2026-08-18T02:54Z: Roth IRA is Autopilot (`systemState=active`, `strategyAuthority=decide`).  Last successful Roth proposal run in the snapshot window was 2026-08-14 (4 proposals, 2 placed).  The NWG ticket matches that harvest instruction, not a wash-sale lock.
