# 2026-06-29 - Self-hosted CI while GitHub billing is blocked

## Summary

- Moved the required `verify` job from GitHub-hosted `ubuntu-latest` to the
  existing self-hosted `trading-live` runner.
- Moved Playwright smoke and gitleaks Security checks to the same runner.
- Added same-repo PR guards so untrusted fork PRs do not execute on the
  production Mac.
- Changed those guards to fail the required jobs before checkout for fork PRs
  and bot-authored PRs, instead of skipping jobs that GitHub can count as
  successful.
- Disabled the `actions/setup-node` npm cache in CI and smoke; on the
  self-hosted runner the meaningful steps passed but the cache post-action
  cleanup wedged before the job could complete.
- Made Playwright browser installation OS-aware: Linux uses `--with-deps`,
  macOS installs Chromium only.
- Pinned `gitleaks/gitleaks-action` to
  `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e` before running it on the
  self-hosted runner.
- Added a preflight cleanup for stale `${TMPDIR}/gitleaks.tmp`, which can be
  left behind on the long-lived macOS runner and cause the pinned action's
  installer to fail before scanning.

## Why

PR #225 passed the local landing gate, but GitHub-hosted Actions failed before
running any workflow steps. Check-run annotations for `verify`, `smoke`, and
`gitleaks` all reported:

`The job was not started because recent account payments have failed or your spending limit needs to be increased.`

The repo already has an online self-hosted runner named `trading-live-mac` with
labels `self-hosted`, `macOS`, `trading-live`, and `ARM64`; Deploy and preview
sync already use it successfully.

## Files

- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/security.yml`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-29-self-hosted-ci-billing-block.md`

## Verification

- `npx tsc --noEmit` - passed.
- `npm test` - passed, 155 files / 1,494 tests.
- `npm run build` - passed; Next.js emitted the existing middleware-to-proxy deprecation warning.
- Remote CI attempt on the self-hosted runner completed lint, typecheck, tests,
  and build, then hung in `actions/setup-node` post-action cleanup with npm
  caching enabled; cache was removed before re-running PR checks.
- `git ls-remote https://github.com/gitleaks/gitleaks-action.git refs/tags/v3`
  resolved the pinned `v3` action commit SHA.
- Main Security run `28349078730` failed after PR #225 merged because the
  pinned action refused to overwrite `${TMPDIR}/gitleaks.tmp` on the macOS
  runner; the workflow now removes that stale download file before invoking
  gitleaks.
- PR #224 refreshed run confirmed `verify` passed on the self-hosted runner;
  its `gitleaks` retry hit the same stale temp-file installer failure before
  scanning, which this workflow cleanup addresses.

## Follow-ups

- If GitHub billing/spending limits are fixed and GitHub-hosted runners are
  preferred again, revert the `runs-on` values in CI, Playwright Smoke, and
  Security back to `ubuntu-latest`.
- Keep the same-repo guard if any self-hosted PR workflow remains enabled.
