# 2026-08-21 - ios-adaptive-tabs-followups

Handoff for whoever picks this up next.  Written to be claimable in pieces — nothing here
depends on anything else here.

## 1. Context & Objective

The width-aware iOS/Mac tab bar and the iPad Air 11" layout pass **merged** to `main` as
`9298c29` (PR #2987, squash, 2026-08-21 06:56 UTC).  16 files, +1,359 / -137.

What it does, in one paragraph: `TabBarCapacity` converts the live window width into a slot
count (compact 4; iPad Air 11" 6 portrait / 8 landscape; a Mac window recomputes as it is
dragged; ceiling 8, floor 2).  Home is required and never toggleable.  The slot immediately
before More is *borrowed* — opening a screen from the More list hands it that slot, displacing
Activity by default; pinning that screen makes it permanent and gives the slot back.  A window
too narrow for the owner's chosen set renders the DEFAULTS instead and writes nothing, so
widening restores their picks exactly.  Until the owner pins or unpins anything the bar
auto-fills to what fits.  `SnapshotScaffold` picks 1/2/3 card columns from its own measured
width; **one column is the pre-existing `LazyVStack`, so the iPhone path is unchanged.**

Design detail, decisions, and the evidence table live in
`docs/rollouts/2026-08-21-ios-adaptive-tabs-ipad-layout.md`.  This note is only the open items.

## 2. What is NOT verified

The originating session ran in a Claude Code remote **Linux** container: no `xcodebuild`, no
`swiftc`, no `xcodegen`, no simulator.  So:

- **The XCTests are compiled but have never been executed.**  30 cases in
  `ios/SocraticTradeTests/TabPreferencesTests.swift` (capacity breakpoints, the Home lock,
  auto-fill, the narrow fallback, the borrowed slot) and 15 in
  `ios/SocraticTradeTests/WrappingHStackTests.swift` (`ContentColumnsTests`,
  `CardColumnsLayoutTests`, `AppMetricGridColumnsTests`).  `ios-build.yml` only ever runs
  `xcodebuild build`, never `test`, so no lane in this repo has run them.
- **There is no screenshot.**  The column breakpoints and the borrowed-slot behaviour have
  never been seen by a human.  `BUILD SUCCEEDED` is not visual QA.

The Swift itself IS proven to compile: the Mac runner printed `** BUILD SUCCEEDED **` twice on
the branch (05:22:30 and 06:21:48), and `verify` was green.

## 3. Open items

### A. Run the tests and take the screenshots  *(screenshots still need a Mac)*

**Status 2026-08-21 evening (CURSOR, PR #3023):** XCTest half **done** on the Mac runner.
Run 32529663287 concluded `success` in ~2 minutes: `Using simulator: iPhone 17 Pro`,
`** TEST SUCCEEDED **`, 232 tests / 0 failures, including all 30 `TabPreferencesTests`.
Screenshots (iPad Air 11" portrait/landscape, borrowed-slot behaviour, Mac window drag)
still need a human on a Mac; CI cannot see the bar.  Cursor local is down -- local
Grok should take them from `origin/main` (the tab bar is already #2987).  Do not
wait on PR #3027 (`origin/main` merged onto that branch 2026-08-21).  Paste-ready brief:
`docs/rollouts/2026-08-21-ios-adaptive-tabs-mac-qa.md`.

```bash
xcodebuild test -project 'ios/Socratic Trade.xcodeproj' -scheme SocraticTrade \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO

# iPad Air 11" in both orientations — this is the size the layout was designed for.
xcrun simctl list devices available | grep -i 'iPad Air'
xcrun simctl boot "iPad Air 11-inch (M3)"
xcrun simctl io booted screenshot /tmp/st-ipad-portrait.png
xcrun simctl io booted screenshot /tmp/st-ipad-landscape.png   # after rotating
```

Then check, specifically:
- Portrait 820pt should show **6 tabs + More** and **2 card columns**; landscape 1180pt should
  show **8 + More** and **3 columns**.
- Open something from More (Coach, say) and confirm it lands in the slot **immediately before
  More**, displacing Activity — and that More then carries Activity's unread badge.
- Drag a Mac Catalyst window narrow and confirm the bar falls back to the **default** tabs, and
  that widening restores the chosen set.

### B. Rename `WrappingHStackTests.swift`  *(CLOSED on this PR — Mac CI generates)*

**Status 2026-08-21 night (CURSOR):** file is `ios/SocraticTradeTests/LayoutMathTests.swift`.
XCTest class names stay.  Linux cannot hand-edit `project.pbxproj` (Cursor hook) and has no
`xcodegen`, so `.github/workflows/ios-build.yml` now runs XcodeGen 2.46.0 on the Mac runner
before build/test, restores objectVersion 100, and uploads the generated pbxproj.  Rollout:
`docs/rollouts/2026-08-21-ios-layout-math-tests-rename.md`.

### C. The `xcodebuild` CI check hangs on EVERY iOS PR  *(any seat; own PR)*

Not caused by #2987.  PR #2794, authored by someone else and merged to `main` at 04:35 the same
day, has the identical `cancelled` outcome (04:16:13 -> 04:51:13).

Root cause: the step never exits after `xcodebuild` returns.  Both runs on #2987 log
`Terminate orphan process: pid (SWBBuildService)` during post-job cleanup — Xcode's build
service daemon outlives `xcodebuild`, inherits the step's stdout pipe, and the Actions runner
waits on that pipe rather than on the process.  **Raising `timeout-minutes` does NOT fix this**
(attempt 2 built in 21 minutes with nine minutes of headroom and was cancelled anyway); the job
would just hang longer.

Proposed patch to `.github/workflows/ios-build.yml` -- give the daemon a file to inherit instead
of the runner's pipe -- **applied and verified on PR #3023**.  Mac job run 32529663287
concluded `success` in ~2 minutes (21:41:21Z -> 21:43:10Z), not `cancelled`.  Warm builds
later the same day already concluded `success` in ~40s without the patch (the cancelled
cluster was 04:16-06:56 UTC, including #2794 and #2987).  The redirect is still the right
hardening: a cold build that prints BUILD SUCCEEDED must not hang the pipe.  The same PR
added the `xcodebuild test` lane (item A's execution half -- 232/0 including 30
TabPreferencesTests).  `ios-build` can now be made a required check (board `830c892f`).

```yaml
      - name: Build SocraticTrade (generic iOS device, unsigned)
        run: |
          set -o pipefail
          log="$RUNNER_TEMP/xcodebuild.log"
          # SWBBuildService outlives xcodebuild and inherits its stdout.  Left on the runner's
          # own pipe it holds the step open until timeout-minutes kills it, even on a build
          # that already printed BUILD SUCCEEDED.  A file breaks that inheritance.
          set +e
          xcodebuild build \
            -project 'ios/Socratic Trade.xcodeproj' \
            -scheme SocraticTrade \
            -destination 'generic/platform=iOS' \
            CODE_SIGNING_ALLOWED=NO \
            CODE_SIGNING_REQUIRED=NO \
            > "$log" 2>&1 < /dev/null
          status=$?
          set -e
          tail -300 "$log"
          exit $status
```

### D. `PrivacyInfo.xcprivacy` is declared but not in the bundle  *(CLOSED on main)*

**Status 2026-08-21 evening:** CLOSED on `main` by #3012 (`c614391c`).  The checked-in
`project.pbxproj` now has `PrivacyInfo.xcprivacy in Resources`.  The ship script still does
not run `xcodegen`, but it no longer has to -- the next TestFlight of current main will copy
the manifest.  A vitest in `test/ios-privacy-manifest.test.ts` now asserts that pbxproj line
so a later generate cannot drop it silently.

Original finding, kept for the paper trail: `ios/project.yml` declared it as a resource
(added by PR #2794) while the pbxproj had zero references, so TestFlight binaries from that
window did not contain the privacy manifest.

### E. One design decision the owner may want to veto  *(no code needed to decide)*

**Auto-fill is not literally in the owner's request.**  Until the owner pins or unpins
anything, the bar fills itself to whatever the window fits.  Without it a fresh iPad still
shows four tabs and the whole feature only exists for someone who goes looking for it.  With
it, a fresh iPad Air 11" landscape shows eight tabs out of the box, which some people will
find busy.

To remove: delete `hasCustomSelection` and the `autoFill` call sites in
`TabPreferences` (`ios/SocraticTrade/MobileControlView.swift`), and update
`testFreshInstallFillsTheBarToWhateverTheWindowFits`,
`testAutoFillPutsTheDefaultsFirst`, `testTheFirstPinOrUnpinStopsTheAutoFill`, and
`testResizingAloneNeverCountsAsCustomizing`.

Also open, and genuinely the owner's: whether `AppTab.customizable`'s declaration order is the
right PRIORITY order for auto-fill.  It currently reads defaults first (Home, Proposals,
Assets, Activity) then Insights, Coach, Scan, Guardrails, Results.

### F. Tuning knobs, if the bar or the columns feel wrong

All in two places, both pure math with tests attached:

| Knob | File | Today |
|---|---|---|
| `TabBarCapacity.slotWidth` / `.reservedWidth` | `MobileControlView.swift` | 108 / 132 |
| `TabBarCapacity.maximum` / `.minimum` / `.compact` | `MobileControlView.swift` | 8 / 2 / 4 |
| `ContentColumns.twoColumnMinimum` / `.threeColumnMinimum` | `AppComponents.swift` | 680 / 1100 |
| `ContentColumns.maximumContentWidth` | `AppComponents.swift` | 1360 |
| `ContentColumns.readableWidth` / `.maximumActionWidth` | `AppComponents.swift` | 760 / 520 |
| `AppMetricGrid.minimumTileWidth` | `AppComponents.swift` | 178 (150 for Desk shortcuts) |

Changing any of them should change a test in `TabPreferencesTests` or `LayoutMathTests.swift`
(`WrappingHStackTests` / `ContentColumnsTests` / `CardColumnsLayoutTests` /
`AppMetricGridColumnsTests` class names).

## 4. Decisions & Trade-offs already made (do not re-litigate without reading these)

- The narrow fallback shows the **defaults**, not a trimmed version of the owner's set.  That is
  literally what was asked for.  Consequence: with 8 pinned and a window that fits 6, the bar
  shows the 4 defaults, not 6 of the 8.
- The borrowed slot **persists** across launches.  A session-scoped slot would snap the bar back
  to Activity on every cold start.  The aggregate More badge is what makes persisting it safe.
- `.tabViewStyle(.sidebarAdaptable)` was considered and **not** adopted: it replaces More with a
  system sidebar that owns the customization affordance, which would take both the required-Home
  rule and the borrowed slot out of our hands.  Revisit only on owner instruction.
- The `Tab` blocks are **positional** (`bar[0]`…`bar[8]`) and must stay unrolled: `ForEach` +
  `Tab` times out the Swift 6 type-checker on Release/archive, and a result builder takes at
  most ten children — there are exactly ten.
- The web console was deliberately not touched.  `MOBILE_TABS_MAX` there governs a phone bottom
  bar.  iOS and web now diverge on the ceiling; the default *set* is still shared.

## 5. Verification State

- `main` `9298c29` carries the tab-bar change.  `verify` green on that merge.
- Item C hang: PR #3023 Mac job run 32529663287 concluded `success` in ~2 minutes
  (file-redirect + test lane).  232 XCTests / 0 failures, iPhone 17 Pro.
- Item D closed on `main` by #3012.  Item B rename is this PR (`LayoutMathTests.swift` +
  Mac CI `xcodegen generate`).  Item A screenshots, item E auto-fill decision, item F
  knobs: still open.

## 6. Blockers

- Item B no longer needs a laptop `xcodegen`: the Mac `ios-build` job generates.
- Item A screenshots still need a Mac + simulator (iPad Air 11" both orientations, borrowed
  slot, Mac window drag).  A cloud Linux session cannot do them.
- Making `ios-build` a required check is owner/ruleset work.  PR #3023's Mac job concluded
  `success`, so the hang is no longer a reason to wait.
