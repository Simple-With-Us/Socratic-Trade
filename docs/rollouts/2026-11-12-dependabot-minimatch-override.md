# 2026-11-12 minimatch advisory override (ST-4619)

## Context & Objective

The automated dependency security-update lane on `main` failed three times in the last seven days, all on the same minimatch advisory, and no run succeeded.  The updater can see a patched minimatch, but the install still requests 10.x, so the security update cannot be applied and the workflow stays red.  This repository has no `.github/dependabot.yml`; Renovate owns dependency and vulnerability-alert updates (`renovate.json`).

## Changes Made

npm now replaces any minimatch request in `>=7 <11.0.7` with 11.0.8.  That covers GHSA-g3hv-75wg-m249 (`>=7 <11.0.1`, no patched 10.x release) and GHSA-cf2h-pxjq-68xw (fixed in 11.0.7, so the previous glob copy at 11.0.4 was short).  eslint, `@eslint/config-array`, `@typescript-eslint/typescript-estree`, and `@ts-morph/common` only call `Minimatch` or `minimatch()`, which 11.0.8 still exports.  minimatch 3.1.5 stays, because that line is outside both advisories and the v3 consumers were not part of the failed update.

- `package.json`
- `package-lock.json`
- `test/minimatch-advisory-override.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-11-12-dependabot-minimatch-override.md`

## Decisions & Trade-offs

The override is scoped to the vulnerable request range instead of every minimatch copy.  `minimatch@3` does not intersect `>=7 <11.0.7`, so the hoisted 3.1.5 copy is unchanged.  `@isaacs/nonrecursive-glob-match` moved from 1.0.3 to 1.1.0 because minimatch 11.0.8 requires `^1.1.0`.  No secret and no GitHub setting change is required.  This does not merge, and it does not dispatch a deploy.  The lockfile is on Coolify `watch_paths`, so a later merge to `main` still follows the weekday RTH latch.  The guard test imports `semver` directly.  semver 7.8.6 does not ship TypeScript declarations, so `semver` and `@types/semver` are devDependencies.  The override guard accepts an exact version or a range only when that range does not intersect `>=7 <11.0.7` and its minimum is at least 11.0.7, so a range value fails the assertion instead of throwing from `semver.gte`.  Accepted ranges must also be a subset of `>=11.0.7 <12`, so an unbounded `>=11.0.7` cannot float onto a later major.

## Verification State

- `npx vitest run test/minimatch-advisory-override.test.ts test/toolchain-policy.test.ts` passed, 7 tests.
- `npm run lint` passed with 0 errors (869 existing warnings).
- `npx tsc --noEmit` passed.
- `npm audit` reported 0 vulnerabilities, including no minimatch finding.
- `npm test` ran 10289 tests.  10230 passed.  The 18 failures come from ambient provider credentials on this VM, plus the server-metrics local-host case seeing a configured Coolify stats variable.  Re-running those files with key, token, and secret variables removed passed every file except that server-metrics case.
- `npm run build` passed with `NODE_OPTIONS=--max-old-space-size=4096`.  The first attempt died at the default heap limit.


## Next Steps & Blockers

Wait for `verify`.  Do not merge from this lane and do not hand-run the dependency updater or a deploy.  This repository has no `.github/dependabot.yml`; Renovate owns dependency and vulnerability-alert updates (`renovate.json`), so the next Renovate vulnerability-alert pass is the run that should find the vulnerable 10.2.x and 11.0.4 copies gone.  The repo-local confirmation is `npm audit` (0 vulnerabilities, no minimatch finding) plus `test/minimatch-advisory-override.test.ts`, which fails if a resolved minimatch copy is below 3.0.5 or in the unpatched 7 through 11.0.6 advisory range.

## Zero-Code Findings

Playwright Smoke had the longest same-step streak (12) and is already green after PR #5137.  PR Autofix (28) and Sentry CI Report (20) failed in a single hour on 2026-11-09 with no failed step.  CI, Security, Sentry Deploy, and RTH Deploy Latch are not on a current failure streak.  Deploy freshness is out of scope (ST-2793).
