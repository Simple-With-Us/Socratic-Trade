# 2026-07-03 - Console universe index exclusivity

## Summary

- Updated `/console/guardrails` Base indices so overlapping index families replace their peer immediately in the draft.
- Selecting S&P 500 now deselects S&P 100, and selecting S&P 100 deselects S&P 500.
- Selecting Nasdaq Composite now deselects Nasdaq 100, and selecting Nasdaq 100 deselects Nasdaq Composite.
- Added a short hint under the Base indices grid explaining the replacement behavior.

## Why

The original app already treated fully overlapping index choices as mutually exclusive, and the shared universe helper plus API normalizer still enforce that behavior. The new console UI regressed by hand-appending checkbox selections instead of calling `toggleIncludedIndex`, so users could temporarily stage impossible overlapping families until save-time normalization.

## Files

- `app/console/guardrails/page.tsx`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-03-universe-index-exclusivity.md`

## Verification

- `npm run lint` - passed with 0 errors and 303 existing warnings.
- `npx tsc --noEmit` - passed.
- `npx vitest run test/index-universes.test.ts test/console-policy-diff.test.ts` - passed, 23 tests.
- `npm test` - passed, 243 files / 2362 tests.
- `npm run build` - passed.
- Playwright desktop check against `http://localhost:4101/console/guardrails` with the trusted local
  Cloudflare Access header - passed: S&P 100 <-> S&P 500 and Nasdaq 100 <-> Nasdaq Composite replaced
  each other immediately in the draft UI; hint copy was visible. Screenshot:
  `/tmp/universe-index-exclusivity.png`.
- `git diff --check` - passed.

## Follow-ups

- None expected for this slice. The API already normalizes conflicting index arrays; this fix restores matching behavior in the console draft UI.
