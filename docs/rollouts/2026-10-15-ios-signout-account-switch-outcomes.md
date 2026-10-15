# iOS sign-out, account switch, and money-action results

## Context & Objective

Linear ST-2578.  PR #4214 cleared the in-memory portfolio during sign-out and surfaced approve placement text, then merged with the issue still open.  A switch to another account could still paint the previous snapshot from UserDefaults or the URL cache, and reject and cancel did not say whether they succeeded, failed, or could be retried.

## Changes Made

- Sign-out drops the in-memory account stores, the UserDefaults snapshot and its timestamp, and `URLCache` before the authenticated push unregister.  Cookies stay until that unregister finishes.  `clearLocalSession` (expired session) still ends by removing the same caches and the cookies.
- Account switch uses `clearAccountScopedCachesForAccountSwitch` before the new snapshot load.  The session cookie and the pending account id stay.  `sessionEpoch` bumps so `MobileControlView` is recreated and view-local stores (Coach, scan, policy sheets) do not keep the previous account.  Tab layout and the Coach model preference are device settings and are not removed.
- Snapshot GETs use `reloadIgnoringLocalCacheData`.
- Approve, reject, and cancel classify to success, failed, or retryable.  `StoreTransientAlerts` presents that result with its own title.  Proposal cards use the same split, including a retryable state that does not lock the buttons.
- Explicit sign-out no longer forgets the APNs token locally before `signOutAndForgetToken` reads it.
- Account switch re-seeds the in-flight `account.activate` attempt after the cache wipe so reconcile can drop its busy flag.
- A money-action result carries the proposal id.  A success on one proposal does not repaint another proposal's failure.
- `check-pin` reads public Congress.Trade with `GITHUB_TOKEN` first.  `GH_PACKAGES_TOKEN` is only the rate-limit fallback.  Preferring the owner PAT made the check fail on every PR while that shared budget was spent.

**Files**

- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/ProposalsView.swift`
- `ios/SocraticTrade/SocraticTradeApp.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `ios/SocraticTradeTests/AccountScopeAndMoneyActionTests.swift`
- `scripts/check-shared-package-pin.mjs`
- `test/shared-package-pin-check.test.ts`
- `.github/workflows/shared-package-pin-check.yml`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-10-15-ios-signout-account-switch-outcomes.md`

## Decisions & Trade-offs

- Device preferences stay.  Wiping tab layout and the Coach model on every account switch would throw away choices that are not account data.
- `clearAccountScopedUIState` still leaves the disk snapshot in place.  The existing test locks that ordering for the push-delete window.  `clearLocalSession` and `signOut` remove it before they return.
- Retryable copy prefers the server sentence when one exists.  "Try again" inside an account-mismatch cancel stays failed, because repeating the same cancel cannot succeed.
- No server contract change.  The phone classifies the command row it already receives.

## Verification State

```bash
npm run lint          # exit 0, 0 errors, 854 warnings (grandfathered)
npx tsc --noEmit      # exit 0
npm test              # 23 failed, 9376 passed, 51 skipped
npm run build         # exit 0
npx vitest run test/shared-package-pin-check.test.ts  # 6 passed
```

The 23 vitest failures are in LLM key routing, notify credentials, and server-metrics.  They expect an empty provider-key environment and this seat has provider keys set.  None of them import the iOS tree.

Swift compile and XCTest are not run on this Linux seat.  Hosted `.github/workflows/ios-build.yml` is the compile.  New cases:

- `AccountScopeAndMoneyActionTests.testSignOutClearsEveryAccountCacheAndStore`
- `AccountScopeAndMoneyActionTests.testAccountSwitchClearsCachesAndKeepsTheSession`
- `AccountScopeAndMoneyActionTests.testApproveRejectAndCancelReportSuccessFailedAndRetryable`
- `AccountScopeAndMoneyActionTests.testAccountSwitchReleasesTheBusyFlagAfterTheCacheWipe`
- `AccountScopeAndMoneyActionTests.testMoneyResultDoesNotRepaintAnotherProposal`
- `MobileModelsTests.testProposalActionFeedbackSurfacesBusyPlacementOnSucceededApprove` now expects `.retryable`

## Next Steps & Blockers

- Wait for `ios-build` on the PR.  Do not arm auto-merge.  The PR carries `do-not-automerge`.
- Mark ST-2578 completed only after merge, and deployed only after the live binary includes this commit.

## Zero-Code Findings

- PR #4214 merged on 2026-10-06 and left ST-2578 In Progress under GROK.  This run took the claim because the owner reassigned the remaining work.
