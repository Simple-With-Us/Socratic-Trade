# EOD close plausibility guard (Congress.Trade share)

## 1. Context & Objective

Board `feab5c88cd6c4fb8`: zero or negative EOD closes must not reach Congress.Trade `price_eod` / per-trade P&L.  CT validates nothing inbound; ST must reject implausible closes on the push path.

## 2. Changes Made

- `ohlcBarsToCloses` already rejected `close <= 0` on `main` (2026-09-27 share guards); this change closes the remaining gap where `dropInvalidShareRows` used wire-level `PriceCloseSchema` / `PriceSeriesSchema`, which accept any number.
- Added `CongressSharePriceCloseSchema` and `CongressSharePriceSeriesSchema` in `src/lib/congress-share.ts` (finite positive `close` on export).
- Regression test in `test/congress-share.test.ts` for `spx` and nested `prices[].closes`.

**Files touched**

- `src/lib/congress-share.ts`
- `test/congress-share.test.ts`
- `docs/rollouts/2026-10-05-eod-close-plausibility-guard.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md`

## 3. Decisions & Trade-offs

- **Shared package:** `PriceCloseSchema` in `@jaywedgeworth22/congress-trading-shared` should gain the same `.finite().positive()` constraint (v2.7.2).  A matching patch is prepared locally on branch `cursor/price-close-positive-4676` (commit `d82daf4`) but could not be pushed from this cloud seat (403 on `jaywedgeworth22/congress-trading-shared`).  Owner should land that tag and bump ST's `package.json` pin; until then ST uses the stricter export schemas above.
- **Whole price series dropped** when any nested close fails the stricter schema (same `filterRows` pattern as other datasets).

## 4. Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/congress-share.test.ts -t "drops spx and price-series"
npm test -- test/congress-share.test.ts -t "ohlcBarsToCloses"
```

```bash
npm run lint          # 0 errors
npx tsc --noEmit      # clean
npm test -- test/congress-share.test.ts -t "drops spx and price-series"  # pass
npm test -- test/congress-share.test.ts -t "ohlcBarsToCloses"           # pass
npm run build         # pass
```

Full `npm test` on cloud VM: 798 files passed; 11 failures in unrelated env-sensitive suites (not congress-share plausibility).

## 5. Next Steps & Blockers

- Publish `congress-trading-shared` v2.7.2 from the prepared shared-repo commit, then replace local export schemas with the shared `PriceCloseSchema` only if desired (behavior should match).
- Board `feab5c88cd6c4fb8` — close after PR review.

## 6. Zero-Code Findings

- `ohlcBarsToCloses` guard was already on `origin/main`; this effort was the schema/filter path for manually built payloads.
