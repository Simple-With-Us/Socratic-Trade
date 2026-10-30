# iOS fleet ship tooling

This directory is the **source of truth** for the fleet-wide TestFlight ship scripts used by all three apps (Socratic-Trade, Congress.Trade, Usage Monitor).  The runtime install location is `/Users/jay/apps/ios-fleet/`, which is outside version control — twice in one week an unversioned host script there carried a defect nobody could review (a reattach cron that opened a 60s outage window every minute; a macOS `flock` bug that would have shipped an empty version string).  This directory exists so the same scripts get code review, history, and PRs before they run.

## Files

- `ship-testflight.sh` — archive + export + upload a single app to TestFlight without the Xcode UI.
- `ship-all.sh` — ship all three fleet apps sequentially.
- `apps.json` — per-app registry (bundle id, scheme, project paths, team id).
- `asc-api.mjs` — minimal App Store Connect API client (ES256 JWT, no dependencies).  Used by `ship-testflight.sh` for export-compliance (`ensure-tf-ready`), for build-number verification (`latest-build-seq`), and for the version plan (`latest-marketing-patch`, `build-floor`).
- `version-plan.mjs` — the pure, unit-tested rules behind the version numbering (no I/O, no network).  The ship script implements the same rules; this is the readable reference copy of them.
- `ExportOptions-appstore.plist` — export options for `destination=upload`.
- `ExportOptions-export-ipa.plist` — export options for `destination=export` (local IPA only).
- `test-ship-seq.sh` — offline tests for the version rules (see **Tests**).  Repo-only; not installed to the runtime location.

Secrets (ASC API key id/issuer/key) come from process env `APPLE_API_KEY_ID` / `APPLE_API_ISSUER_ID` / `APPLE_API_KEY_P8_BASE64` (the hosted trio, whose base64 body is decoded through a here-string), else from process env `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_P8`, else from Infisical Fleet-OPS folder `/asc` through `fleet-secrets get` (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`;  the `.p8` is written to a 0600 temp file for the run and removed on exit).  A path in `ASC_KEY_PATH` is not a credential source (AFC-459, revision 2):  it is ignored wherever it appears, and the 0600 temp file is only the materialization `altool` and Xcode read.  Nothing reads `~/.secrets` (AFC-359).  None of the files here contain secret values.

## Install (sync repo copy -> runtime location)

```bash
install -m 0755 scripts/ios-fleet/ship-testflight.sh /Users/jay/apps/ios-fleet/ship-testflight.sh
install -m 0755 scripts/ios-fleet/ship-all.sh /Users/jay/apps/ios-fleet/ship-all.sh
install -m 0644 scripts/ios-fleet/apps.json /Users/jay/apps/ios-fleet/apps.json
install -m 0644 scripts/ios-fleet/asc-api.mjs /Users/jay/apps/ios-fleet/asc-api.mjs
install -m 0644 scripts/ios-fleet/ExportOptions-appstore.plist /Users/jay/apps/ios-fleet/ExportOptions-appstore.plist
install -m 0644 scripts/ios-fleet/ExportOptions-export-ipa.plist /Users/jay/apps/ios-fleet/ExportOptions-export-ipa.plist
install -m 0644 scripts/ios-fleet/AppUpdatePrompt.swift /Users/jay/apps/ios-fleet/AppUpdatePrompt.swift
```

Edit the runtime copy only through this repo: change the file here, land the PR, then re-run the `install` commands above to sync `/Users/jay/apps/ios-fleet/`.

## Versioning contract

Owner directive 2026-10-24 (AFC-517).  This replaces the `1.0.<commit_count>` scheme unified fleet-wide on 2026-10-18, which made App Store Connect show `1.0.2358 (2358)`.

| Field | Value | Example |
| --- | --- | --- |
| `MARKETING_VERSION` (`CFBundleShortVersionString`) | `<prefix>.<P+1>`, the next patch on the app's train | `1.0.237` |
| `CURRENT_PROJECT_VERSION` (`CFBundleVersion`) | the repo commit count, raised above the App Store Connect floor | `2360` |

App Store Connect renders these as `<marketing> (<build>)`, so a ship shows **`1.0.237 (2360)`**.

The two numbers are **independent**.  The build number never names the marketing version, and the marketing version never names the build number.

- `MARKETING_VERSION` is the **next patch** on the train from `marketingVersionDefault` (`1.0`).  `P` is the highest patch App Store Connect already holds on that train, counting **both** the App Store versions (`appStoreVersions.versionString`) **and** the TestFlight trains (`preReleaseVersions.version`) for the app's platform.  A *drift train* — a `<prefix>.N` train holding a build whose `CFBundleVersion` is exactly `N` — is ignored: those are the `1.0.N (N)` uploads the retired scheme produced, and they no longer push the version forward.  App Store versions are never ignored.
- `CURRENT_PROJECT_VERSION` is the **repo commit count**, raised when needed so it is strictly greater than every build already in the *target* train (the retired 12-digit UTC stamps included: Apple requires build numbers to grow inside one train) and greater than the app's highest plain-integer build below `1000000000` on that platform.  On macOS **every** build counts, because macOS build numbers have to grow across all trains.  The only coupling between the two numbers is a safety rule: a ship must never look like `1.0.N (N)`, so a build that happens to equal the patch number moves one up.
- `--version X.Y.Z` is an exact marketing override and `--build N` an exact build override.  `--build` no longer moves the marketing version, and `--version` no longer moves the build number.  With `--version` only, the build number is still automatic (the commit count, floored against *that* train); with `--build` only, the marketing version is still the automatic next patch.

The rules live in `version-plan.mjs` (pure, unit-tested) and are mirrored in `ship-testflight.sh`.

An earlier revision set both fields to the same dotted string, which rendered as the uninformative `1.0.7 (1.0.7)`.  That was also a live rejection trap: Apple requires `CFBundleVersion` to be strictly increasing *within a marketing train*, and `trade.congress.ios` has 15 builds numbered `202608070253` … `202608120521` sitting in the `1.0.0` train.  `1.0.7` is numerically far lower than any of them; the dotted scheme only worked because each new marketing version opened a fresh, empty train.  A ship that landed back in an older train would have been rejected *after* a full archive + upload.

`--dry-run` only peeks at the next value and does not ship it.

### Fixed marketing versions (merge-timestamp builds)

Owner directive 2026-10-29.  An app with `fixedMarketingVersion` in `apps.json`
(Socratic-Trade: `0.1.0`) does not count its marketing version up per ship.
Its build is ONE shared merge-timestamp number per release across iOS and
macOS: `max(S, M + 1)`, a plain integer, where `S` is the merge stamp (the
committer date of the commit being built, in America/Chicago as `YYYYMMDDHHMM`)
and `M` is the highest build on record for the app and its paired app -- every
iOS build on ALL trains (expired included, old timestamp-style builds
included), every macOS build, plus every extra floor (the `pairedBuildFeed`
Sparkle max).  No floor and no cap: a rebuild of the same commit still goes
up, because the first upload already holds `S`.

The release computes the value ONCE, in the `plan-build` step
(`asc-api.mjs plan-release-build <bundleId> [pairedBundleId] [floor...]
--merge-stamp <S>`, read-only), and hands it to every platform ship job via
the existing `--build N`.  In fixed mode `--build N` must be a 12-digit stamp
`^[1-9][0-9]{11}$` strictly above every existing build of THIS app
record/platform only (so the paired platform may reuse the same value);
without `--build` the ship script plans the value itself through the same
command, for operators running locally.  The schedule gate and the ship-gate
(rate limit / same-HEAD) are unchanged: when a gate skips, nothing is planned
into an upload and nothing is uploaded.

The rules live in `shared-build.mjs` (pure, unit-tested) and are mirrored in
`ship-testflight.sh`.

### Where the numbers come from

- **App Store Connect** is queried with `asc-api.mjs latest-marketing-patch <bundleId> 1.0 <platform>` (the highest patch already used on the train) and `asc-api.mjs build-floor <bundleId> <version> <platform>` (the build number the next ship has to exceed), using the same credentials already passed to `xcodebuild`.  Both print their answer on stdout; the details (Apple's HTTP status and error code, and the drift trains that were ignored) go to stderr.
- **`project.pbxproj`** is **not** a sequencing input any more.  The resolved version is passed on the `xcodebuild` command line and overrides whatever the project file says, so a run whose resolved version differs from the project file prints a `NOTICE` naming both.  `--sync-project-version` writes the resolved version back into the project file (opt-in: it dirties the worktree, and shipping requires a clean one).
- The **local build-seq counter** (`~/.cache/ios-fleet/build-seq-<app>.txt`) is retired: nothing writes it and nothing reads it.  App Store Connect is the only record that shipping advances, so it is the only record that can answer "which patches does this train hold?" and "which build numbers are taken?".
- If **ASC cannot be consulted at all**, the script **fails** rather than guessing, and prints the ways to resolve it.  `--allow-unverified-seq` overrides, with a loud warning: the marketing version is then planned from an unverified patch (`P=0`) and the build floor is `0`.

### Nothing is consumed by a run that will not ship

A version is resolved only by a run that is actually about to archive.  The ship gate (rate limit / same-HEAD) is evaluated **before** any version is resolved, `--dry-run` peeks only, and `--upload-only` resolves no version at all because the IPA already carries its versions.  Before 2026-08-12 the gate ran *after* the counter had advanced, so every rate-limited attempt burned a version that shipped nowhere — observed live: a run skipped at 4392s of a 9000s interval and the sequence still went 5 → 6, leaving `1.0.6` existing in no place at all and the local counter drifting further from ASC.

`test-ship-seq.sh` pins all of this down; see **Tests** below.

`IOS_FLEET_STATE_DIR` relocates the ship-gate state, for testing against a scratch directory.

## Rate limit — what holds back automatic shipping

Uploads are throttled to **one successful ship per app per `DEFAULT_MIN_INTERVAL_SEC` = 3600 seconds (1 hour)**.  The constant lives near the top of `ship-testflight.sh`.  This is the main reason a merge to `main` does not become a TestFlight build: `.github/workflows/ios-ship.yml` fires on every push touching `clients/ios/**`, and most of those runs land inside the window, print `ship-gate: skip`, and exit 0.  A run whose git HEAD already shipped skips for the same reason.  Cron ticks twice an hour, so an unbuilt merge is picked up on the next eligible hour.

- **Override one run:** `IOS_TF_MIN_INTERVAL_SEC=<seconds>` in the environment, or `--force-ship`.
- **Change the standing limit:** edit `DEFAULT_MIN_INTERVAL_SEC`.  That is the owner's call — the number is a local/process-hygiene choice, not an Apple constraint.
- `--export-only` and `--dry-run` are not rate limited; neither builds a TestFlight upload.

The skip message names the value, its source, and both overrides, so the limit is discoverable from the log rather than only from this file.

## Tests

```bash
bash scripts/ios-fleet/test-ship-seq.sh
node --test scripts/ios-fleet/version-plan.test.mjs
node --test scripts/ios-fleet/shared-build.test.mjs
```

`test-ship-seq.sh` is fully offline — no network, no Xcode, no credentials.  It runs `ship-testflight.sh` with `HOME`, `PATH` and `IOS_FLEET_STATE_DIR` pointed at a scratch sandbox (a fake `xcodebuild` refuses to archive, and a fake `node` answers the App Store Connect queries from `FAKE_ASC_PATCH` / `FAKE_ASC_FLOOR`), so it cannot touch real ship state or App Store Connect.  It pins:

- a rate-limited run, and a same-HEAD run, exit 0 **without resolving a version** (this is the 2026-08-12 regression, and the suite fails against the pre-fix script exactly there);
- a gated run does not even make the ASC round trip;
- an allowed run leaves the local counter where it was;
- `--dry-run` and `--upload-only` resolve nothing; `--force-ship` still bypasses the gate;
- for **all four apps**: the marketing version is the next patch on the train (`1.0.237` against a stubbed `P=236`), the build number is the repo commit count, the two never read `1.0.N (N)`, and the pair is printed the way App Store Connect renders it;
- a floor above the commit count raises the build to `floor + 1` **without** moving the marketing version;
- `--version` is honoured exactly and the build is floored against *that* train; `--build` is honoured exactly and does **not** move the marketing version;
- an unreachable App Store Connect is fatal without `--allow-unverified-seq`, and loudly warns about the unverified patch with it;
- the skip message names the 3600s default and both overrides;
- a last-ship 3000s ago is still gated (counter untouched); at 3700s the gate proceeds.

`version-plan.test.mjs` is the unit-testable copy of the rules themselves: the patch arithmetic, the drift-train rule, the build floor (including the macOS "every build counts" rule), and the "never `1.0.N (N)`" guard.  `shared-build.test.mjs` pins the fixed-version planner: fresh app plans the stamp, builds below the stamp lose to it, builds at or above it plan one higher, iOS timestamp builds count, and malformed inventory or a bad stamp throws.  All three suites run in the `verify` CI gate.

## Drift check

`check-drift.sh` compares the sha256 of each file here against its counterpart in `/Users/jay/apps/ios-fleet/` and fails if they differ, so the repo copy cannot silently go stale relative to what actually runs.  Run it locally with:

```bash
bash scripts/ios-fleet/check-drift.sh
```

It exits 0 with a warning (not a failure) when `/Users/jay/apps/ios-fleet/` does not exist on the current machine, since that directory is host-local and won't be present in CI.

## In-app update prompt

Every fleet iOS app copies `AppUpdatePrompt.swift` from this directory (the
in-repo pin) into its app target and calls `.appUpdatePrompt()` on the root
view.  Do not fork the file.  Do not make a Swift package.

Apple IDs and marketing versions live in the public fleet manifest
https://raw.githubusercontent.com/jaywedgeworth22/ai-fleet-coordinator/main/site/ios-versions.json
(and the local mirror `ios-app-versions.json`).  `apps.json` is the ship
registry.  Live DealDex is `net.dealdex` appleId `6802474288`.
`online.dealdex` is not the live bundle.  Do not upload `me.grok.dealdex`.

`publish-ios-versions.sh` writes both the local mirror and the public
`site/ios-versions.json` on ai-fleet-coordinator after a successful ship.

Copy into this repo's iOS target:

```
cp scripts/ios-fleet/AppUpdatePrompt.swift ios/SocraticTrade/AppUpdatePrompt.swift
```

