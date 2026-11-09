# 2026-06-28 - Help/Data Sources copy cleanup

## Summary

- Made the top Help action easier to notice: visible `Help` text on desktop and
  a `?` fallback on mobile, with the accessible name still `Help`.
- Removed stale Help Overview wording: the welcome sentence, temporary app-name
  branding, `(e.g. Claude)`, and Fintech Studios as a singled-out provider.
- Updated Help -> Tax -> Account Sheltering to remove the leading `though` from
  the parenthetical.
- Updated Help -> Data Sources to use `Keyless / Core`, link source/provider
  names in new tabs, derive the politicians' trades source line from active
  `webSources.congress.sources`, and remove stale Senate/Capitol wording unless
  runtime source keys actually report those feeds.
- Added a Settings -> Connections warning when the selected Green Team model's
  provider key is missing, without restoring any special OpenAI `Required` badge.
- Changed visible app-facing metadata/login/welcome/strategy copy and MCP client
  names to generic dashboard language while the app has no final product name.
- Documented that Help/Data Sources copy should be updated whenever provider,
  source, API-key, account-flow, or user-facing system descriptions change.

## Why

The Help action was too easy to miss, Help content had drifted from the actual
provider/source model, and temporary naming made the app feel Robinhood-specific
or more formally branded than intended.

## Files

- `app/dashboard-client.tsx`
- `app/layout.tsx`
- `app/login/page.tsx`
- `app/strategy/page.tsx`
- `app/welcome/page.tsx`
- `src/lib/mcp-oauth.ts`
- `src/lib/robinhood.ts`
- `src/lib/web-sources/http.ts`
- `test/e2e/dashboard-smoke.spec.ts`
- `docs/alpaca-mcp-vs-api-evaluation.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-20-loose-ends-cleanup.md`
- `docs/rollouts/2026-06-20-main-worktree-relocation.md`
- `docs/rollouts/2026-06-20-project-rename-alignment.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-28-help-data-sources-copy.md`

## Verification

- `npx tsc --noEmit` - passed after merging `origin/main`.
- `npm test` - passed after merging `origin/main`, 153 files / 1,487 tests.
- `npm run build` - passed after merging `origin/main`.
- Local production preview on `http://127.0.0.1:4119/` - passed after merging
  `origin/main`.
- In-app browser desktop Help checks - passed:
  - Help button resolves to one accessible `Help` button.
  - Overview contains `System Help` and `How the System Works`.
  - Overview does not contain `Welcome to`, the old Robinhood-prefixed product
    name, `Agentic Trading`, `(e.g. Claude)`, or `Fintech Studios`.
  - Data Sources contains `Keyless / Core` and derives the politicians' trades
    source line from the active congressional source keys.
  - Data Sources does not contain `Keyless & Core` or `Fintech Studios`, and
    only names Senate/Capitol/Congress.Trade when those source keys are active.
  - All Data Sources links have `target="_blank"` and
    `rel="noopener noreferrer"`.
  - Tax Account Sheltering contains `(losses in taxable accounts still apply)`
    and does not contain `(though losses`.
- In-app browser mobile Help checks at `390x844` - passed:
  - Help action remains one accessible `Help` button.
  - Visible mobile button text is `?`.
  - Button measured approximately `52x44`, large enough for touch.
  - Help modal opens and does not contain the temporary app-name wording.
- GitHub PR smoke initially failed because `test/e2e/dashboard-smoke.spec.ts`
  still expected the temporary app-name text. Updated the smoke assertion to
  expect `Socratic Trade`.
- `npm run test:e2e` using Playwright's managed web server timed out waiting
  for its production server after 240s. Retried against an already-started
  production server with `PLAYWRIGHT_BASE_URL=http://127.0.0.1:4201 npm run test:e2e`
  - passed, 1 test.
- During local preview testing, the shared market-data consent prompt was
  dismissed with `Decline` so the Help button could be exercised without opting
  into shared pooling.

## Follow-ups

- Keep Help/Data Sources copy in the same change as future source/provider/API
  key or account-flow changes.
