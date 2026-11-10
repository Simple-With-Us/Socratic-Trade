# 2026-07-23 Gemini Reasoning Temp

## Summary
Updated the regex logic in `src/lib/model-identity.ts` for strict model ID canonicalization and fixed the failing test cases around `model-rotation.ts` that were affected by the recent `-latest` suffix changes. Also updated test fixtures in `usage-compliance-classifier.test.ts` to ensure the classifier correctly asserts traces in the OpenRouter dispatch path. Fixed the native node bindings for `better-sqlite3` on Node v24 in order to land the PR.

## Why
Models with the `-latest` suffix were improperly grouped or stripped, breaking rotation logic that expects strict catalog keys. Tests also needed updating to assert these canonical keys. Furthermore, `usage-compliance-classifier.ts` traced OpenRouter keys directly, which caused `TypeError: Cannot read properties of undefined` if the traces didn't cleanly map to the expected provider.

## Files Touched
- `app/console/settings/learning-review.tsx` (Settings UI label updates)
- `app/admin/layout.tsx` (Admin layout back button updates)
- `src/lib/model-identity.ts` (Model canonicalization)
- `test/console-models.test.ts` (Model grouping assertions)
- `test/model-rotation.test.ts` (Pool rotation logic tests)
- `test/usage-compliance-classifier.test.ts` (Trace fixture updates)

## Verification
- Clean run of `npm rebuild better-sqlite3` under Node 24 (`/opt/homebrew/opt/node@24/bin/node`).
- Clean run of `bash scripts/land.sh` verifying all tests (5267 passed).
- Build succeeded.
- Pushed and updated PR #1978.

## Follow-ups
Investigate infrastructure health monitor reporting 0% CPU and network usage, likely due to a suspected Cloudflare R2 restriction.
