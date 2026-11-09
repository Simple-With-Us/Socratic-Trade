# Rollout Handoff: Non-Blocking Quote Staleness Gate & ROIC Level 5 Fallback

## 1. Context & Objective
The goal of this change is to prevent stale data checks from blocking proposal generation, manual approvals, and strategy execution. If pricing data is determined to be stale, the system converts the order to a `limit` order to guarantee the execution price matches or beats the reference price, logs a warning on the rationale, audits the event, and triggers a user notification instead of hard blocking.

## 2. Changes Made
- **Level 5 Cascade Fallback:** Appended `RoicAiEnrichmentProvider` lookup to [`src/lib/quotes-cascade.ts`](file:///Users/jay/apps/trading-antigravity/src/lib/quotes-cascade.ts) to query the profile endpoint as a final tier in the cascade series.
- **Policy Check Refactor:** Updated the quote staleness gate in [`src/lib/policy.ts`](file:///Users/jay/apps/trading-antigravity/src/lib/policy.ts) to be non-blocking. When triggered, it:
  - Mutates `proposal.type` to `"limit"`.
  - Caps the `proposal.limitPrice` using `referencePrice` (min cap on buy, max cap on short).
  - Appends details directly to `proposal.rationale`.
  - Populates `quoteStale` metadata on the returned `PolicyDecision` object defined in [`src/lib/types.ts`](file:///Users/jay/apps/trading-antigravity/src/lib/types.ts).
- **Placement Audit & Notifications:** Updated [`src/lib/strategy.ts`](file:///Users/jay/apps/trading-antigravity/src/lib/strategy.ts) and [`src/lib/strategy-execution.ts`](file:///Users/jay/apps/trading-antigravity/src/lib/strategy-execution.ts) to detect `decision.quoteStale` during order placement, write a `quote_staleness_warn` audit row, and push a `provider_degraded` alert to the user. Hoisted `proposalId` variable creation to prevent TDZ/shadowing block clashes in the strategy run loop.

## 3. Decisions & Trade-offs
- Exits (sells/covers) remain entirely ungated.
- Mutated limit orders protect the execution price against the proposed reference price.

## 4. Verification State
- **Unit Tests:** All tests in [`test/staleness-gate.test.ts`](file:///Users/jay/apps/trading-antigravity/test/staleness-gate.test.ts) updated to assert the new limit-conversion and warning behaviors. Passed: 13/13.
- **Integration Tests:** [`test/chat-draft-policy.test.ts`](file:///Users/jay/apps/trading-antigravity/test/chat-draft-policy.test.ts) updated to verify that preview promotions stage properly under staleness. Passed: 10/10.
- **Type Safety & Lints:** Types (`npx tsc --noEmit`) and lints (`npm run lint`) check out with 0 errors.
- **Production Build:** Full production build (`npm run build`) completed successfully with zero compile warnings.

## 5. Actionable Next Steps
- Land the branch via `bash scripts/land.sh`.
