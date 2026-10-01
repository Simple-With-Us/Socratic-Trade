# 2026-09-30 — Socratic Trade first TestFlight build on com.socratictrade.ios (CLAUDE)

Board `687a5fb4`.  Branch `claude/st-ios-first-ship`, worktree `~/apps/claude-st-ios-ship`.

## 1. Context & Objective

App Store Connect app `6815511597` (bundle `com.socratictrade.ios`, SKU ST, created after the
2026-09-22 bundle-ID migration) had zero builds.  Every `ios-ship.yml` run on the new bundle failed
at `GatherProvisioningInputs` (runs `36792017763`, `36793014956`, Xcode 26.6 17F113 on
`macos-26-arm64`), so the owner directed getting the first TestFlight build uploaded with the
existing App Store Connect key, without minting a new one.

## 2. Changes Made

**Root cause.**  Xcode 26 automatic signing (`-allowProvisioningUpdates` with
`-authenticationKeyPath/ID/IssuerID`) talks to `developerservices2.apple.com`, and the fleet App
Store Connect API key (`HKYGJLHL32`, "Agents Fleet 2026-09-24") gets **HTTP 401 NOT_AUTHORIZED**
there, while `api.appstoreconnect.apple.com` accepts the same key.  Reproduced locally with a
hand-signed ES256 JWT (status codes only, no token printed):

| Host | `aud` | Result |
|---|---|---|
| `api.appstoreconnect.apple.com/v1/bundleIds` | `appstoreconnect-v1` | 200 |
| `developerservices2.apple.com/services/v1/bundleIds` | `appstoreconnect-v1` | 401 NOT_AUTHORIZED |
| `developerservices2.apple.com/services/v1/bundleIds` | `apple-developer-v1` | 401 NOT_AUTHORIZED |

The 401 detail is word for word the error Xcode printed ("Authentication failed: Make sure a bearer
token was provided, it is properly configured and signed, and it has not expired."); the "No
profiles for 'com.socratictrade.ios' were found" line is the consequence.  The same CI run's
`asc-api.mjs latest-build-seq` call authenticated fine with the same staged key file, which rules
out key staging, key ID, and issuer ID.  CodeCaps hit the identical wall earlier today and shipped
with manual signing (CodeCaps PR #80, run `36768356017`).

**Second blocker found on the way.**  The App Store profile for this bundle carries an **empty**
`com.apple.security.application-groups` list, because `group.com.socratictrade` was never assigned
to the App ID.  The public API cannot assign an App Group, and no Swift code reads a shared
container, so the entitlement is removed (see Decisions).

**Fix: manual Release signing with the App Store profile.**

- `ios/project.yml` — `SocraticTrade` Release config: `CODE_SIGN_STYLE: Manual`,
  `CODE_SIGN_IDENTITY: "Apple Distribution"`,
  `PROVISIONING_PROFILE_SPECIFIER: "Socratic Trade App Store (API)"`.  Debug stays Automatic.  App
  Group entitlement removed with an explanation of how to bring it back.
- `ios/Socratic Trade.xcodeproj/project.pbxproj`, `ios/SocraticTrade/SocraticTrade.entitlements` —
  regenerated with `xcodegen generate` 2.46.0 (+ `xcodegen-post.py`), not hand-edited.
- `ios/appstore-profiles.json` (new) — `{ "com.socratictrade.ios": "Socratic Trade App Store (API)" }`.
- `scripts/ios-install-appstore-profiles.sh` (new) — downloads the mapped `IOS_APP_STORE` profile
  over the REST client, checks ACTIVE + bundle + `get-task-allow=false` + that one of its
  certificates is an installed codesigning identity, installs it by UUID.  Prints names, UUIDs, and
  certificate SHA-1s only.
- `scripts/ios-fleet/ship-testflight.sh` — manual mode (default when the profile map exists;
  `IOS_MANUAL_SIGN=1` requires it, `=0` forces automatic): runs the installer, archives with no
  `-allowProvisioningUpdates`, no auth flags, no `CODE_SIGN_STYLE` override, writes a manual
  ExportOptions plist from the map, skips the `destination=upload` export (it needs an Xcode account
  and can only fail "Failed to Use Accounts"), and uploads the exported IPA with `altool --apiKey`.
  Logs the archived app's signing authority as a receipt.
- `scripts/ios-fleet.sha256` — pin refreshed for `ship-testflight.sh`.
- `.github/workflows/ios-ship.yml` — `IOS_MANUAL_SIGN: "1"`; `workflow_dispatch` input
  `export_only` (archive + IPA, no upload) for signing checks off a branch; on failure, collects the
  ship logs plus Xcode's `.xcdistributionlogs` and uploads them as an artifact.
- `scripts/ios-collect-ship-logs.sh` (new) — redacts the values of `ASC_KEY_ID`, `ASC_ISSUER_ID`,
  `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` and refuses to publish anything containing `PRIVATE KEY`.
- `test/ios-manual-signing.test.ts` (new) — pins project.yml, the checked-in pbxproj, the profile
  map, and the entitlements to each other, and drives the real ship script against a stub
  `xcodebuild` (manual default, `IOS_MANUAL_SIGN=0`, missing map).
- `AGENTS.md` bundle-identifier table — App Group row updated.

## 3. Decisions & Trade-offs

- **Manual signing, not more Xcode auth debugging.**  The 401 is server-side for this key on the
  provisioning host; no client-side flag changes it.  Manual signing removes the dependency on
  that host entirely and matches the CodeCaps fix already proven on the same Xcode image.
- **Profile by name.**  The specifier is the profile name, so regenerating the profile (new UUID)
  needs no project change.  The installer keeps the latest-expiring ACTIVE profile if a name repeats.
- **App Group dropped, not split per config.**  The repo blocks hand-written `.entitlements` files,
  and XcodeGen generates one entitlements file per target, so a Release-only entitlements variant
  would have to be hand-written.  Since nothing reads the group, removing it everywhere is the
  honest state until the group is actually assigned.
- **No `destination=upload` attempt in manual mode.**  It cannot succeed without an Xcode account;
  going straight to IPA + `altool` saves a minute and a misleading red line.
- **Version.**  The first build is `1.0.<seq>` where seq continues the old bundle's local counter
  (`local=101`, ASC 0), so it ships as `1.0.102` or later.  Harmless (numbers are free) and keeps
  monotonicity with the old record.

## 4. Verification State

```bash
cd ios && xcodegen generate && python3 xcodegen-post.py   # only signing + entitlements lines change
IOS_PROFILES_DIR=$(mktemp -d) bash scripts/ios-install-appstore-profiles.sh   # installs 1bf60929..., identity match
bash scripts/ios-fleet-pin.sh --check
bash -n scripts/ios-fleet/ship-testflight.sh scripts/ios-install-appstore-profiles.sh scripts/ios-collect-ship-logs.sh
npx vitest run test/ios-manual-signing.test.ts test/ios-fleet-app-update-prompt.test.ts test/ios-privacy-manifest.test.ts
npm run lint && npx tsc --noEmit && npm test && npm run build
```

`scripts/ios-fleet/test-ship-seq.sh` has one pre-existing failure (case 11 die-text) on
`origin/main` too; unchanged by this work.

**Branch signing check, hosted `macos-26-arm64`, Xcode 26.6 (17F113):** run `36796164530`
(`workflow_dispatch`, `export_only=true`, branch `claude/st-ios-first-ship`) succeeded.  The installer
matched identity `7995E5D2...9140` (Apple Distribution: Jay Wedgeworth, LLC) and installed profile
UUID `1bf60929-6116-4a2a-9a9b-5ad1c007c687`; both the Sentry framework and the app signed with
"Apple Distribution" + "Socratic Trade App Store (API)"; `ARCHIVE SUCCEEDED`, `EXPORT SUCCEEDED`,
IPA produced.  No upload (by design).

**First real ship, from `main` after PR #4019 merged (`16b87bb5`):** run `36800120244`
(`workflow_dispatch`, `main`) succeeded in about 6 minutes.  Same identity and profile, `ARCHIVE
SUCCEEDED`, `EXPORT SUCCEEDED`, `altool` "UPLOAD SUCCEEDED with no errors", What to Test created
(954 chars), export compliance declared (`enc=false`), internal state `IN_BETA_TESTING`.  App Store
Connect app `6815511597` now lists build **1.0.102 (202610010114)**, `VALID`, id
`b8f5b6c2-c305-4d10-897e-19edd76c77e7`.  The ship-state cache was saved
(`ios-fleet-socratic-36800120244`), so scheduled ticks skip until `ios/` changes again;
`ios-ship.yml` is left **enabled**.

## 5. Next Steps & Blockers

- Owner, optional: assign `group.com.socratictrade` to the `com.socratictrade.ios` App ID in the
  Developer Portal, regenerate "Socratic Trade App Store (API)", then re-add the entitlement in
  `ios/project.yml` and regenerate.  Only needed when a feature actually shares a container.
- Fleet, optional: if the developerservices2 401 is a property of the key's role, an Admin key
  would restore automatic signing.  Do not mint one; owner's call.

## 6. Zero-Code Findings

- The developer-portal profile `676BX6Y8D7` ("Socratic Trade App Store (API)") embeds distribution
  certificate `U79862KNC9` (SHA-1 `7995E5D2...9140`), the one CI imports from Infisical.
- Development profile `24QFAKRM86` created earlier tonight is not used by this path.
