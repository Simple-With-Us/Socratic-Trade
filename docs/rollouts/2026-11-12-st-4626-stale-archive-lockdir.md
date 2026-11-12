# ST-4626: drop a stale archive.lockdir before the ship acquires it

## Context & Objective

A cancelled or crashed TestFlight ship can save `archive.lockdir` into the `~/.cache/ios-fleet` actions cache.  The next hosted runner restores that directory onto a VM where the owner is gone, and `ship-testflight.sh` waits until the archive lock times out.  This change removes that restored lock before the next ship acquires it.

## Changes Made

Immediately after the cache restore, the ship workflow reads `archive.lockdir`.  It removes the directory when the recorded owner PID is not alive, when the recorded run is not this run, or when the directory is older than the 90 minute job timeout.  A restored lock has neither owner file, so both the PID check and the run check remove it before `Ship SocraticTrade to TestFlight` runs.  The same path is removed again with `if: always()` immediately before the cache save, so a cancelled ship cannot persist the lock.

- `.github/workflows/ios-ship.yml`
- `scripts/ios-fleet/asc-api.timestamp.test.mjs`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

CodeCaps removes `archive.lockdir` after restore and again before save, because a hosted runner is single-use and a restored lock has no live owner.  This workflow uses those two steps and checks the owner PID, the owner run, and a 90 minute age before the first removal, so a lock this run is still holding stays in place.  The age threshold is the job `timeout-minutes` value of 90.  The ship script still takes an empty directory lock, so a restored lock with no `owner.pid` and no `owner.run` counts as an owner that is gone.  This change does not pass `--force-ship` and does not dispatch `ios-ship`.

## Verification State

```bash
node --test scripts/ios-fleet/asc-api.timestamp.test.mjs scripts/ios-fleet/ship-tf-ready-labels.test.mjs
npx vitest run test/ios-ship-plan-build.test.ts test/ios-manual-signing.test.ts
actionlint .github/workflows/ios-ship.yml
```

The contract test passed 6, and `ship-tf-ready-labels.test.mjs` passed 3.  `test/ios-ship-plan-build.test.ts` and `test/ios-manual-signing.test.ts` passed 17.  actionlint 1.7.7 reported no findings on `.github/workflows/ios-ship.yml`.  Full `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build` stay with the `verify` job.  This diff does not touch the Next.js app.

## Next Steps & Blockers

Open a ready PR against `main` that says `Fixes ST-4626`.  Do not dispatch `ios-ship` and do not deploy.  Merge waits on green `verify`.

## Zero-Code Findings

CodeCaps commit `48d713e46aa02373c054d6a76f54d5b2f3cc7cea` added the clear-after-restore and remove-before-save steps, and `scripts/ios-ship-workflow.test.mjs` asserts their order.  HogHunter `ios-testflight.yml` deletes `~/.cache/ios-fleet/*.lockdir` after restore.  Socratic-Trade's ship script creates only `archive.lockdir`.

