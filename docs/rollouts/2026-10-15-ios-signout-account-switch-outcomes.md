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

CODEX takeover local gates after merging main through `e81fd0da`: `npm run lint` passed with 0 errors and 866 existing warnings; `npx tsc --noEmit` passed; `npm run build` passed.  After later merging `origin/main` through `3b8e3e4b`, lint (0 errors, 866 warnings), TypeScript, and build passed again.  The unique diff contains no TypeScript or Vitest files, so no focused Vitest file applies.

Swift compile and XCTest are not run on this Linux seat.  Hosted `.github/workflows/ios-build.yml` is authoritative.  Run `38798340547` built successfully and reported an assertion failure against `URLCache.shared`; the account-switch case passed on that rerun.  Foundation documents an unavoidable race when reading and writing the same request through `URLCache`; the regression tests used a singleton and the same request across cases.  They now use each ephemeral session's private URL cache and cookie storage, and sign-out removes cookies from the storage used by its client session.  Fixed-head run `38800275016` is green: 273/273 XCTest cases, full `verify-hosted` lint/typecheck/test/build, and aggregate `verify`.  The temporary failure-only `xcresulttool` workflow diagnostics were reverted after the isolated tests passed.  The final unique diff is the ten iOS/handoff paths.  New cases:

- `AccountScopeAndMoneyActionTests.testSignOutClearsEveryAccountCacheAndStore`
- `AccountScopeAndMoneyActionTests.testAccountSwitchClearsCachesAndKeepsTheSession`
- `AccountScopeAndMoneyActionTests.testApproveRejectAndCancelReportSuccessFailedAndRetryable`
- `AccountScopeAndMoneyActionTests.testAccountSwitchReleasesTheBusyFlagAfterTheCacheWipe`
- `AccountScopeAndMoneyActionTests.testMoneyResultDoesNotRepaintAnotherProposal`
- `MobileModelsTests.testProposalActionFeedbackSurfacesBusyPlacementOnSucceededApprove` now expects `.retryable`

## Next Steps & Blockers

- CODEX takeover 2026-10-15: merged `origin/main` at `e81fd0da` and later `3b8e3e4b` with merge commits and no textual conflicts.  Fixed-head `989eaac0` passed required CI run `38800275016` (273 XCTest cases and full `verify-hosted`).  No review threads remain unresolved.  Reverted temporary workflow diagnostics; the unique diff remains exactly the ten iOS/handoff paths.  The #4737 merge commit still needs a fresh push and CI.  Remove `do-not-automerge` and arm auto-merge only after final-head required checks pass, as Jay directed.
- Mark ST-2578 completed only after merge, and deployed only after the live binary includes this commit.

## Zero-Code Findings

- PR #4214 merged on 2026-10-06 and left ST-2578 In Progress under GROK.  This run took the claim because the owner reassigned the remaining work.
