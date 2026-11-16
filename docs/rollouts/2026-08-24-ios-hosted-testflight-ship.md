# 2026-08-24 -- hosted macos-latest TestFlight ship (in-repo ios-fleet)

## Context & Objective

Owner: `xcodebuild` is not a local command.  Compile and TestFlight run on GitHub-hosted `macos-latest` only.  Other seats were restarting the retired Mac runner / local Xcode.  #3083 switched `runs-on` but left the ship wrapper exec'ing `/Users/jay/apps/ios-fleet/ship-testflight.sh`, which does not exist on hosted runners, so every `ios-ship` tick failed in about 15s.  This change follows the Congress.Trade hosted protocol so #3028 (already on `main`) can actually reach TestFlight.

## Changes Made

Vendored the fleet ship tooling in-repo (CT pattern).  Hosted `ios-ship.yml` now imports signing from GitHub Actions secrets, restores `~/.cache/ios-fleet` across runs, and execs `scripts/ios-fleet/ship-testflight.sh`.  Durable docs now forbid local `xcodebuild` and Mac-runner restarts.

- `.github/workflows/ios-ship.yml`
- `.github/workflows/ios-build.yml` (comments / fork note only)
- `scripts/ios-ship-testflight.sh`
- `scripts/ios-fleet-pin.sh`
- `scripts/ios-fleet.sha256`
- `scripts/ios-appstore-gm-prepare.sh`
- `scripts/ios-fleet/*` (vendored from Congress.Trade)
- `AGENTS.md`
- `ios/CLAUDE.md`
- `ios/SocraticTrade/README.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-24-ios-hosted-testflight-ship.md`

## Decisions & Trade-offs

- Followed Congress.Trade: in-repo `scripts/ios-fleet/`, `ios-appstore-gm-prepare.sh`, GitHub secret names `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_P8` / `IOS_DIST_P12_BASE64` / `IOS_DIST_P12_PASSWORD`.  Did not mint a new App Store Connect key.  Copied the existing team credentials onto this repo (same team `CC8UTF7ATG`).
- `actions/cache` for `~/.cache/ios-fleet` so hosted cron ticks still see last-ship state.  Without it every 30-minute tick looks like "no prior ship" and would re-archive.
- Pin now hashes the in-repo copy, not `/Users/jay/apps/ios-fleet`.  Hosted runners have no Mac path.  `check-drift.sh` stays advisory when the Mac dir is absent.
- `apps.json` `socratic.marketingVersionDefault` set to `1.0.68` as the fallback train.  Live numbering still comes from App Store Connect `latest-build-seq` when ASC auth works.
- Posted `#ag***-s**c` so peer seats stop restarting local `xcodebuild` / the Mac runner.

## Verification State

- `bash scripts/ios-fleet-pin.sh --check`
- `bash scripts/test-ios-scheduled-ship-gate.sh`
- `python3` ASCII scan of new operator scripts (`ios-appstore-gm-prepare.sh` em dash replaced)
- `npm run lint` (exit 0)
- `npx tsc --noEmit` (exit 0)
- Hosted `ios-build.yml` `xcodebuild (unsigned)` SUCCESS on PR #3089
- Hosted `verify-hosted` FAIL on `3493c341` (Sentry still listed `(Mac runner)` names).  Observer + `CRON_SCHEDULES` retargeted; `npx vitest run test/sentry-ci-report-workflows.test.ts` 2/2
- PR #3089 squash-merged `ef725f26` 2026-08-25 00:43Z
- Merge-push ship `32794753487`: archive succeeded, export/upload started, then **cancelled** (~3m)
- Hosted schedule ship `32796413908` SUCCESS 2026-08-25 01:08-01:14Z: **ARCHIVE SUCCEEDED**, upload succeeded, build **1.0.69 (202608250109)**, ASC id `fd1ff0eb-c1c4-4488-b100-db2f9b9791a3`, `internal=IN_BETA_TESTING` ("TestFlight internal testers can install this build").  Recorded sha `b9421cbf` (#3090 after #3089; no `ios/**` in #3090).
- Release notes were DRY RENDER only (`IOS_TF_RELEASE_NOTES` unset on the hosted job).  Installability does not depend on publishing notes.

## Next Steps & Blockers

- Owner: install TestFlight **1.0.69 (202608250109)** and confirm gear / bell / Admin tab (#3028).
- Peer seats: do not run local `xcodebuild`.  Do not re-register `mac-xcode26-socratic`.
- Optional later: set `IOS_TF_RELEASE_NOTES=1` on the hosted ship step so "What's New" publishes.  Do not fire a second ship just for notes.
- Playwright smoke failure on `b9421cbf` is PR #3090 (RAG), not this ship.  Website/Coolify is a separate auto-deploy from `scripts/**` on #3089; not the iOS binary.

## Zero-Code Findings

#3088's "TestFlight blocked" close-out was the wrong protocol.  The hosted runner is the ship path.  The missing piece was vendoring the fleet scripts + ASC import, not waiting for a Mac.
