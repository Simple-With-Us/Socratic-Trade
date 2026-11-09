# 2026-06-30 - Audit log, Robinhood quote params, and Settings polish

## Summary

- Fixed the Robinhood MCP quote call that caused the 2026-06-30 01:33 test-account strategy run to log `invalid params`.
- Added a regression proving `get_equity_quotes` is called with only `symbols`.
- Added strategy LLM step audit rows for Bull/Green and Bear/Red model calls, including provider, model, transport, key source, status, and proposal count.
- Reworked Activity/Audit formatting so strategy diagnostics render as short plain-language summaries with full hover text instead of clipped raw JSON.
- Preserved serialized payload fallback text for generic audit kinds that do not have a compact summary field, keeping rows like notification preference updates diagnosable instead of rendering only `Event recorded`.
- Scoped dashboard audit/run history to the selected connected account while retaining user-wide/system audit rows in account views.
- Polished the Settings modal split between User and Account scope with a clearer header, account picker, tabs, auto-resume row, model card, and notification grid.

## Why

The Robinhood test-account run completed with 0 proposals because the quote tool
rejected request params before Robinhood quotes could contribute to the scan. The
app was sending `account_number` to `get_equity_quotes`; the MCP schema accepts
`symbols` only. The audit UI then made the problem harder to diagnose because the
important details were clipped JSON snippets.

The UI review recommendation was to keep one operator Activity stream but make it
account-aware: filter by the selected account by default, label rows with the
account, and include user-wide system rows so account context is not isolated from
global settings and scheduler events.

## Files

- `src/lib/robinhood.ts`
- `test/robinhood-mcp.test.ts`
- `src/lib/strategy.ts`
- `src/lib/dashboard-feed.ts`
- `src/lib/dashboard.ts`
- `src/lib/db-learning.ts`
- `src/lib/db-execution.ts`
- `src/lib/types.ts`
- `app/dashboard-types.ts`
- `app/dashboard-client.tsx`
- `app/ui/primitives.tsx`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-30-audit-log-strategy-ui.md`

## Verification

- `bash scripts/npm-ci-with-shared-deps.sh` - installed dependencies in the fresh worktree. npm reported 2 moderate audit findings and allow-scripts review warnings for install-script packages; no install failure.
- `npm run lint` - passed with 0 errors and the existing warning backlog.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 159 files / 1539 tests.
- `npm run build` - passed. Next emitted the existing middleware-to-proxy deprecation warning.
- `npm test -- test/dashboard-feed.test.ts -t "preserves generic audit payload details when no compact field is available"` - passed after the final Codex review-thread fix.
- `npm test -- test/dashboard-feed.test.ts` - passed, 14 tests.
- `npx tsc --noEmit --pretty false` - passed after the final Codex review-thread fix.

## Follow-ups

- Consider adding an explicit account filter control to the Activity drawer if operators often need cross-account comparisons without switching the active account.
- Consider adding an expanded-detail affordance for audit rows beyond native hover titles if mobile inspection of long lines becomes important.
