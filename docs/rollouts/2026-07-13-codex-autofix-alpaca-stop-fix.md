# 2026-07-13 — [codex-autofix] Fix 3 Codex P2 findings on PR #1548

## Summary
Addressed 3 Codex review P2 findings on PR #1548 (`agent/ag-alpaca-stop-fix`): fractional Alpaca fixed-stop quantities, contradictory STATUS.md prod claims, and missing `brokerBracketsEnabled` opt-out for Alpaca fixed stops.

## Changes

### Finding 1: Floor Alpaca fixed-stop quantities (P2)
- **File**: `src/lib/broker-protective-stops.ts`
- **Change**: In `desiredStopQuantity`, removed the `forKind === "trailing"` guard so flooring to whole shares applies to ALL Alpaca-family stop kinds (fixed + trailing), not just trailing. The same Alpaca fractional GTC restriction applies regardless of stop kind.
- **Before**: `return forKind === "trailing" && isAlpacaFamily ? Math.floor(qty) : qty;`
- **After**: `return isAlpacaFamily ? Math.floor(qty) : qty;`

### Finding 2: Remove contradictory prod flag activation claims (P2)
- **File**: `STATUS.md`
- **Change**: Corrected "applying them across dev, staging, and prod" → "across dev and staging" and "across all environments" → "across dev and staging", matching the note that prod flags still require manual owner action.

### Finding 3: Honor the Alpaca broker-held stop opt-out (P2)
- **File**: `src/lib/broker-protective-stops.ts`
- **Change**: Added `policy.brokerBracketsEnabled !== false` gate to the Alpaca path in `brokerProtectiveStopsEnabled`. Users who disable `brokerBracketsEnabled` (opting out of broker-side bracket orders) will now also be excluded from the Alpaca fixed-stop protection lane.

## Verification
- `npm run lint`: 0 errors / 452 warnings (pre-existing)
- `npx tsc --noEmit`: clean
- `npm test`: 352 files / 3962 tests pass
- `npm run build`: clean

## Threads resolved
- PRRT_kwDOS7mOVM6Qe9Cs — Floor Alpaca fixed-stop quantities
- PRRT_kwDOS7mOVM6Qe9Cv — Remove contradictory prod flag activation claims
- PRRT_kwDOS7mOVM6Qe9Cx — Honor the Alpaca broker-held stop opt-out
