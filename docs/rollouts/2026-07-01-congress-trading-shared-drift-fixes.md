# 2026-07-01 - congress-trading-shared drift fixes

## Summary

- `congress-trade-client.ts` now imports the shared `MAX_REFS_BATCH` constant
  from `@jaywedgeworth22/congress-trading-shared` instead of a locally
  hardcoded `MAX_REFS_PER_REQUEST = 500`.
- Removed the unused `src/lib/congress-shared-aliases.ts`. It re-exported
  `CongressRef = SecurityRef` (the shared package's full, nullable read
  shape), which conflicted in shape with the `CongressRef` interface
  actually used everywhere else (defined locally in `congress-share.ts`,
  with optional rather than nullable fields). Nothing imported the file.
- Added `.github/workflows/shared-package-pin-check.yml`: a weekly (Mondays)
  + manual job that compares this repo's git-pinned
  `congress-trading-shared` commit against that repo's `main` and posts a
  `::warning::` annotation (never fails the build) when behind. A follow-up
  commit hardened the dependency-spec parsing so it no-ops (rather than
  comparing against a garbage SHA) if the dependency is ever migrated to a
  semver range instead of a git `#sha` pin.

## Why

- A cross-app dependency review (Congress.Trade + Agentic Trading both
  consume `congress-trading-shared`) found several places where a shared
  constant or type was duplicated locally instead of imported, and a dead
  file whose type alias would silently conflict with the one actually in
  use if anyone ever imported it. Fixing the duplication removes a source
  of future drift; the new workflow makes it visible if the pinned commit
  falls behind upstream, since there was previously no automated signal for
  that.
- The workflow uses the existing `GH_PACKAGES_TOKEN` repo secret (added
  2026-06-30, distinct from `CONGRESS_TRADING_SHARED_DEPLOY_KEY`, which is
  an SSH deploy key used for `npm ci`/git-URL installs and can't make
  GitHub REST API calls). `GH_PACKAGES_TOKEN` is a PAT with read access to
  `jaywedgeworth22/congress-trading-shared` for this API-level check.

## Files

- `src/lib/congress-trade-client.ts`
- `src/lib/congress-shared-aliases.ts` (deleted)
- `.github/workflows/shared-package-pin-check.yml`

## Verification

- `npx tsc --noEmit` (repo root, full project) — passes
- Manual dry-run of the dependency-spec parsing logic for both a
  `git+https://...#sha` value and a `^1.0.0` semver value — confirmed the
  git-pinned case extracts the SHA and the semver case now skips with a
  notice instead of comparing against the literal string `undefined`
  (found via Congress.Trade PR #124 review, since Congress.Trade's
  `package.json` had separately migrated to registry/semver consumption)

## Follow-ups

- `workflow_dispatch` can't be tested until this workflow file lands on
  `main` (GitHub only allows manual dispatch for workflows present on the
  default branch) — verify the weekly run once merged, and confirm
  `GH_PACKAGES_TOKEN` actually has enough scope for the `gh api
  repos/.../commits/main` and `.../compare/...` calls it makes.
- Congress.Trade PR: https://github.com/jaywedgeworth22/Congress.Trade/pull/124
