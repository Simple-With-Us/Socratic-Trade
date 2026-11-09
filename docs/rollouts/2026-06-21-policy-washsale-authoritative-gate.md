# 2026-06-21 — Policy: Authoritative Cross-Account Wash-Sale Gate

## Summary

Made the wash-sale check in `evaluateTradeProposal` authoritative: when
`washSaleGuard` is enabled and the caller omits `context.washSaleLockedSymbols`,
the gate now resolves the cross-account locked symbol set itself via
`getUserWashSaleLockedSymbols(userId)` rather than silently passing.

## Why

architecture-blueprint.md §3.3 specifies cross-account wash-sale enforcement
AT the policy gate. The previous implementation only checked
`context.washSaleLockedSymbols?.has(symbol)` — an Optional chained set access
that silently no-ops when the caller omits the field. Any future caller (e.g.
`app/api/proposals/from-draft/route.ts`, which already omits it) would bypass
the guardrail entirely. The fix closes that gap without altering the happy path
(when the set IS pre-populated, it's used directly — no double DB call).

## Files

- `src/lib/policy.ts` — Added `userId?: string` to `PolicyContext`; imported
  `getUserWashSaleLockedSymbols` from `./tax`; updated the wash-sale block to
  resolve the locked set from DB when `washSaleLockedSymbols` is absent but
  `userId` is present. Added clarifying comment on why `cover` is excluded.
- `test/policy.test.ts` — Added `vi.mock("../src/lib/tax", ...)` so the gate
  tests remain pure unit tests without a DB. Added two new tests:
  1. Buy blocked at the gate even when `washSaleLockedSymbols` is omitted
     (gate resolves it via `getUserWashSaleLockedSymbols`).
  2. When `washSaleLockedSymbols` IS pre-populated, `getUserWashSaleLockedSymbols`
     is NOT called (avoids redundant DB work).

## Verification

```
npx tsc --noEmit   → clean (0 errors)
npm test           → 774 passed (85 files)
npm run build      → clean build
```

## Follow-ups

- `app/api/proposals/from-draft/route.ts` (line 74) does not pass `userId` to
  `evaluateTradeProposal`. The route has `userId` in scope — pass it in the
  context as a follow-up hardening to get the authoritative gate benefit there too.
- `strategy.ts:791` similarly should pass `userId` for the revalidation-path call,
  though it already passes the pre-resolved `washSaleLockedSymbols` (so the gate
  works correctly there today).
