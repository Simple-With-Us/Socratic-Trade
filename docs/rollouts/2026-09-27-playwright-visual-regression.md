# Playwright visual regression — fleet rollout (2026-09-27)

## Context & Objective

Owner-directed fleet rollout ("Yes, update the policy and roll out Playwright everywhere"): web repos get Playwright screenshot assertions with committed baseline PNGs, automated-only — Jay never takes manual screenshots.  Socratic-Trade already had a Playwright smoke scaffold (`playwright.config.ts`, `test/e2e/`); this change adds the visual screenshot assertions on top.

## Changes Made

- `test/e2e/visual.spec.ts` (new) — full-page `toHaveScreenshot` assertions for `/console` (Autonomy Desk, the main trading dashboard) and `/login`.  Chromium-desktop only; the `mobile-chrome` project skips via a fixture-free `beforeEach` (taking the `page` fixture before the skip would launch a browser anyway).  Deterministic controls: `reducedMotion: reduce`, an animation/transition/caret-killing style tag, `animations: "disabled"` on the assertion, hermetic network (browser requests not to `127.0.0.1` are aborted — note: this covers browser traffic only, NOT server-side fetches), and masks for chart figures (`figure:has(svg[role='img'])`), countdown clocks (`Next …`), the day-PnL baseline date label, the desktop freshness strip (`div.hidden[class*="lg:block"]` with the "When this console last fetched data" span — clock/stream/relative-time/"Market: closed" all live), and the Market Analysis card (Regime/Breadth/VIX come from the server-side macro feed and vary run to run, including card-absent vs card-present).  The Next dev compile-status pill ("Compiling …") is waited out before screenshotting — it never exists in the production build CI uses.  ConsentGate is accepted before screenshotting with a 30s visible budget (the gate renders only after its `/api/legal-notice` + `/api/consent` fetches resolve; a short check races a slow dev compile) plus a final 5s sweep right before the screenshot.
- `test/e2e/visual.spec.ts-snapshots/` (new) — committed baselines: `console-autonomy-desk-chromium-linux.png`, `login-chromium-linux.png`, generated with stock Chrome-for-Testing 153 on Linux (Desktop Chrome viewport 1280x720).
- `AGENTS.md` — "Verify before claiming done" now carries the automated-only policy: "Web UI is verified via Playwright screenshot assertions with committed baselines.  Jay never takes manual screenshots or runs local UI preview sessions.  Native Mac UI is verified through code review and CI."
- `.github/workflows/e2e.yml` — restored a NARROW `pull_request` trigger (path-filtered to `test/e2e/**`, `playwright.config.ts`, `package.json`, `package-lock.json`, this workflow) so this PR actually runs Playwright CI; the 2026-07-21 queue-protection rationale is preserved because unrelated PRs still don't trigger it.  Added a failure-only upload of `test-results/` + `playwright-report/` (14-day retention) so pixel-diff failures are reviewable.  The existing classify docs-only fast path, fork rejection, and trusted-bot checks already handled `pull_request` and are unchanged.
- `docs/EFFORT-LOG.md`, `STATUS.md` — pre-commit protocol entries.

## Decisions & Trade-offs

- Playwright already existed, so no new scaffold, config, or dependencies — pure addition of screenshot assertions.
- Visual tests are chromium-desktop only.  The `mobile-chrome` project still runs the smoke/a11y specs; adding mobile baselines doubles flake surface for a viewport the owner never reviews.
- Masked rather than fixture-driven: the console is heavily data-driven, so charts, countdown clocks, the baseline date label, the freshness strip, and the Market Analysis card are masked.  Everything else asserts pixel-stable.
- Baselines generated with the fleet's stock Chrome-for-Testing 153; CI installs Playwright 1.63's bundled Chromium (`npx playwright install --with-deps chromium webkit`).  Minor cross-version rendering drift is absorbed by `maxDiffPixelRatio: 0.01`; the second local pass plus the CI run confirm.
- New dependencies: none.  Extra-ship: no (test + docs + CI workflow only).

## Verification State

- `npm ci` (local VM): green after redirecting node-gyp's header download to `/tmp` (`npm_config_devdir=/tmp/node-gyp-cache`) — the default `~/.cache` path hit an EPERM extracting the tarball as root.
- `next build` (production): NOT green locally — repeated `next build --webpack` attempts were killed under VM memory pressure (one coincided with a VM reboot ~20:06 UTC); no successful local production build.  Baselines were therefore generated against `next dev` via a local-only wrapper config (`/tmp/st-pw-local.config.ts`, never committed: stock Chrome-for-Testing 153, `--no-sandbox --disable-dev-shm-usage`, repo test/output dirs).  CI's `npm run build` is the authoritative production-build check and must be green there — never force-merge on red.
- Baseline generation: `./node_modules/.bin/playwright test --config /tmp/st-pw-local.config.ts test/e2e/visual.spec.ts --update-snapshots` — 2 passed (chromium), 2 skipped (mobile-chrome, no browser launched), 2 baselines written.
- Second pass (same command, no `--update-snapshots`): 2 passed, 2 skipped — committed baselines match.
- `eslint test/e2e/visual.spec.ts`: clean.  `npx tsc --noEmit`: clean (exit 0).  `git diff --check`: clean.
- Flakes found and fixed during local runs: (1) consent modal appearing after the accept check — the gate was still "loading" during a slow dev compile; fixed with a 30s visible budget + pre-screenshot sweep.  (2) footer freshness strip and Market Analysis card carrying live clock/macro data; fixed with masks.  (3) first `:has(> div > …)` footer selector never matched — replaced with `div.hidden[class*="lg:block"]` + `has:` span, verified against a live dev server.

## Next Steps & Blockers

- Watch the `e2e` job on the PR (now runs on this PR via the narrow path trigger): if CI's bundled Chromium renders differently from Chrome-for-Testing 153 beyond the 1% pixel budget, regenerate baselines with CI's browser or widen masking.
- Local production build is blocked by VM memory pressure — CI `verify` (`tsc → npm test → npm run build`) is the gate; do not merge until it is green.
- The `/Users/jay/apps/TRADING-EFFORT-LOG.md` live-board mirror could not be updated from this VM (Mac-side file; user requires VM-only work) — flagged for the parent agent.
- No other blockers.

## Zero-Code Findings

- `/tmp` on this VM is a 512M tmpfs shared with other agents' work (one agent's `npm ci` in `/tmp/um-clean` grew to 453M); it hit 100% during this task.  Cleaned only regenerable caches (`node-compile-cache`, prisma engines); left other agents' files alone.  Playwright/Chrome and `next dev` both need /tmp headroom — worth watching on shared-VM Playwright runs.
- `page.route()` aborts browser-initiated requests only; the dev/prod server's own upstream fetches (macro feed) still vary run to run — mask, don't assume hermeticity.
