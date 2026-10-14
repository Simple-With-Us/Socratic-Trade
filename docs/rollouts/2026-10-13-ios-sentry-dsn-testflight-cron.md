# 2026-10-13 -- iOS Sentry DSN and TestFlight cron

## Context & Objective

The installed TestFlight build sends no Sentry events, and the scheduled
monitor `ci-socratic-trade-ios-testflight-ship` (Sentry FLEET-INFRA-DA) has
been failing for weeks.  Both are fixed here without hardcoding a DSN and
without minting a new App Store Connect key.

## Changes Made

The 2026-10-08 ship (run 37747286651) logged `SENTRY_DSN unset` and archived.
Every later run that passed the ship gate died in about 0.6s with
`asc-seq: query failed (rc=2)` because `ship-testflight.sh` discarded
`asc-api.mjs` stderr.  Run 38181542543 (2026-10-11) already loaded
`SENTRY_DSN` from Infisical prod (length 95, value masked) and then hit the
same ASC failure, so that DSN never entered an IPA.  The phone is still on
the 2026-10-08 binary.

`latest-build-seq` still tries the list URLs that worked on 2026-10-08, then
the app relationship URLs, and prints Apple's HTTP status, code, and title.
The ship log keeps those `latest-build-seq:` lines.  The unverified-sequence
abort now names `local=` and `project=` instead of claiming the local
sequence is missing.  After a successful archive, the script checks that
Info.plist `SENTRY_DSN` expanded and logs only its length.

`ios/Config/Sentry.xcconfig` is `SENTRY_DSN = $(SENTRY_DSN)` and nothing else.
`ios/project.yml` no longer sets `SENTRY_DSN: ""` (that project-level empty
string overrides an xcconfig).  The checked-in pbxproj still has those two
empty settings because this seat cannot run XcodeGen.  `ios-ship.yml` now
installs XcodeGen 2.46.0 (same pin as `ios-build.yml`) onto PATH, and
`ship-testflight.sh` already runs `xcodegen generate` when that binary exists,
before the archive.
Info.plist already substitutes `$(SENTRY_DSN)`.  The ship script still passes
the value as an xcodebuild build setting.  This repo's convention is the
Socratic-Trade Infisical project (`INFISICAL_PROJECT_ID`) plus the Actions
secret fallback.  There is no separate fleet-ops project id in this workflow,
and the 2026-10-11 log shows the existing fetch already returns a DSN.

`MobileAPIClient` reports URLSession failures to Sentry once (after GET
retries), with tag `url_error_code` and extra `endpoint` set to the path
only.  Cancellation is skipped.  Capture no-ops until `SentryTelemetry.start`
has a real DSN.

Over the last 200 `ios-ship.yml` runs (188 schedule ticks, 430 hours) GitHub
delivered about 22% of the `*/30` slots.  Median gap 32.5 min, p90 368 min,
max 5450 min.  A 15-minute check-in margin marked 58 of 187 gaps missed; 600
minutes marks 1 of 187.  `CHECKIN_MARGIN_OVERRIDES["iOS TestFlight ship"]`
is 600 and `max_runtime` is 100 (the job timeout is 90).  A failed archive
still sends check-in status error and still emits the separate Sentry error
event.  The next scheduled or push run upserts the monitor config.

Touched:

- `.github/workflows/ios-ship.yml`
- `.github/workflows/ios-build.yml` (comment only)
- `ios/Config/Sentry.xcconfig`
- `ios/project.yml`
- `ios/SocraticTrade/SentryTelemetry.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `scripts/ios-fleet/asc-api.mjs`
- `scripts/ios-fleet/ship-testflight.sh`
- `scripts/ios-fleet.sha256`
- `scripts/sentry-ci-report.py`
- `test/sentry-ci-report-workflows.test.ts`
- `test/sentry-tunnel-middleware.test.ts`
- `test/ios-manual-signing.test.ts`
- `STATUS.md`
- `PLAN.md`
- this note

## Decisions & Trade-offs

ASC unverified stays fatal.  Proceeding from the local counter alone can
reuse a marketing version.  The fallback URLs cover a rejected `filter[app]`
or `sort`.  They do not cover HTTP 401 or 403.  If the next ship log shows
that, the existing Infisical prod `ASC_KEY_ID`, `ASC_ISSUER_ID`, and
`ASC_KEY_P8` cannot read `com.socratictrade.ios` (appleId 6815511597).  Do
not mint a new key.

The cron margin does not make GitHub deliver more ticks.  It stops a late
but real tick from paging.  A multi-day hole still pages.

## Verification State

- `node --check scripts/ios-fleet/asc-api.mjs`
- `bash -n scripts/ios-fleet/ship-testflight.sh`
- `python3 -m py_compile scripts/sentry-ci-report.py`
- `bash scripts/ios-fleet/test-ship-seq.sh` -- 50 passed
- `bash scripts/ios-fleet-pin.sh --check`
- `npx vitest run test/sentry-ci-report-workflows.test.ts test/sentry-tunnel-middleware.test.ts test/ios-manual-signing.test.ts` -- 20 passed

Hosted `verify` remains the merge gate.  `xcodegen` is not on this Linux
seat, so the pbxproj rewrite happens on the macOS ship job.

## Next Steps & Blockers

Read the next non-skip `ios-ship.yml` log.  `asc-seq: latest-build-seq:`
should include an HTTP status if it still fails.  A green archive should log
`archived Info.plist SENTRY_DSN length` (not the value).  No secret is
required for the DSN.  An ASC 401/403 is the only owner action, and it is
the key already in Infisical prod.

## Zero-Code Findings

FLEET-INFRA-DA's event count matches missed check-ins from dropped GitHub
schedule ticks, not 1,128 failed archives.  Schedule runs in the measured
window were 112 success and 76 failure; most successes are the ship gate
skipping when `ios/` did not change.
