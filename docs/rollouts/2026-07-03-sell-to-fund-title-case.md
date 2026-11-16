# 2026-07-03 - Sell to Fund Buys title-case copy fix

## Summary

Updated the visible Sell to Fund Buys selector copy so brief UI labels and
options use Title Case instead of raw lowercase enum values.

## Why

The Guardrails Sell to Fund Buys options were rendered as `off`, `suggest`,
`propose (asks you)`, and `automated`, which looked inconsistent beside nearby
option labels and headings. The legacy dashboard had more descriptive labels,
but several option fragments were still sentence case.

## Files

- `app/console/guardrails/page.tsx`
- `app/console/lib/policy-diff.ts`
- `app/dashboard-client.tsx`
- `test/console-policy-diff.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-03-sell-to-fund-title-case.md`

## Verification

- `npx vitest run test/console-policy-diff.test.ts`
- `npm run lint` (0 errors, 303 existing warnings)
- `npx tsc --noEmit`
- `npm test` (243 files / 2362 tests)
- `npm run build`
- `git diff --check`
- `pm2 restart trading-codex --update-env`
- Playwright against `http://localhost:4101/console/guardrails` with the
  trusted local Cloudflare Access header:
  - field label visible: `Sell to Fund Buys`
  - hint visible: `Off = Never.`
  - option labels visible in Title Case:
    `Off — Never Sell to Fund`, `Suggest Only (No Orders)`,
    `Propose Sells for Approval`, `Automated — Sell to Fund`

## Follow-ups

- None expected.
