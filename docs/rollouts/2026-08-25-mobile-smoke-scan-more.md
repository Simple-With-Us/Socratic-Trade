# 2026-08-25 -- Playwright mobile-chrome smoke: Scan is in More

## Context & Objective

Playwright `smoke` went red on `main` after #3090 and again after docs #3096.  Both failures are the same: `[mobile-chrome] dashboard loads the core trading workspace` expected `getByText("Scan").first()` to be visible.  That is not a TestFlight or docs regression.  Default mobile tabs are Home / Proposals / Activity / Orders (`MOBILE_TABS_MAX=4`); Scan is behind the More sheet.  `getByText("Scan").first()` matched the desktop rail's hidden `<span class="flex-1">Scan</span>` (`hidden lg:flex`).

## Changes Made

Smoke now uses role queries (hidden nodes skipped).  If the More tab-bar button is visible, open it and assert the Scan link inside the More dialog.  Otherwise assert Scan on the visible console rail.

- `test/e2e/dashboard-smoke.spec.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-25-mobile-smoke-scan-more.md`

## Decisions & Trade-offs

Did not pin Scan into the default four mobile tabs.  That default is owner-set.  The smoke test should follow the overflow pattern, not fight it.  Did not skip smoke on docs-only `main` pushes in this change.

## Verification State

- Compared failed runs `32796078312` (#3090) and `32797990523` (#3096): identical `Scan` hidden / `<span class="flex-1">`.
- Did not run Playwright in this Cloud VM (needs `next build` + browsers).  Hosted `Playwright Smoke` on merge to `main` is the gate.

## Next Steps & Blockers

- After merge, confirm `Playwright Smoke` on `main` is green.
- TestFlight 1.0.69 remains installable; this does not ship a new iOS binary.

## Zero-Code Findings

`smoke` is not a required merge check (ruleset is `verify` only).  It still runs on every `main` push, including docs, so a locator mismatch reds the branch for unrelated merges.
