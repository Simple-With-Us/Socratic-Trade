# 2026-08-11 — iOS version-regimen regression fix

## Context & Objective

The owner established a new iOS version regimen tonight: the App Store-facing "Version" number
(`MARKETING_VERSION` / `CFBundleShortVersionString`) follows plain patch-increment semver from
each app's first shipped release — `1.0.0`, then `1.0.1`, `1.0.2`, ... for every subsequent
release — separate from the internal build number (`CURRENT_PROJECT_VERSION` /
`CFBundleVersion`), which just keeps incrementing independently. Documented in
`/Users/jay/apps/ios-fleet/README.md`.

While preparing the first build under this regimen, PR #2637 (a different agent, "Antigravity")
merged to `main` in the interim and turned out to accidentally hardcode
`ios/SocraticTrade/Info.plist`'s `CFBundleShortVersionString` to the literal string `"1.0"` and
`CFBundleVersion` to the literal string `"1"` — replacing what used to be
`$(MARKETING_VERSION)` and `$(CURRENT_PROJECT_VERSION)`, Xcode build-variable placeholders that
get filled in from the project's build settings at build time. That PR's own rollout note
(`docs/rollouts/2026-08-11-system-audit-and-ios-resiliency.md`) doesn't mention touching these
files at all — only `MobileAPIClient.swift`/`MobileStore.swift` are documented there, so this
was very likely an unnoticed side effect of an XcodeGen regeneration step during that agent's
own build/verify pass, not an intentional change.

With the hardcoding in place, changing `MARKETING_VERSION` in the Xcode project (in
`project.pbxproj` or `project.yml`) would no longer actually change what ships — Info.plist
would keep shipping the literal `"1.0"`/`"1"` regardless. This silently defeats the whole
regimen before it could even start.

## Changes Made

- `ios/SocraticTrade/Info.plist`: restored `CFBundleShortVersionString` to
  `"$(MARKETING_VERSION)"` and `CFBundleVersion` to `"$(CURRENT_PROJECT_VERSION)"`.
- `ios/Socratic Trade.xcodeproj/project.pbxproj`: set `MARKETING_VERSION = 1.0.1` and
  `CURRENT_PROJECT_VERSION = 2` in both the Debug and Release configuration blocks.
- `ios/project.yml`: same two values, kept in sync (this is the XcodeGen source of truth that
  regenerates the pbxproj).

### Touched files
- `ios/SocraticTrade/Info.plist`
- `ios/Socratic Trade.xcodeproj/project.pbxproj`
- `ios/project.yml`

## Decisions & Trade-offs

- **1.0.1, not 1.0.0**: 1.0.0/1.0 already shipped to TestFlight (App Store Connect confirms this
  — checked via the new `~/apps/ios-fleet/asc-api.mjs` tooling). This is the first *new* build
  under the regimen, so 1.0.1 is correct per the rule (each new one is the next patch number).
- **Left `preferredProjectObjectVersion` (pbxproj, currently `77`) and
  `TARGETED_DEVICE_FAMILY: "1,2"` (project.yml) untouched.** Both are legitimate fixes from PR
  #2637 unrelated to this regression — the former is an Xcode-compatibility hint (works around
  the stable-vs-beta Xcode project-format mismatch investigated earlier tonight), the latter
  explicitly declares iPhone+iPad support at the project level. Reverting those would undo real,
  wanted fixes.
- Did not attempt to also ship this build to TestFlight as part of this fix — that's a separate
  step (`bash scripts/ios-ship-testflight.sh`), left for after this lands.

## Verification State

```
npx tsc --noEmit   # clean, no output
```

The changed files are Xcode project files (plist/pbxproj/yaml), not covered by the vitest suite
or Next.js build directly; `npx tsc --noEmit` passing confirms nothing else in the repo was
affected. Full `npm test`/`npm run build` run as part of `scripts/land.sh`'s gate before push.

## Next Steps & Blockers

- Ship a build under the corrected regimen via `bash scripts/ios-ship-testflight.sh` once this
  lands, to confirm the substitution actually resolves to `1.0.1`/`2` in the shipped IPA (not
  just in the project file).
- GROK is independently investigating the Mac TestFlight "installs but doesn't launch" issue
  (found `amfid Code=80 Authentication error`, confirmed not ST-specific — affects CT/UM too
  under macOS 27 beta) — corroborates this session's own earlier finding (LaunchServices
  `-10671`, same root cause: a macOS-beta-side issue, not an app bug on any of the three apps).
