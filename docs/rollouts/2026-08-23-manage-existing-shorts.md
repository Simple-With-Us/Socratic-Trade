# Active Management & Protective Stops for Held Short Positions When Short Selling Disabled

**Date:** 2026-08-23  
**Author:** Antigravity  
**Branch:** `agent/ag-manage-existing-shorts`  

---

## 1. Context & Objective

When the `shortSellingEnabled` guardrail toggle is disabled (`false`), existing open short positions (`quantity < 0`) were previously skipped and left unmanaged across multiple risk layers (proactive risk exits, take-profit trims, synthetic stop monitoring, and resting broker buy-stops on Alpaca), causing the console UI to report them as "unmanaged shorts".  
The objective of this change is to ensure `shortSellingEnabled` strictly gates opening new short positions (`proposal.side === "short"`), while all existing held short positions (`quantity < 0`) remain actively managed, monitored, and protected by stop-loss, trailing stop, take-profit, and resting broker buy-stop mechanisms. Additionally, this clarifies why default policies initialize with short selling disabled (`src/lib/defaults.ts` safety baseline).

---

## 2. Changes Made

### A. Strategy & Risk Reconciler (`src/lib/strategy.ts`)
- Removed `if (!policy.shortSellingEnabled) continue;` check in `generateProactiveRiskProposals` (~line 7734) so held short positions that breach stop-loss thresholds emit `cover` proposals regardless of `shortSellingEnabled`.
- Removed `if (isShort && !policy.shortSellingEnabled) continue;` in `planTakeProfitTrims` (~line 7840) so profitable short positions are actively trimmed.

### B. Synthetic Stop Monitor (`src/lib/synthetic-stops.ts`)
- Removed `policy.shortSellingEnabled === true` gating in `runSyntheticStopMonitor` for trailing stops (~line 530) and fixed/ATR stops (~line 634) on short positions. Held shorts are actively monitored on scheduler ticks.

### C. Broker Protective Stops (`src/lib/broker-protective-stops.ts`)
- Updated `brokerStopsForShortsEnabled` (~line 170) to remove the `policy.shortSellingEnabled !== true` requirement. Alpaca short positions receive resting GTC `stop_market` buy-stops whenever `brokerStopsForShorts !== false`.

### D. Console UI & Derivations (`app/console/lib/derive.ts`, `app/console/guardrails/field-defs.ts`)
- Removed `shorts_disabled` reason code from `deriveUnmanagedShorts` and `unmanagedShortNotice`. Open shorts on Alpaca are now considered managed unless broker buy-stops are disabled or the venue does not support broker-held stops (e.g. Robinhood).
- Removed suppression in `deriveProtection` so per-position plans and base stop labels show active protection (`tone: "pos"`) for held shorts.
- Updated field definition copy for `brokerStopsForShorts` in `app/console/guardrails/field-defs.ts`.

### E. Touched Files
- `src/lib/strategy.ts`
- `src/lib/synthetic-stops.ts`
- `src/lib/broker-protective-stops.ts`
- `app/console/lib/derive.ts`
- `app/console/guardrails/field-defs.ts`
- `app/console/guardrails/page.tsx`
- `app/console/components/policy-form.tsx`
- `app/console/console.css`
- `src/lib/market-hours.ts`
- `test/broker-protective-stops.test.ts`
- `test/console-live-data-derive.test.ts`
- `test/reconciliation-risk.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-23-manage-existing-shorts.md`

---

## 3. Decisions & Trade-offs

- **Risk Reduction vs Opening New Exposure**: Opening new short positions introduces asymmetric downside risk and requires explicit user consent (`shortSellingEnabled: true`). In contrast, covering or placing protective stop-losses on an already-held short position strictly reduces or caps risk. Therefore, covering/managing held shorts must never be blocked by `shortSellingEnabled: false`.
- **Default Policy Baseline**: In `src/lib/defaults.ts`, `DEFAULT_POLICY.shortSellingEnabled` defaults to `undefined`/`false` so new accounts do not automatically initiate short sales without intentional opt-in by the user.

---

## 4. Verification State

- **Targeted Test Suite**:
  ```bash
  npx vitest run test/synthetic-stops.test.ts test/broker-protective-stops.test.ts test/reconciliation-risk.test.ts test/console-live-data-derive.test.ts test/stop-flow-model.test.ts test/policy.test.ts test/venue-contract.test.ts test/strategy-hardening.test.ts test/hard-gate-classification.test.ts test/p0-safety-fixes.test.ts
  ```
  Result: 10/10 test files passed (470/470 tests).

- **Static Analysis & Build Gate**:
  - `npm run lint`: Passed (0 errors, 776 warnings).
  - `npx tsc --noEmit`: Passed (0 errors).
  - `npm run build`: Passed (Next.js production build succeeded).

---

## 5. Next Steps & Blockers

- Merge PR to `main` and verify deployment SHA via `scripts/verify-deploy-sha.sh`.
- Update Apple Notes completion summary.
- Update `/Users/jay/apps/TRADING-EFFORT-LOG.md` and `docs/EFFORT-LOG.md` to Completed (merged) / Deployed to production.

---

## 6. Zero-Code Findings

- Explaining default toggle state: The user noted they did not disable the setting manually. In the codebase, `DEFAULT_POLICY.shortSellingEnabled` is initialized to `undefined` in `src/lib/defaults.ts`, which evaluates to `false` (disabled) by default across newly connected accounts until toggled on in Console > Guardrails > Short selling.
