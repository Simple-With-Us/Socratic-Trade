# 2026-08-12 — iOS customizable tab bar (web mobile-tabs parity) + xcodegen version-regression root-cause fix

## Context & Objective

Owner ask: make the iOS app's tab bar customizable "like how it is on socratictrade.com mobile
website... with the glass style tabs though," as part of a broader push for better web↔iOS parity
(an expert-panel parity review runs alongside this change and reports separately).  The web model
being mirrored is `app/console/lib/mobile-tabs.ts` + the `MobileTabBar`/`TabsSheet` in
`app/console/components/nav.tsx`: pin/unpin destinations, minimum 2, maximum 4, bar renders
membership in canonical order (not pin order), and every destination stays reachable through an
always-present More surface.

## Changes Made

- `ios/SocraticTrade/MobileControlView.swift` (rewritten, the tab-shell file):
  - `AppTab` gains a fixed `.more` case plus `title`/`systemImage`/`detail` accessors;
    `AppTab.customizable` excludes `.more`.
  - New `TabPreferences` (`ObservableObject`, `UserDefaults` key `mobileTabs.v1`) — the exact
    web semantics: min 2 / max 4, defaults Home + Proposals + Assets + Activity (the web's
    Home/Proposals/Activity/Orders defaults mapped onto this app's screens — Assets is where
    holdings/orders live), canonical-order rendering, silent recovery from stale/invalid stored
    values (unknown names dropped; below-minimum resets to defaults).
  - `MobileControlView` renders `TabView` from `tabPreferences.barTabs` + a fixed More tab.
    The native system `TabView` is kept deliberately — that IS the Liquid Glass tab bar on the
    iOS 26 SDK; no custom chrome to fight it.
  - Programmatic tab jumps (Home's "Review Proposals" etc.) that target an UNPINNED screen are
    rerouted into the More tab's `NavigationStack` path, so every jump lands on a real screen
    instead of a selection with no matching tab.
  - New `MoreView` (private): List of every screen with icon/purpose-line/pending-proposals
    badge, `NavigationLink` push (all screens reachable even when unpinned — the web TabsSheet
    guarantee) and a pin/unpin toggle per row with the same disabled-at-bounds behavior and
    accessibility hints as the web ("Keep at least 2 tabs" / "Up to 4 tabs — remove one first").
- `ios/SocraticTradeTests/TabPreferencesTests.swift` (new): 8 XCTests pinning the web-parity
  contract — defaults, persistence round-trip, canonical-vs-pin ordering, both bounds as no-ops,
  stale-value recovery, above-max clamping, `.more` never pinnable.
- `ios/project.yml` + regenerated `ios/Socratic Trade.xcodeproj/project.pbxproj`:
  - **Root cause of the 2026-08-11 version regression found and killed.**  `xcodegen generate`
    rewrites `Info.plist` from `project.yml`'s `info.properties`; because the version keys were
    not declared there, every regen emitted literal `1.0`/`1`, detaching the shipped version
    from `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`.  That is precisely how PR #2637's
    unrelated regen introduced the regression PR #2639 had to fix.  `project.yml` now declares
    `CFBundleShortVersionString: $(MARKETING_VERSION)` / `CFBundleVersion:
    $(CURRENT_PROJECT_VERSION)` with a warning comment, so regeneration preserves substitution
    — verified by regenerating and inspecting the emitted plist.
  - Header fields re-applied post-regen per the `project.yml` header comment
    (`objectVersion = 100`, top-level `preferredProjectObjectVersion = 100`; the in-project
    `preferredProjectObjectVersion = 77` from #2637's toolchain fix is untouched).
  - **The unit-test target was never runnable — two latent breaks found and fixed** when this
    branch's new tests were first executed: (1) `TEST_HOST` was auto-derived from the target
    name (`SocraticTrade.app`) while the app's overridden `PRODUCT_NAME` is `Socratic Trade`
    (with a space) — pointed at a bundle that does not exist; fixed with explicit
    `TEST_HOST`/`BUNDLE_LOADER`.  (2) The spaced product name sanitizes to module
    `Socratic_Trade`, so the pre-existing `@testable import SocraticTrade` in
    `MobileModelsTests.swift` could never resolve; fixed by pinning
    `PRODUCT_MODULE_NAME: SocraticTrade`.  Also added `DEVELOPMENT_TEAM`/`CODE_SIGN_STYLE` to
    the test target (unsigned targets cannot run on the Mac destination).  Consequence: the
    pre-existing `MobileModelsTests` suite runs for the first time too — and first execution
    exposed that `testCommandAttemptTrackerReusesOnlyTheSameUnresolvedAction` was authored
    against an imagined tracker (one attempt per FINGERPRINT); the real tracker deliberately
    keeps one attempt per OPERATION ID, with in-flight double-submit protection living a layer
    up in `MobileStore.busyOperations`.  The implementation is correct; the test was rewritten
    to pin the real semantics (retry reuse, queued keeps attempt alive, changed intent
    replaces, terminal resolution releases so a post-failure retry mints a fresh key).

### Touched files
- `ios/SocraticTrade/MobileControlView.swift`
- `ios/SocraticTradeTests/TabPreferencesTests.swift` (new)
- `ios/project.yml`
- `ios/Socratic Trade.xcodeproj/project.pbxproj` (regenerated)

## Decisions & Trade-offs

- **Native `TabView`, no custom bar.**  "Glass style" on the iOS 26 SDK is the system tab bar's
  default appearance; a custom-drawn bar would forfeit Liquid Glass, the sidebar adaptation on
  iPad/Mac, and future system behavior for zero benefit.
- **Membership set, not ordered pins** — same call the web made; the bar is predictable and the
  storage can never encode a broken order.
- **`TabPreferences` lives in `MobileControlView.swift`** rather than its own file to keep the
  tab shell cohesive in one place (the file is the shell); tests still exercise it directly via
  `@testable import`.
- **iOS keeps its own 5-screen destination list** — this change builds the customization
  infrastructure; which NEW destinations should become pinnable (parity gaps) is exactly what
  the parallel expert-panel review reports on.

## Verification State

- `xcodegen generate` clean; regenerated plist verified to keep `$(MARKETING_VERSION)` /
  `$(CURRENT_PROJECT_VERSION)`.
- Build + XCTest run: see the follow-up section below / STATUS.md (run via
  `xcodebuild -destination 'platform=macOS,variant=Designed for iPad'` under stable Xcode 26.6
  — the same build used to launch the actual app natively on the Mac per the owner's ask).
- Repo verify gate (`tsc`/`vitest`/`next build`) runs in `scripts/land.sh`; this branch touches
  only `ios/**` + docs.

## Next Steps & Blockers

- Parity expert-panel synthesis (workflow `wf_79db5ae2-797`) → owner report as rollout note +
  Apple Note; its roadmap decides which new screens (and which admin panels) come to iOS next.
- Ship to TestFlight after merge (`bash scripts/ios-ship-testflight.sh`) — first build under the
  fixed version regimen; confirm the IPA carries 1.0.1/2.
