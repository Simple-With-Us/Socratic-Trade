# 2026-08-25 -- Playwright smoke: dismiss ConsentGate before More

## Context & Objective

#3097 taught mobile smoke to open More and assert Scan.  Hosted `Playwright Smoke` stayed red on that merge and on `main` `5a2080cf` (#3093): `more.click()` is intercepted by the first-use ConsentGate overlay.  This change dismisses that gate when it appears so the More/Scan asserts can run.

## Changes Made

After first paint, wait up to 15s for the legal dialog ("Terms, Privacy, and Shared Data"), click Accept & Continue, then keep the #3097 More vs rail Scan logic.

- `test/e2e/dashboard-smoke.spec.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-25-smoke-dismiss-consent.md`

## Decisions & Trade-offs

Did not skip or force-click More through the scrim.  The overlay is real product (fresh smoke DB always needs consent).  Did not pin Scan into the default four mobile tabs.  Did not dispatch `ios-ship.yml` (test/docs only; no `ios/**`).  Did not make `smoke` a required merge check.

## Verification State

- Failed run `32802727800` (`5a2080cf`): `[mobile-chrome]` `locator.click` on `/^More$/` intercepted by `role="dialog"` `aria-labelledby="con-consent-title"`.
- Same class on #3097's own smoke (`32801121251`).
- Merged #3100 squash `1662cdcd`.  Hosted Playwright Smoke `32805872756` on that sha: classify + smoke both success.
- GitHub `verify` on the PR was green (required merge check).  Local Cloud VM vitest was not the gate.

## Next Steps & Blockers

- None for this locator.  TestFlight 1.0.69 remains the iOS binary; this did not ship a new build.
- Optional leftover: set `IOS_TF_RELEASE_NOTES=1` on a future ship step (not this change).

## Zero-Code Findings

`smoke` is not a required merge check (ruleset is `verify` only).  It still runs on every `main` push that is not classified docs-only, so a locator mismatch reds the branch for unrelated merges.
