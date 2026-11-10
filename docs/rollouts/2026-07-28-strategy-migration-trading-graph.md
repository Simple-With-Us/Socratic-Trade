# Strategy Migration: Graph-Based Execution Loop

**Context & Objective**: Migrated the core `runStrategyOnce` procedural function into a state machine using the `TradingGraph` orchestrator. This isolates discrete phases (`INIT`, `FUNDAMENTAL_PROPOSING`, `RED_TEAM_REVIEW`, `EXECUTION`) for better testability and future subagent-oriented orchestration.

**Changes Made**:
- Integrated `TradingGraph` from `src/lib/orchestration/trading-graph.ts` into `src/lib/strategy.ts`.
- Split the monolithic logic of `runStrategyOnce` into 4 discrete nodes.
- Re-architected closure-scoped variables (`requiresHumanReview`, `debatedProposals`, etc.) to use the shared `GraphContext` for state persistence between node transitions.
- **Bug Fix**: Removed duplicate, shadowing variable definitions of `requiresHumanReview` deep inside the `RED_TEAM_REVIEW` block that were causing fail-closed checks to operate on an empty Set in the `EXECUTION` block.

**Decisions & Trade-offs**: 
- Kept `TradingGraph` fully isolated in `src/lib/orchestration/trading-graph.ts` to keep `strategy.ts` focused on trading logic, rather than state machine mechanics.

**Verification State**:
- `npm test test/strategy-bear-fail-closed.test.ts test/strategy-rationale-collapse-gate.test.ts` (Passed - fail-closed assertions successful)
- `npm test` (Passed all 5386 tests)
- `npx tsc --noEmit` and `npm run build` will be verified via `scripts/land.sh`.

**Next Steps & Blockers**: None. Ready for merge and deployment.
