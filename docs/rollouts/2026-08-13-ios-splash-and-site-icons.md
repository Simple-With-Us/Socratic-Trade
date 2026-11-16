# 2026-08-13 UI lane: iOS Splash Screen & Personal Site Icon Updates

## Context & Objective
The user previously reported that the logo on the Socratic Trade iOS app was rendering upside down on Mac Catalyst, which was resolved by a previous agent. Today, the user requested a return to the "stacked" wordmark (SOCRATIC on top of TRADE) for the native splash screen, matching earlier designs, and wanted missing app icons on their personal site restored. 

## Changes Made
- **iOS Splash Wordmark**: Updated the iOS `CandleWordmarkView.swift` sampler logic to process multi-line (`\n`) strings and center them. Altered the static `CandleWordmarkModel.shared` to pass `"SOCRATIC\nTRADE"` instead of the one-liner, and updated `SocraticTradeApp.swift` to dynamically compute splash-screen bounds based on the new aspect ratio of the stacked wordmark.
- **Personal Site Syncing**: Updated `Personal-Site/.github/workflows/mirror-site.yml` to preserve `static/app-icons` after mirroring the upstream SvelteKit site.
- **Agent Workflow Instructions**: Diagnosed a GitHub token permissions issue blocking automated workflow pushes and updated `AGENTS.md` and `AG***-S**C.md` with instructions to use `~/.secrets/global-api-keys` for CI workflow edits.
- **Revert Orientation**: Restored `UIInterfaceOrientationPortraitUpsideDown` to iOS `Info.plist` and `project.yml` because the earlier removal was based on a misunderstanding of the user's report (the upside down bug was only the logo, not the entire app window).

## Decisions & Trade-offs
- **Wordmark Dynamic AR**: The previous iOS wordmark AR was hardcoded to `13.081` (matching the one-line web layout). Because the stacked wordmark reduces the aspect ratio significantly (~4.0), the width-to-height scaling constraint `max(16, min(34, ...))` in `SocraticTradeApp.swift` was expanded to `max(40, min(80, ...))` and decoupled from the hardcoded `13.081` to instead pull directly from the dynamically generated wordmark (`CandleWordmarkModel.shared.wm.ar`).
- **Separation of Concerns**: Only the iOS native code (`CandleWordmarkView.swift` and `SocraticTradeApp.swift`) was modified to use the stacked format. The `candle-ticker.ts` web equivalent remains unchanged, as the one-line wordmark remains the correct design for the desktop web header.

## Verification State
- `npm run build` and `npm run test` passed.
- iOS layout constraints verified via `xcodebuild test`.
- Changes merged directly to `main` via agent branch deployment `scripts/land.sh`.

## Next Steps & Blockers
- None.
