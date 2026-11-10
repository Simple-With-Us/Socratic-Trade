# 2026-08-26 -- review-debt leftovers (ios-fleet publish guard + CI)

## Context & Objective

Open PRs #3091, #3095, and #3109 were conflicting or failing on current `main`.  This branch consolidates their fixes: guard `publish-ios-versions.sh` against stale vendored snapshots, run its node:test suite via CI, exclude `scripts/**/*.test.mjs` from vitest, and harden hosted `ios-ship.yml` beta rejection (DEVELOPER_DIR path, `xcodebuild -version` output, macOS beta host).

## Changes Made

- `scripts/ios-fleet/publish-ios-versions.sh` — remote seed, refuse empty apps / key-drop
- `scripts/ios-fleet/publish-ios-versions.test.mjs` — constructed stale fixture (not live file pin)
- `vitest.config.ts` — exclude `scripts/**/*.test.mjs`
- `.github/workflows/ci.yml` — `bash -n` + `node --test` for publisher
- `.github/workflows/ios-ship.yml` — reject beta in `xcodebuild -version` output

## Verification State

- `node --test scripts/ios-fleet/publish-ios-versions.test.mjs` — 4/4
- `bash -n scripts/ios-fleet/publish-ios-versions.sh`
- Full quartet (lint, tsc, vitest, build) before merge

## Next Steps & Blockers

- Close/supersede #3091, #3095, #3109 after this lands.
- Congress.Trade still vendors the unguarded publisher — not fixed here.
