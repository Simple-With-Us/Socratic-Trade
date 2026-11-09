# 2026-06-21 — Adversarial review: two money-path bugs fixed

## Summary

Retried the failed adversarial review (previous run: all 8 agents rate-limited) using 4
parallel single-agent reviewers on Sonnet 4.6. Two genuine correctness bugs found and fixed.

## Bugs found and fixed

### 1. `maxSymbolExposureNotional` could block closing orders (HIGH)
**File:** `src/lib/policy.ts` (previously ~line 116–126)

**Root cause:** Closing orders (sell/cover) computed
`projectedNotional = Math.max(0, existingValue - estimatedNotional)`. When `estimatedNotional = 0`
(market order expressed as quantity-only with no price or dollarAmount), this yields
`projectedNotional = existingValue`. If `existingValue > cap`, the closing order is blocked —
violating the invariant "risk-reducing exits are never blocked by a notional cap."

**Fix:** Gated the entire check on `isOpening`. Closing orders skip it unconditionally.
The projected-notional formula simplifies to `existingValue + estimatedNotional` (opening only).

**Test added:** `"maxSymbolExposureNotional does NOT block a quantity-only market sell when
estimatedNotional is zero"` in `test/policy.test.ts`.

### 2. `listPendingProposals` missed `__unassigned__` rows (MEDIUM)
**File:** `src/lib/db.ts` (previously line 1204)

**Root cause:** `insertProposal` normalises empty account numbers to `"__unassigned__"` via
`scopeAccount()` (T14-db). But `listPendingProposals` passed the raw caller-supplied
`accountNumber` to the WHERE clause. A caller passing `""` would query
`account_number = ''` and get zero rows, even though the proposals were stored under
`__unassigned__`. The pending-proposal queue was invisible for unassigned accounts.

**Fix:** `.all(scopeAccount(accountNumber), userId)` — same normalisation at read as at write.

**Test added:** `"finds proposals inserted with empty account_number when queried with empty
string"` in `test/daily-notional-reset.test.ts`.

## False positives from review

- **red-team.ts `JSON.parse` throw**: `withLlmGeneration` rethrows errors from the callback
  (observability.ts:133), so a `SyntaxError` on malformed LLM output propagates to the outer
  `catch` at red-team.ts:148 and returns `rejected: false`. Fail-open contract is intact.
  Not a bug — verified by reading observability.ts.

- **`sellQuantityExceedsHoldings` dollar-amount skip**: returns `false` when
  `quantity === undefined`, so a dollar-amount sell bypasses the holdings check. By-design:
  the broker enforces this in live/brokerage mode; paper mode creates positions from fills.
  Not fixed, tracked as a low-priority improvement.

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — 399 tests (was 397), all pass
- `git push origin agent/claude` — `162f4fb`

## Files

- `src/lib/policy.ts` — maxSymbolExposureNotional closing-order gate
- `src/lib/db.ts` — listPendingProposals scopeAccount fix
- `test/policy.test.ts` — regression test for zero-estimatedNotional close
- `test/daily-notional-reset.test.ts` — T14 scopeAccount round-trip test
