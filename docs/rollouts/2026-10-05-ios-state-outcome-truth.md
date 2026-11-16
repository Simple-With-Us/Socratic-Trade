# iOS sign-out cache + money-action outcome surfacing

## Context & Objective

Board item `ios-state-outcome-truth` (`3b3439332c4f481c`): after sign-out, the previous account's portfolio must not flash on screen, and approve placement outcomes must surface honestly when the server returns `result.status` (for example `busy`, `not_placed`) even when the command row is `succeeded`.

## Changes Made

- Split session teardown in `MobileStore`: `clearAccountScopedUIState()` drops in-memory account UI immediately; `clearPersistedSessionCredentials()` clears cookies + UserDefaults after the authenticated push delete.
- `signOut()` now clears UI first, then awaits push unregister, then clears persistence (cookies stay valid for the delete).
- `CommandAttemptTracker.Resolution` carries `commandID` so `reconcileTrackedCommands` can read `proposal.approve` placement `result` and set `successMessage` / `error` via `AppFormat.placementApproveMessage`.
- XCTest: account-scoped clear leaves disk cache until credentials clear; proposal card feedback for `succeeded` + `busy` placement; tracker resolution includes `commandID`.

**Files**

- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `docs/rollouts/2026-10-05-ios-state-outcome-truth.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`

## Decisions & Trade-offs

- `clearAccountScopedUIState()` is `internal` (not `private`) so XCTest can assert sign-out ordering without standing up push mocks.
- `bindProposalCommand(proposalId:commandId:)` is a narrow XCTest seam for card feedback without a full mocked submit round-trip.
- Did not move session cookies to Keychain (`ios-engineering:ios-14`) — out of scope for smallest correct fix.

## Verification State

```bash
npm run lint          # 0 errors
npx tsc --noEmit      # clean
```

Swift compile + XCTest: **not run on this Linux cloud seat** — verify via hosted `.github/workflows/ios-build.yml` (`xcodebuild test` on `macos-latest`).  New cases:

- `MobileModelsTests.testClearAccountScopedUIStateDropsSnapshotBeforeDiskCache`
- `MobileModelsTests.testProposalActionFeedbackSurfacesBusyPlacementOnSucceededApprove`
- `CommandAttemptTracker` resolution expectations updated for `commandID`

## Next Steps & Blockers

- Merge after `ios-build` green on the PR branch.
- Owner: resolve board item `3b3439332c4f481c` / `ios-state-outcome-truth` when shipped TF includes this commit.

## Zero-Code Findings

- UserDefaults snapshot clear on `clearLocalSession` and placement `result` decoding were already on `main` from PR #2863; this pass closes the in-flight sign-out flash and global toast honesty for tracked approve reconciles.
