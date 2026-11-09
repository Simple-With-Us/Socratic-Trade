# 2026-07-23 — Cleanup Caches Runner Fix

## Summary
Fixed a CI failure in `.github/workflows/cleanup-caches.yml` by retargeting the jobs from `[self-hosted, socratic-ci]` to `ubuntu-latest`.

## Why
A recent CI change (retargeting workflows to self-hosted runners to bypass a billing block on hosted runners) inadvertently broke `cleanup-caches.yml`. The self-hosted Coolify runners do not have the GitHub CLI (`gh`) installed globally, which is required by both the `delete-pr-caches` and `prune-stale-caches` jobs. Because `cleanup-caches.yml` operates purely via the GitHub API (via `gh`) and doesn't require any app builds or local runner state, it can safely and freely run on `ubuntu-latest` without consuming our self-hosted runner concurrency.

## Files Touched
- `.github/workflows/cleanup-caches.yml`: Switched `runs-on` from `[self-hosted, socratic-ci]` to `ubuntu-latest`.

## Verification
- Verified the failure in PR #1978 logs (`gh: command not found`).
- Ran `scripts/land.sh` to trigger the CI validation pipeline.

## Follow-ups
- Ensure `cleanup-caches.yml` runs successfully on the next PR closure.
