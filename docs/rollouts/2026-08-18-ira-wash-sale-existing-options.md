# 2026-08-18 — IRA Ignore / Auto / Block + optional min-loss

## Context & Objective

Owner asked to confirm the existing wash-sale options, then corrected: min-loss should be optional, and they must be able to choose Auto on an IRA (not only Ignore vs Block).

## Changes Made

`iraWashSaleHandling` is `block | auto | disregard`.  Ignore (default) does not constrain Green.  Auto proceeds and Green weighs priced lock costs — the same idea as taxable Auto.  Block refuses.  `washSaleMinLossUsd` is optional on taxable and IRA: blank means every loss is in play.  There is no hidden $50 IRA default.

- Gate: Ignore → `ira_disregarded`; Auto → `auto_proceeded`; Block → `blocked_ira`.  Optional floor exempts smaller losses when set.
- Prompt `agentic-strategy@2.14.0`.
- Strategy `taxContext`: Ignore omits lock lists/costs; Auto includes them; Block includes symbols only.
- Guardrails / Tax treatment / Results / iOS show Auto and optional min-loss.

Touched files:

- `src/lib/types.ts`, `src/lib/defaults.ts`, `src/lib/policy.ts`
- `src/lib/strategy-prompts.ts`, `src/lib/strategy.ts`
- `app/console/guardrails/field-defs.ts`, `app/console/guardrails/page.tsx`
- `app/console/strategy/tax-settings.tsx`, `app/console/results/page.tsx`
- `app/settings-search.ts`, `app/api/policy/route.ts`
- `ios/SocraticTrade/DeskModels.swift`, `ios/SocraticTrade/GuardrailsView.swift`
- `ios/SocraticTradeTests/DeskModelsTests.swift`
- `test/washsale-modes.test.ts`, `test/run-strategy-offline.test.ts`, `test/strategy-prompt-safety.test.ts`
- `test/ira-washsale-api.test.ts`, `test/console-policy-diff.test.ts`
- `docs/architecture-blueprint.md`, `docs/trading-framework.md`, `docs/phase-7-strategy.md`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Auto on IRA is the existing taxable Auto idea, not a new "factor" enum name.
- Blank min-loss = every loss (same as taxable).  Explicit 0 is treated as unset.
- Ignore still annotates a material rebuy.  Auto uses the existing `auto_proceeded` receipt.
- iOS remains display-only for these tax fields.
- No Stripe / IAP.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/washsale-modes.test.ts test/run-strategy-offline.test.ts test/strategy-prompt-safety.test.ts test/ira-washsale-api.test.ts test/console-policy-diff.test.ts test/settings-search-index.test.ts
npm run lint
```

- `npx tsc --noEmit` — clean
- focused vitest — 6 files / 111 passed
- `npm run lint` — 0 errors (grandfathered warnings only)
- `npm run build` — clean

## Next Steps & Blockers

- Confirm production Roth `iraWashSaleHandling`.  Default remains Ignore.  Choose Auto on Guardrails if they want Green to weigh a taxable lockout.

## Zero-Code Findings

IRA previously only persisted `block` or `disregard`.  Taxable Auto could not be selected for an IRA buyer.  The $50 IRA blank default was not what the owner asked for.
