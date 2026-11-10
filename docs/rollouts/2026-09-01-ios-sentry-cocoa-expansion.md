# 2026-09-01 — iOS Native Sentry Cocoa Telemetry & Crash Reporting (Antigravity, `ag/ios-sentry-cocoa-expansion`)

## Context & Objective
Integrates native Sentry Cocoa SDK into Socratic Trade iOS to eliminate the blind spot where mobile crashes (SIGSEGV, uncaught exceptions, OOM, UI hangs) fail to reach Sentry. Leverages the sponsored $5,000 tier under organization `jays-services`.

## Changes Made
- **Sentry Cocoa SPM Dependency**: Added `https://github.com/getsentry/sentry-cocoa.git` (`8.44.0+`) to `ios/project.yml` and linked `Sentry` product to target `SocraticTrade`.
- **SentryTelemetry Manager**: Implemented `SentryTelemetry.swift` to initialize native crash reporting, 2.0s app-hang detection, 5xx request failure capture, 0.2 distributed tracing, and privacy redaction on URLs.
- **Privacy Protections**: Disabled screenshot capture (`attachScreenshot = false`) and view hierarchy capture (`attachViewHierarchy = false`) to strictly safeguard financial portfolio screens.
- **App Startup Wiring**: Initialized `SentryTelemetry.start()` in `SocraticTradeApp.init()`.

### Touched Files
- `ios/project.yml`
- `ios/Socratic Trade.xcodeproj/project.pbxproj`
- `ios/SocraticTrade/SocraticTradeApp.swift`
- `ios/SocraticTrade/SentryTelemetry.swift`
- `docs/rollouts/2026-09-01-ios-sentry-cocoa-expansion.md`

## Decisions & Trade-offs
- **Screenshot/Hierarchy Suppression**: Strict financial compliance mandates disabling screenshot/view hierarchy capture on mobile devices.
- **Inert During ASC Screenshots**: Bypasses Sentry when running in `-ASCScreenshots` test/mock mode to avoid polluting telemetry with mock session errors.

## Verification State
- `xcodebuild -project "Socratic Trade.xcodeproj" -scheme "SocraticTrade" -destination "platform=macOS,variant=Mac Catalyst" CODE_SIGNING_ALLOWED=NO build` — **BUILD SUCCEEDED**.
- `npm run lint` — passed with 0 errors.
- `npx tsc --noEmit` — passed with 0 errors.
- `npx vitest run test/sentry-inert.test.ts` — 9/9 passed.

## Next Steps & Blockers
- Expand native Sentry Cocoa integration across DealDex, BotFleet, and Autorotate.
