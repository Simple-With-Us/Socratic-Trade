# 2026-08-25 -- AppUpdatePrompt Apple IDs off Swift (live DealDex net.dealdex)

## Context & Objective

Jay wants one pinned `AppUpdatePrompt.swift` copied into each iOS target.  This repo is a source of that pin.  `knownAppleIds` in the Swift file still mapped stale `online.dealdex` to the live Apple ID.  Live DealDex is `net.dealdex` appleId `6802474288`.  Move Apple IDs off the Swift file into the version manifest / `apps.json` so the prompt reads them at runtime.

## Changes Made

Kept the in-repo ios-fleet pin/copy model.  Did not make a Swift package.  Did not touch `testers.json`.  Did not `--force-ship`.  No spend.

- Removed `knownAppleIds` from the Swift pin.  `evaluate` already prefers `manifest.apps[bundleId].appleId`, then iTunes lookup, then an optional Info.plist override.
- Copied the pin to `ios/SocraticTrade/AppUpdatePrompt.swift` (the two files had already drifted: only the fleet copy had custom `Version ==`).
- `apps.json` DealDex `bundleId` is now `net.dealdex`.  Notes say `online.dealdex` is not live and `me.grok.dealdex` must not be uploaded.
- Local `ios-app-versions.json` live DealDex key is `net.dealdex` (1.0.2 / 202608230250 / 6802474288).  Dropped `online.dealdex`.
- `ship-testflight.sh` refuses `me.grok.dealdex` and a `dealdex` key whose bundle is not `net.dealdex`.  This repo still does not ship DealDex (`APP_KEY` remains socratic | congress | usage | usage-local).
- Pin/copy guards: `AppUpdatePrompt.swift` added to `ios-fleet-pin.sh` / `check-drift.sh`; vitest + XCTest cover the contract.

Touched files:

- `scripts/ios-fleet/AppUpdatePrompt.swift`
- `ios/SocraticTrade/AppUpdatePrompt.swift`
- `ios/SocraticTradeTests/AppUpdatePromptTests.swift`
- `scripts/ios-fleet/apps.json`
- `scripts/ios-fleet/ios-app-versions.json`
- `scripts/ios-fleet/ship-testflight.sh`
- `scripts/ios-fleet/check-drift.sh`
- `scripts/ios-fleet/README.md`
- `scripts/ios-fleet-pin.sh`
- `scripts/ios-fleet.sha256`
- `test/ios-fleet-app-update-prompt.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-25-app-update-prompt-apple-ids.md`

## Decisions & Trade-offs

- Apple IDs stay in `apps.json` (ship registry) and `ios-app-versions.json` / public `versions.json` (runtime prompt).  The Swift file is behavior only.
- Public `jaywedgeworth22/ios-app-versions` already has `net.dealdex` 6802474288.  The local mirror now matches that live key.  `online.dealdex` remains on the public file until a publish from a DealDex ship or a dedicated manifest edit; the prompt keys by the installed bundle, so a `net.dealdex` install does not read the stale row.
- Did not add a `dealdex` ship CLI key.  Did not upload anything.  Did not change TestFlight testers.

## Verification State

- `bash scripts/ios-fleet-pin.sh --check` — OK
- Focused vitest on the first PR plus hosted `ios-build` run `32808123472` — ** TEST SUCCEEDED ** (242/0)
- Squash-merged to `main` as `df75ca6f` at 2026-08-25T04:32:24Z

## Next Steps & Blockers

- Generated `AppUpdatePromptTests.swift` pbxproj refs from `32808123472` landed via leftover #3103 squash `64a06e78`.  Rollout: `docs/rollouts/2026-08-25-app-update-prompt-pbxproj.md`.
- Optional: drop `online.dealdex` from public `versions.json` so the stale bundle is not listed as a live app.  Do not add `me.grok.dealdex`.
- Do not `--force-ship`.  Do not dispatch `ios-ship.yml` from this change unless the owner asks.

## Zero-Code Findings

None.  This is a pin/copy + manifest correction.
