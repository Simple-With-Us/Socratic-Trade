# ST-4613: iOS ship PATH, What to Test clock, and cache key

## Context & Objective

Three confirmed defects on `main` can break or mis-stamp a TestFlight ship.  Homebrew `rsync` 3.5.1 ahead of `/usr/bin` makes `xcodebuild -exportArchive` fail with `--extended-attributes: unknown option`.  The What to Test clock still prints `1:15 AM CT`.  The last-ship cache key omits `github.run_attempt`, so a retry cannot replace a stale save.

## Changes Made

System binaries now come first on `PATH`, matching Usage-Monitor.  `centralTimestamp()` folds the Intl space or U+202F, uses lowercase `am`/`pm`, and drops the timezone suffix, matching Usage-Monitor #1693.  The ship workflow splits cache restore and save and puts `github.run_attempt` in the key, following DealDex, while keeping the `ios-fleet-socratic-` prefix so older entries still restore.

- `scripts/ios-fleet/ship-testflight.sh`
- `scripts/ios-fleet/asc-api.mjs`
- `scripts/ios-fleet/asc-api.timestamp.test.mjs`
- `scripts/ios-fleet.sha256`
- `.github/workflows/ios-ship.yml`
- `.github/workflows/ci.yml`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

The cache key prefix stays `ios-fleet-socratic` rather than DealDex's `ios-fleet-state-*` name, so restore-keys still match entries saved before this split.  `centralTimestamp` is exported so the unit test can call it.  No ship workflow was dispatched, and `--force-ship` was not used.  No phase doc covers this ship tooling, and `docs/deployment.md` does not describe the PATH or the cache key.

## Verification State

```bash
node --test scripts/ios-fleet/asc-api.timestamp.test.mjs
bash scripts/ios-fleet/test-ship-seq.sh
node --test scripts/ios-fleet/*.test.mjs
bash scripts/ios-fleet/test-asc-credentials.sh
bash scripts/ios-fleet-pin.sh --check
actionlint .github/workflows/ios-ship.yml .github/workflows/ci.yml
```

`centralTimestamp(2026-08-12T06:15:00Z)` is `Wed, Aug 12, 2026 at 1:15am`.  Ship-seq passed 129.  The node fleet tests passed 99.  The credential script passed.  The pin check passed.  `actionlint` 1.7.7 reported no findings on `ios-ship.yml` and `ci.yml`.  Full `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build` stay with the `verify` job.  This diff does not touch the Next.js app.

## Next Steps & Blockers

Open a ready PR against `main` with ST-4613 in the title.  Do not dispatch `ios-ship` and do not deploy.  Merge waits on green `verify`.

## Zero-Code Findings

Usage-Monitor already exports a PATH that starts with `/usr/bin:/bin:/usr/sbin:/sbin`.  Usage-Monitor #1693 changed `centralTimestamp()` to lowercase `am`/`pm` with no `CT` suffix, and the current function folds whitespace before the meridiem, including U+202F.  DealDex `ios-ship.yml` uses `actions/cache/restore` and `actions/cache/save` with `github.run_id` and `github.run_attempt`, and saves with `if: always()`.
