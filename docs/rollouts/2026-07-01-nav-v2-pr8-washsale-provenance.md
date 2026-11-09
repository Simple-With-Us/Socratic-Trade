# 2026-07-01 — NAV_V2 PR #8: wash-sale provenance return-type + Test-account filter

Branch: `claude/settings-navigation-redesign-a3k1yv-mce45j` (stacked on PR #7 in **PR #310**). Phase 5.
**⚠️ Touches the authoritative wash-sale enforcement gate — real-money tax safety.**

## Summary
Gives the cross-account wash-sale lockout **per-symbol provenance** (contributing account + clear date) so
the Approvals card (PR #11) can name the culprit, and **excludes Test/sim accounts** from contribution so a
simulated loss can never lock a real taxable account — **without weakening the enforcement gate**.

## Design decision: parallel provenance accessor (keep the Set gate byte-identical)
The plan offered two options: change the return type to a `Map` (compile-time-breaking), or **keep the `Set`
and add a parallel provenance accessor**. For an authoritative real-money gate the second is strictly safer,
so `src/lib/tax.ts`:
- New **`WashSaleLock` / `WashSaleLockMap`** (`{ account, clearDate }`) and provenance functions
  `getWashSaleLockProvenance` (per-account), `getWashSaleLockProvenanceForUser`,
  `getUserWashSaleLockProvenance` (user-level). `clearDate` = the **binding** loss's exit + 30 days (a symbol
  stays locked until the most recent contributing loss ages out).
- The existing **Set-returning** functions (`getWashSaleLockedSymbols`,
  `getWashSaleLockedSymbolsForUser`, `getUserWashSaleLockedSymbols`) are now **projections of the provenance
  map** (`new Set(map.keys())`) — one source of truth, no drift. Their `Set<string>` shape is unchanged, so
  the enforcement gate (`policy.ts:319-322`, `.has(symbol)`) and `strategy.ts` consumers are **byte-identical
  — the gate is never weakened**.
- **Test-leak fixed:** `getUserWashSaleLockProvenance` now `filter(a => a.broker !== "test")` before resolving
  contributions. (Previously Test was mapped to the `"paper"` source and included, so a simulated loss could
  lock a real account.)

## Consumers touched
No production consumer needed a shape change (Set return types preserved). Only the internal wiring in
`tax.ts` changed; `policy.ts` / `strategy.ts` untouched.

## Tests
- `washsale-test-account-excluded.test.ts` — a Test-account loss does NOT lock; a REAL taxable loss DOES;
  with both, only the real symbol locks. **[WASH-SALE] checklist test.**
- `washsale-provenance.test.ts` — locked symbol carries `{ account, clearDate }`; the binding (latest) loss's
  clear date wins; the enforcement Set equals the provenance map's keys (no drift).
- Updated `chat-draft-policy.test.ts` "does not stage a wash-sale-blocked buy draft": the loss now lives in a
  **real (Alpaca) taxable account** (Test is excluded from contribution), while the active account stays Test
  so the from-draft route resolves the local-sim gateway (no broker creds in tests). Still asserts the 409
  POLICY_BLOCKED — so the from-draft wash-sale block coverage is preserved and now uses a valid premise.

## Do-not-break checklist
- **[WASH-SALE]** enforcement gate stays authoritative (Set shape unchanged, `.has` path untouched);
  Test-exclusion test added. ✓
- **[EXEC-MODE]** N/A. Others N/A.

## Verification
`tsc` clean · `lint` 0 errors · `npm test` 212 files / 2090 tests (+2 files / +5, +1 updated) · `build` success.

## Rollback / safety
The Test-exclusion is a *behavior fix* (removes a leak); a revert restores the Test→real leak, so prefer
forward-fix. The provenance additions are purely additive (the Approvals UI in PR #11 consumes them).
