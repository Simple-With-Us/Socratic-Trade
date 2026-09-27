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

### Fresh attempt (2026-09-27 ~21:50 UTC, MUSE pick-up)

The first worker left everything uncommitted when its session died.  This attempt:

- Fetched `origin/main` — it had moved +3 commits since the uncommitted work was written (`d0440ed2` now HEAD: #3795 cash-flow HWM review round, #3794 run resilience review round, #3901 EXPLAIN QUERY PLAN doc note).  `AGENTS.md`, `.github/workflows/e2e.yml`, `test/e2e/`, and `playwright.config.ts` were unchanged on main, so those carry over untouched; `STATUS.md` and `docs/EFFORT-LOG.md` had new main-side rows, so the MUSE entries were re-anchored on top of main's current rows (no main content dropped).
- Re-created the local-only wrapper config at `/tmp/st-pw-local2.config.ts` (never committed): self-contained (the first import-from-repo attempt failed — a `/tmp` config cannot resolve the repo's `.ts` base config or `@playwright/test`), `webServer.cwd` pinned to the repo, `snapshotDir` left at Playwright's default (an explicit absolute `snapshotDir` double-nests to `.../visual.spec.ts-snapshots/visual.spec.ts-snapshots/`, which was caught and removed), fleet stock Chrome-for-Testing at `~/workspace/playwright-rollout/browsers/chromium-1243/chrome-linux64/chrome` with `--no-sandbox --disable-dev-shm-usage`.
- Baseline re-generation against latest main + second pass, both via `next dev`: 2 passed / 2 mobile-skipped each time — committed baselines match.
- Re-ran `npx tsc --noEmit` (exit 0), `eslint test/e2e/visual.spec.ts` (clean), `git diff --check` (clean), YAML-parsed the edited `e2e.yml`.
- `next build` NOT attempted locally this round (first attempt: repeated OOM kills under VM memory pressure) — CI `verify` is the gate; do not merge until it is green.

### CI failure diagnosed: local baselines vs CI environment (2026-09-27 ~22:05 UTC)

The PR's first `e2e` CI run FAILED both visual tests: 34,119 px (console) and 12,564 px (login) differed — ratio 0.02 vs the 0.01 budget.  The diff artifacts (uploaded by the new failure-only step, which proved its worth immediately) showed the drift is sub-pixel font antialiasing across ALL text — same font, same layout, same wrapping — not a UI regression.  Root cause: baselines were generated on the dev VM with a different Chromium build, different system fonts, and `next dev`, while CI uses Playwright 1.63's bundled Chromium, ubuntu-latest system fonts, and the production build.  Fix (committed as `ci(e2e)`): `e2e.yml` gained an `update-visual-baselines` workflow_dispatch input; dispatched runs execute `visual.spec.ts --update-snapshots` in the CI environment and upload `test/e2e/visual.spec.ts-snapshots/` as the `visual-baselines` artifact, whose PNGs are then committed normally.  Run 36355028610 (dispatch on the PR branch) succeeded; its artifact PNGs replaced the local baselines.  Standing rule recorded in the workflow: baselines must be regenerated IN CI — local regeneration is not supported for this reason.  The PR then re-ran `e2e` on the committed CI-generated baselines.

## Next Steps & Blockers

- Watch the `e2e` job on the PR (now runs on this PR via the narrow path trigger): if CI's bundled Chromium renders differently from Chrome-for-Testing 153 beyond the 1% pixel budget, regenerate baselines with CI's browser or widen masking.
- Local production build is blocked by VM memory pressure — CI `verify` (`tsc → npm test → npm run build`) is the gate; do not merge until it is green.
- The `/Users/jay/apps/TRADING-EFFORT-LOG.md` live-board mirror could not be updated from this VM (Mac-side file; user requires VM-only work) — flagged for the parent agent.
- No other blockers.

## Zero-Code Findings

- `/tmp` on this VM is a 512M tmpfs shared with other agents' work (one agent's `npm ci` in `/tmp/um-clean` grew to 453M); it hit 100% during this task.  Cleaned only regenerable caches (`node-compile-cache`, prisma engines); left other agents' files alone.  Playwright/Chrome and `next dev` both need /tmp headroom — worth watching on shared-VM Playwright runs.
- `page.route()` aborts browser-initiated requests only; the dev/prod server's own upstream fetches (macro feed) still vary run to run — mask, don't assume hermeticity.
