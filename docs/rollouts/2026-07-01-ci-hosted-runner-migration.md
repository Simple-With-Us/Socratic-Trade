# 2026-07-01 - CI hosted-runner migration + concurrency guards

## Summary

- Added `concurrency: { group: ..., cancel-in-progress: true }` to `ci.yml`,
  `security.yml`, and `e2e.yml`, keyed on workflow name + ref, so a new push
  to the same branch/PR cancels its own superseded run instead of queueing
  behind it.
- Moved `ci.yml`'s `verify` job, `security.yml`'s `gitleaks` job, and
  `e2e.yml`'s `smoke` job from `runs-on: [self-hosted, trading-live]` to
  `runs-on: ubuntu-latest`. Added `cache: npm` to the `setup-node` steps in
  `ci.yml`/`e2e.yml`.
- Left `deploy.yml` and `sync-previews.yml` on `[self-hosted, trading-live]`
  unchanged — both operate directly on the production box (PM2 restart,
  local preview-lane sync) and can't move.
- Removed `security.yml`'s "clean stale gitleaks installer temp files" step
  — it existed to work around state persisting across runs on the shared
  self-hosted box; ephemeral hosted runners start clean, so it no longer
  applies.

## Why

- The single `trading-live-mac` self-hosted runner was serializing all CI
  across every branch/PR in the repo (verify/gitleaks/smoke, all three
  jobs, one at a time), causing multi-minute-to-tens-of-minutes queue waits
  even for green, unrelated PRs — observed directly while landing PR #280.
- `verify`, `gitleaks`, and `smoke` have no dependency on the production
  box: `verify` is lint/typecheck/test/build against the checked-out repo;
  `gitleaks` scans the checked-out git history; `smoke`
  (`playwright.config.ts`) builds and serves its own local `next start` on
  `127.0.0.1` and only talks to itself, with a `RUNNER_OS = Linux` branch
  already anticipating a Linux hosted runner. None of the three touch the
  live PM2 process, real broker/production secrets, or the local network —
  unlike `deploy.yml`/`sync-previews.yml`, which do and stay self-hosted.
- The account is now on GitHub Pro, which the owner confirmed makes the
  minute cost of this move acceptable ("trivial cost" was an explicit
  go-ahead). The prior self-hosted-only choice for `verify` had an inline
  comment noting hosted runners can fail before job startup if the
  account's Actions spending limit blocks usage — flagged as a follow-up,
  not fixed here (it's an account billing setting, not a repo change).

## Files

- `.github/workflows/ci.yml`
- `.github/workflows/security.yml`
- `.github/workflows/e2e.yml`

## Verification

- `node -e "require('js-yaml').load(...)"` against all three edited
  workflow files — parses cleanly.
- Not run against real Actions infra in this change (no code/test changes,
  CI config only); the next push to this branch's PR is the live test of
  `verify`/`gitleaks`/`smoke` running green on `ubuntu-latest`.

## Follow-ups

- Confirm the repo/account's GitHub Actions spending limit is > $0
  (Settings → Billing → Plans and usage → Spending limit) — required PR
  status checks failing before job startup due to a $0 limit would block
  all merges. This is the one thing the owner needs to check manually;
  not something a workflow file can fix.
- Watch a week of real Actions-minutes usage on hosted runners
  (`verify`+`gitleaks`+`smoke` across every PR push) against the Pro
  plan's included monthly minutes before assuming the cost stays trivial
  at current PR/push volume.
- If hosted `verify`/`gitleaks`/`smoke` ever regress (flaky infra, slower
  than self-hosted, cost surprise), revert the `runs-on:` line back to
  `[self-hosted, trading-live]` per job — each is independently reversible.
