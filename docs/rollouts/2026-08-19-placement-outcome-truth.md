# Placement outcome truth (approve path)

## Context & Objective

Expert review cluster `placement-outcome-truth`: iOS and mobile stamped every resolved `proposal.approve` as succeeded, so blocked / busy / not_placed / retryable broker errors showed a green "Approved".  HTTP 429 and 408 were filed as terminal `rejected_by_broker` on the approval path.

## Changes Made

- Added `src/lib/placement-outcome.ts` — single classifier for `{placed, blocked, busy, retryable, rejected}` plus HTTP 429/408 vs terminal 4xx detection.
- `src/lib/strategy-execution.ts` — approval placement catch routes 429/408 to `not_placed` instead of `rejected_by_broker`; return type `ExecuteProposalResult`.
- `src/lib/mobile-api.ts` — `proposal.approve` finishes with `succeeded` only when `outcome === "placed"`; result carries `status`, `outcome`, and `reasons`.
- `ios/SocraticTrade/MobileModels.swift` — decode `MobileCommand.result`.
- `ios/SocraticTrade/MobileStore.swift` + `ProposalsView.swift` + `AppComponents.swift` — on-card feedback mirrors web `approval-card.tsx` placement tones.

Files touched:

- `src/lib/placement-outcome.ts`
- `src/lib/strategy-execution.ts`
- `src/lib/mobile-api.ts`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/ProposalsView.swift`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `test/placement-outcome.test.ts`
- `test/mobile-placement-command.test.ts`

## Decisions & Trade-offs

- Web console already renders `executeProposal.status` honestly via `approval-card.tsx`; no web code change in this PR.
- Mobile command `failed` + structured `result` is used for non-placement outcomes so existing terminal command semantics stay compatible with Activity while iOS reads `result.status` for card copy.
- Autonomous lane (`strategy.ts`) still treats all HTTP 4xx as terminal — out of scope for this cluster.

## Verification State

```bash
npm test -- test/placement-outcome.test.ts test/mobile-placement-command.test.ts
npm run lint
npx tsc --noEmit
```

All passed in Cursor Cloud (vitest 8/8 on new tests; lint 0 errors; tsc clean).  iOS XCTest not run in cloud VM.

## Next Steps & Blockers

- Merge PR; auto-deploy applies on `main`.
- Optional follow-up: mirror 429/408 handling on autonomous `strategy.ts` placement path (separate cluster).

## Zero-Code Findings

None.
