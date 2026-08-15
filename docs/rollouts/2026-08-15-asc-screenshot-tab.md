# 2026-08-15 — ASC screenshot tab launch argument

## Summary

DEBUG-only deep-link so App Store screenshot sims can open a named tab:

- Launch arg `-ASCScreenshotTab home|proposals|markets|activity|insights`
- UserDefaults `ascScreenshotTab`
- Notification `.ascSelectTab`
- `-ASCScreenshots` / `ASC_SCREENSHOTS=1` / `ascScreenshots` uses preview fixtures and skips network

Does **not** touch `project.pbxproj` or Info.plist version keys.

## Verify

`xcodebuild` is not required for this docs+Swift-only hook; the launch-arg parser is `#if DEBUG`.
