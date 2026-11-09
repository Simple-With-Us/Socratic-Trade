# 2026-06-21 — VIX Yahoo fallback + congress floor + exposure defaults (P0-3, P1-2, P1-7)

## Summary

Three more items from the financial expert panel:

1. **P1-2**: Live VIX from Yahoo Finance when FRED key is absent
2. **P1-7**: Congress `hasNotableWebSignal` signal minimum floor
3. **P0-3**: Tighten default gross/net exposure caps

## What changed

### P1-2 — VIX Yahoo Finance fallback (`src/lib/macro.ts`)

**Why it was wrong:** Without a `FRED_API_KEY`, `fetchMacroData` immediately returned
`asOf: "unavailable"`, making `determineMarketRegime` return "Unknown (no macro feed)".
This disabled the deterministic bear veto's regime-contradiction rule and all
regime-aware sizing/conditioning for users without a FRED key.

**What changed:**
- Added `fetchVixFromYahoo()` — uses the same Yahoo Finance `/v8/finance/chart/%5EVIX`
  endpoint already used for daily OHLC bars (no key required, same `politeFetchJson` +
  `BROWSER_UA` pattern from `history.ts`).
- On success: returns `MacroData` with live VIX and today's `asOf` date; all other fields
  remain at `DEFAULT_MACRO` approximations. VIX is the primary regime axis anyway.
- On failure: falls back to `asOf: "unavailable"` exactly as before.

**Test coverage:** 2 new tests in `cache-provenance.test.ts` — one verifying VIX fetch
success produces a real regime (not "Unknown"), one verifying VIX fetch failure falls
back to "unavailable". Also added 2 tests to `macro.test.ts` covering the light-macro
path. Updated the prior "no network call" test which was invalidated by this change.

### P1-7 — Congress signal floor (`src/lib/market.ts`)

**Why it was wrong:** `hasNotableWebSignal` passed the congress gate with
`(sig.congress?.netSignal ?? 0) > 0` — meaning a single member disclosure (1 buy,
0 sells) could pull a below-cutoff symbol into the candidate set and trigger a rank-lift.
A single member buying is not a notable signal.

**What changed:** Now requires both:
- `buyCount >= 2` — at least 2 distinct members made purchases
- `netSignal >= 2` — net 2+ more buyers than sellers

**Test coverage:** Expanded `hasNotableWebSignal` tests in `market.test.ts` to cover:
single-member rejections, buyCount floor, and the passing cases with adequate signal.

### P0-3 — Tighten default exposure caps (`src/lib/defaults.ts`)

**Why it was wrong:** `DEFAULT_POLICY` had `maxGrossExposurePct: 100` and
`maxNetExposurePct: 100` — both non-binding for a long-only portfolio (100% = fully
deployed). Enforcement code exists but the defaults made it inert.

**What changed:** `maxGrossExposurePct: 100 → 80`, `maxNetExposurePct: 100 → 80`.
Keeps a ≥20% cash buffer by default. Users can raise in policy settings.

## Files touched

- `src/lib/macro.ts` — VIX Yahoo fallback + `fetchVixFromYahoo()` helper
- `src/lib/market.ts` — congress `hasNotableWebSignal` signal floor
- `src/lib/defaults.ts` — tighten gross/net exposure defaults
- `test/macro.test.ts` — +2 light-macro tests
- `test/market.test.ts` — expanded hasNotableWebSignal coverage
- `test/cache-provenance.test.ts` — updated no-key path tests

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — 593 tests, all pass (+20 net new vs session start)
- Commits: `5d25cf5` (VIX + congress), `a2dfa19` (exposure defaults)

## Remaining panel items

- P1-1: Re-derive IC weights from OOS curve vs SPY (needs data, deferred)
- P1-3: Deeper factor orthogonalization — `momentumScore` already de-collinearizes when
  `technicalScore` present; residual overlap is minor
- P1-6: Quantitative turnover cost — qualitative guidance is in the LLM prompt; adding
  a $ estimate requires `unrealizedGain` on `OpenLotTax` which is not currently tracked
- P2-5: Litestream operationalization (infrastructure work)
- P2-6/7: Native Alpaca brackets + Robinhood reconciler
- P2-8: db.ts split + migration ledger
- P2-9: Run-lock approval — ALREADY mitigated: `acquireStrategyLock(userId)` at line 705
  of `strategy.ts` serializes manual approvals against strategy runs via the same lock
