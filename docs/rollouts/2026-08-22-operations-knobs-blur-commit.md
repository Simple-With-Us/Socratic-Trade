# 2026-08-22 Admin Operations Knobs Blur-Commit and Empty-Default Fallback Fix

## Context & Objective
- **Issue:** #2958 ("Admin > Operations knobs PATCH on every keystroke and write each knob's default on an emptied field")
- **Root Cause:** In `app/admin/operations/operations-client.tsx`, numeric knobs were wired with `onValueChange={(n) => { if (Number.isFinite(n) && n !== Number(row.value)) void save(row.id, n); }}` with `emptyValue={Number(row.defaultValue) || 0}`.  This caused two critical defects:
  1. A PATCH request on every keystroke (e.g. typing `120` sent `1`, then `12`, then `120`).
  2. Clearing a field immediately fed `defaultValue` into `onValueChange` and committed it as a real server setting.
  Additionally, related numeric inputs in `app/console/strategy/tax-settings.tsx`, `app/console/settings/learning-review.tsx`, and `app/console/strategy/page.tsx` were passing coerced fallbacks into draft state on empty/cleared inputs, causing accidental fallback commits on blur.
- **Goal:** Unify all four numeric form surfaces (`OperationsClient`, `TaxSettingsCard`, `LearningReviewCard`, `StrategyPage` scoring weights) to follow the blur-commit, no-fallback-on-empty pattern with pure testable resolver functions in `app/console/lib/number-commit.ts`.

## Changes Made
- **`app/console/lib/number-commit.ts`:**
  - Added `resolveServerKnobNumberCommit(raw, committed, min, max)` to sanitize and clamp server operations knob commits.
  - Added `resolveTaxRateCommit(raw, committed)` to clamp tax rate percentages to `[0, 100]` without committing on blank text.
  - Added `resolveLearningReviewNumberCommit(raw, committed, min)` to floor learning review thresholds/days at `min` (default 1) without committing on blank text.
  - Added `resolveScoringWeightCommit(raw, committed)` to floor scoring weights at `0` without committing on blank text.
- **`app/admin/operations/operations-client.tsx`:**
  - Added `numberDrafts` raw draft state.
  - Replaced per-keystroke `save` with `commitNumberRow` on blur routing through `resolveServerKnobNumberCommit`.
- **`app/console/strategy/tax-settings.tsx`:**
  - Added `rawRates` raw draft state.
  - Replaced blur handler with `commitRate` routing through `resolveTaxRateCommit`.
- **`app/console/settings/learning-review.tsx`:**
  - Added `rawDrafts` raw draft state.
  - Replaced blur handler with `commitNumber` routing through `resolveLearningReviewNumberCommit`.
- **`app/console/strategy/page.tsx`:**
  - Switched `weightsOverlay` to string-based `weightsDrafts`.
  - Replaced `commitWeight` with `resolveScoringWeightCommit` routing.
- **`test/console-settings-number-commit.test.ts`:**
  - Added unit test suites verifying all resolver functions handle empty/whitespace/unparseable text, unchanged values, boundary clamping, and zero-fallback-on-empty guarantees.
  - Added AST/regex source checks ensuring all four target files strictly use blur-commit and route through their designated resolvers.

## Decisions & Trade-offs
- Pure commit resolvers are centralized in `app/console/lib/number-commit.ts` so they can be unit-tested in isolation without importing Next.js page modules (which have strict export signatures).

## Verification State
- `npm run lint`: passed (0 errors, 776 grandfathered warnings).
- `npx tsc --noEmit`: passed with 0 errors.
- `npx vitest run test/console-settings-number-commit.test.ts`: passed (26/26 tests).
- `npx vitest run test/console-*.test.ts`: passed (304/304 tests across 26 files).
- `npm run build`: passed (clean Next.js production build).

## Next Steps & Blockers
- Merge PR #2958 with auto-merge.
- Continue with next prioritized items in the autonomous queue.
