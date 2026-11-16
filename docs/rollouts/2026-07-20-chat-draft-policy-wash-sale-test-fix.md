# Rollout Note: 2026-07-20 Chat Draft Policy Wash Sale Test Fix

## Summary
Fixed a date-dependent wash sale test flake in `test/chat-draft-policy.test.ts`.

## Why
The test `does not stage a wash-sale-blocked buy draft` was failing because it used hardcoded dates (`2026-06-01` and `2026-06-20`). Since today is exactly 30 days later (`2026-07-20`), the wash sale window had expired, causing the draft staging to succeed (201) instead of being blocked (409). Using relative dates resolves this drift.

## Touch Files
- `test/chat-draft-policy.test.ts` (replaced hardcoded dates with relative date helper `daysAgo`)

## Verification
- Ran vitest locally in the main workspace:
  ```bash
  export PATH=/opt/homebrew/opt/node@24/bin:$PATH
  npx vitest run test/chat-draft-policy.test.ts
  ```
  Result: 10/10 tests passed successfully.
