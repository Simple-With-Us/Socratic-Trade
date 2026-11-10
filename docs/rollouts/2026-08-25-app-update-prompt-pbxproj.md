# 2026-08-25 -- AppUpdatePromptTests pbxproj leftover after #3102

## Context & Objective

#3102 squash `df75ca6f` landed the AppUpdatePrompt pin/copy and DealDex registry.  Hosted `ios-build` `32808123472` generated `AppUpdatePromptTests.swift` refs that the squash did not include.  The ship script does not run xcodegen, so TestFlight would miss the new XCTest until the generated pbxproj is committed.

## Changes Made

Committed the generated `AppUpdatePromptTests.swift` refs from the hosted job.  Locked them with a privacy-manifest vitest assert and an `ios-build.yml` grep after `xcodegen generate`.  Flipped the #3102 board rows to COMPLETED (merged to `main`).  Did not `--force-ship`.  Did not dispatch `ios-ship.yml`.  Did not claim a website deploy.

Touched files:

- `ios/Socratic Trade.xcodeproj/project.pbxproj`
- `test/ios-privacy-manifest.test.ts`
- `.github/workflows/ios-build.yml`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-25-app-update-prompt-apple-ids.md`
- `docs/rollouts/2026-08-25-app-update-prompt-pbxproj.md`

## Decisions & Trade-offs

- New branch off `origin/main` (`cursor/app-update-prompt-pbxproj-ddca`, PR #3103) instead of more commits on the merged #3102 branch.
- Did not hand-edit pbxproj IDs; copied the artifact from `32808123472` (same four-line add as leftover commit `46dff4e0`).
- Did not treat `ios/**` as a Coolify deploy.  `ios/**` is outside `watch_paths`.  Do not announce website deploy without `scripts/verify-deploy-sha.sh`.

## Verification State

- `npx vitest run test/ios-privacy-manifest.test.ts test/ios-fleet-app-update-prompt.test.ts` — 9/9 pass
- `npm run lint` — 0 errors (774 grandfathered warnings)
- `npx tsc --noEmit` — clean
- `npm run build` — Next.js 16.3.1 succeeded
- Hosted leftover `ios-build` `32809716228` and head `32810441765` — ** TEST SUCCEEDED ** (242/0).  Generated pbxproj still includes `AppUpdatePromptTests.swift in Sources`.
- Hosted `verify-hosted` `32809716125` — success (lint, tsc, npm test, next build).
- Squash-merged to `main` as `64a06e78` at 2026-08-25T05:18:53Z.

## Next Steps & Blockers

- Optional: drop `online.dealdex` from public `jaywedgeworth22/ios-app-versions` `versions.json`.  Do not add `me.grok.dealdex`.
- Do not `--force-ship`.  Do not dispatch `ios-ship.yml` unless the owner asks.
- Do not claim a website deploy.  `ios/**` is outside Coolify `watch_paths`.

## Zero-Code Findings

#3102 squash used only the first commit.  The second leftover (`46dff4e0`) stayed on `cursor/app-update-prompt-apple-ids-ddca` and is not on `main`.
