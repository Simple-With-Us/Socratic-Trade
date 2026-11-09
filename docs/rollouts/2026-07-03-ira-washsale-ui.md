# 2026-07-03 - IRA wash-sale UI correction

## Summary

- Changed Settings -> Tax treatment for Roth/traditional IRA accounts so same-IRA wash sales are shown as ignored/not applicable instead of presenting the taxable-account Block / Ask / Auto control.
- Exposed the existing IRA-specific `taxSettings.iraWashSaleHandling` setting in IRA mode as the only actionable wash-sale choice: block cross-account IRA replacement buys by default, or explicitly ignore/disregard them with the audit annotation.
- Changed Guardrails -> Tax rules to show taxable-account wash-sale handling only for taxable accounts and IRA taxable-loss rebuy handling only for IRA accounts.
- Updated settings search and glossary copy so Roth/IRA/ignore phrasing routes to the IRA-specific control.

## Why

The prior UI mixed two separate concepts. A same-account Roth/traditional IRA wash sale has no taxable loss deduction to protect, so Block / Ask / Auto is the wrong mental model. The existing backend still keeps the important cross-account case: an IRA replacement buy after a taxable account sold the same symbol at a loss is blocked by default, or can be explicitly disregarded with the visible audit note.

## Files

- `app/console/guardrails/field-defs.ts`
- `app/console/guardrails/page.tsx`
- `app/console/settings/page.tsx`
- `app/console/settings/help.tsx`
- `app/settings-search.ts`
- `test/console-policy-diff.test.ts`
- `test/settings-search-index.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-03-ira-washsale-ui.md`

## Verification

- `npm run lint` - passed with 0 errors and 303 existing warnings.
- `npx tsc --noEmit` - passed.
- `npx vitest run test/console-policy-diff.test.ts test/settings-search-index.test.ts test/ira-washsale-api.test.ts test/washsale-modes.test.ts` - passed, 84 tests.
- `npm test` - passed, 243 files / 2362 tests.
- `npm run build` - passed.
- `git diff --check` - passed.
- `pm2 restart trading-codex --update-env` - passed after build regenerated `.next`.
- Playwright desktop check against `http://localhost:4101/console/settings` with the trusted local
  Cloudflare Access header - passed after switching the unsaved Account type select to Roth IRA:
  the page shows "Same-IRA wash sales", "not applicable", and "Taxable-loss rebuy inside this IRA";
  the taxable-account wash-sale guard is hidden. Screenshot: `/tmp/ira-washsale-settings.png`.

## Follow-ups

- None expected for this slice. A future account-management endpoint could let the owner edit a connected account's saved taxation type directly; this UI intentionally treats connected-account taxation as read-only because that is how the current policy resolution works.
