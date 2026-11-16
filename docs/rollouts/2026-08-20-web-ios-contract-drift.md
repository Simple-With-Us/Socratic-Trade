# 2026-08-20 — `web-ios-contract-drift`: a fixture that fails when the API and the Swift decoder disagree

## Context & Objective
Tranche-1 cluster from the 2026-08-18 review (issues #2912, #2943).  Swift decoders are hand-mirrored from route payloads with nothing pinning them together, so a server-side rename silently blanks a list on the phone or leaves a field reading "—" forever, and every gate stays green.

## What changed vs what the plan expected
The cluster's headline member, `api-01` (iOS Guardrails stop-loss rows always show "—" because `FullPolicy` read `stopLossPct` at the top level while the server nests it under `riskRules`), **was fixed on `main` by PR #2863 while this work was in flight.**  This branch therefore does NOT re-fix it: the competing decode was dropped and `main`'s landed version kept.  What remains is the part `main` still lacks — the mechanism that makes the whole drift class fail loudly next time.

## Changes Made
- `ios/SocraticTradeTests/Fixtures/policy-contract.json` (NEW) — a committed fixture of the real `GET /api/policy` shape, including the nested `riskRules` container.
- `test/policy-ios-contract-fixture.test.ts` (NEW) — asserts the server's actual policy payload still matches that fixture, so a TypeScript-side rename fails CI instead of shipping.
- `ios/SocraticTradeTests/DeskModelsTests.swift` — decodes the same committed fixture through `FullPolicy`, so the Swift side is pinned to the identical bytes.
- `ios/Socratic Trade.xcodeproj/project.pbxproj` — regenerated via XcodeGen to wire the new `Fixtures/` resource into the test target.

## Verification State
- `npx tsc --noEmit` clean · `npm run lint` 0 errors · `npm test` **7109 passed** / 51 skipped, 0 failures · `npm run build` exit 0.
- `xcodebuild build -scheme SocraticTrade -destination 'generic/platform=iOS'` — **exit 0**.
- **Honest gap:** `xcodebuild test` cannot execute.  `main`'s own test target does not compile — `ios/SocraticTradeTests/MobileModelsTests.swift:403/425/445` call `JSONEncoder().encode(snapshot)` on a type that is not `Encodable` (5 errors, present on a clean `origin/main` checkout; that file arrived in #2863, unrelated to this branch).  The Swift assertion here is therefore committed but unrunnable until that is repaired.  The TypeScript half of the contract runs and passes.
- Assembly note: the implementing agent's worktree was based on an older `main`; copying whole files forward clobbered `washSaleMinLossUsd`, `equityWaitingOnBroker`, `portfolioUnavailableMessage` and one `scanRefreshFailed`, and broke the Swift build.  Caught by running `xcodebuild` locally, then fixed by applying the agent's diff as a 3-way patch instead of copying files.  This is the merge hazard AGENTS.md documents from 2026-08-13.

## Scope Honesty
Closes `api-01` (already closed on main by #2863 — this branch just stops it regressing).  **`qa-04` remains OPEN**: a contract test for `/api/mobile/snapshot`'s array-blanking decode path is still unwritten.  The pattern built here is what it should use.

## Next Steps
- Repair `main`'s iOS test target (reported to the fleet; likely GB-CONDUCTOR's "3 failing tests on main" slice) so Swift contract assertions can actually run.
- Apply this fixture pattern to `/api/mobile/snapshot` to close `qa-04`.
