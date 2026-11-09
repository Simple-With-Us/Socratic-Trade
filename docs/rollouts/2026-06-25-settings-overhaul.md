# 2026-06-25 — Settings overhaul: surface enforced guards + honest interactions (Phase 3)

Branch `agent/claude-settings-ui`. Final phase of `docs/settings-and-universe-overhaul-plan.md`.

## Summary
The settings UI hid ~17 enforced policy guards entirely and left several mutually-exclusive / interacting
controls unlabeled. This adds a new **Risk & Safety** settings tab that surfaces every enforced-but-invisible
guard, a per-account stop-support panel, and makes the silent interactions explicit — so settings no longer
"pretend" you have nothing to set (or let you mis-set combos the engine silently resolves).

## Why
The verified audit (`docs/rollouts/2026-06-25-sell-stops-settings-audit.md`) found ~17 enforced settings with
no UI (incl. the safety-critical drawdown/daily-loss breaker and vol-panic brake), a destructive `$⇄%`
toggle, a beta-scaling that silently changes the displayed stop, a shorting toggle that left every short
rejected without a (hidden) short stop-loss, an Alpaca-only bracket switch presented as universal, and a
help line referencing a "separate order permission" control that didn't exist. Owner asked for a full
overhaul so the settings are honest about what's enforced and what's mutually exclusive.

## What changed
- **New `app/dashboard-client.tsx` "Risk & Safety" tab** (`SettingsSection` + Tabs + section block),
  grouped into cards, all wired to the existing `updatePolicy()` immediate-save model and reusing the
  existing `Switch`/`NumberField`/`OptionalNumberField`/`Field`/checkbox primitives:
  - **Account circuit breakers** — `riskRules.maxDrawdownPct`, `riskRules.maxDailyLossNotional`.
  - **Volatility panic brake** — `volPanicBrakeEnabled` (+ VIX/VVIX/SKEW thresholds, shown when on; defaults noted).
  - **Whole-portfolio exposure** — `maxGrossExposurePct`, `maxNetExposurePct` (with the "default 80% keeps ~20% cash" note).
  - **Stops & exits** — `riskRules.trailingStopPct`, `riskRules.takeProfitTrimPct`, ATR stops
    (`atrStops` + `atrStopPeriod`/`atrStopMultiple`), Robinhood broker-held stop (`robinhoodBrokerStops`,
    shown only on a Robinhood account), and a **per-broker stop-support panel** (what actually protects a
    position on the active broker — Alpaca brackets vs Robinhood protective stop vs Test = simulated; and
    the universal "trailing/app-managed stops only fire while the app runs").
  - **Short-selling limits** — `riskRules.shortStopLossPct` (with an inline warning when shorting is on but
    unset → every short rejected), `maxShortOrderNotional`, `maxShortExposurePct`.
  - **Order execution** — `permittedOrderTypes` (checkboxes), `permitExtendedHours`, `maxOrderPctOfAdv`,
    `marketableLimitEntries`, `allowExtendedHoursSyntheticStops`.
  - **Universe floor** — `universeFloor.minPrice` / `minMarketCapUsd` / `minDollarVolume` (Phase 1 field).
- **Honest-interaction fixes** in the existing Key Parameters card:
  - A note that `$⇄%` is one-or-the-other (setting one clears the other) + a pointer to Risk & Safety.
  - Beta-scaled-stops help now states the displayed Stop loss % is the BASE (actual = base × clamped beta),
    and that ATR takes precedence when both are on.
  - Broker-held-brackets help clarified: Alpaca-only and gated on a stop-loss % being set.
  - Short-selling toggle help now points to the required short stop-loss.
  - The dangling "separate order permission" extended-hours text now points to the real new control.
- **API validation** (`app/api/policy/route.ts`): added range/shape checks for the newly-editable fields
  (gross/net/short exposure %, short/ADV notionals, vol thresholds, `permittedOrderTypes` subset,
  `universeFloor` non-negative, `takeProfitTrimPct`/`maxDrawdownPct`/`trailingStopPct` bounds). Existing
  spread already persisted them; this rejects bad input.

## Verification
- `npx tsc --noEmit` — clean (confirms every referenced `policy.*` field exists on the type).
- `npm run build` — clean full production compile (the new tab + controls render-validate at the framework level).
- Full `npm test` + build via `scripts/land.sh` before PR.
- NOTE: interactive browser verification was not run here — the preview tool is bound to the main
  integration worktree (`/Users/jay/Code/Agentic Trading`, port 4001), not this ad-hoc worktree, so it
  serves main's code, not these changes. Verification rests on tsc + build + strict reuse of existing,
  working control primitives. A live walkthrough on the user's running instance (Settings → Risk & Safety)
  is the recommended final check.

## Adversarial review fixes (before merge)
A review pass found 2 real bugs, both fixed:
- **HIGH — "Blank = off" silently failed.** `updatePolicy` sent `JSON.stringify(...)`, which drops `undefined`
  keys, so clearing a set field never reached the server and the `...current` merge restored the old value
  (a pre-existing pattern this change made pervasive + documented). Fix: the client now serializes a cleared
  field as `null` (survives JSON), and the route `stripNullsDeep`s the merged policy so a `null` becomes an
  absent key (guard off / reverts to default). Regression test: `test/policy-clear-nulls.test.ts`.
- **MEDIUM — nested `<label>`.** The permitted-order-types checkbox group was wrapped in `Field` (a `<label>`),
  so a click on the heading/padding toggled the first checkbox. Fix: use a plain container with label/hint
  spans instead of `Field`.

## Follow-ups
- Completes the 4-phase settings/universe program.
- Optional future polish: make the `$⇄%` control hold BOTH values (engine already honors `min($,%)`),
  rather than either-or; and a compact "effective stop per name" preview when beta/ATR scaling is on.
