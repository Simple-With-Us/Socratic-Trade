# ST-4654 policy duplicate-note guard (2026-11-22, Muse Code MC)

## Context & Objective
ST-4650 fleet-sweep money-path careful queue.  `evaluateTradeProposal` annotates `proposal.rationale` in place, and the same object is re-evaluated for real (planning pass in `strategy.ts`, then the approval re-check in `strategy-execution.ts` on the persisted proposal JSON), so the bracketed stale-quote and scan-age notes literally doubled in user-facing rationale text.

## Changes Made
- `src/lib/policy.ts`: `appendRationaleNoteOnce` helper; the four rationale-append sites (stale-quote backup x2, scan-age x2) append only when their bracketed marker is absent.  Nothing else in the evaluator changed; the load-bearing market-to-limit coercion and limit pinning are untouched and numerically idempotent (buy min / short max against a stable reference price).
- `test/policy-idempotence.test.ts` (new, 5 tests): approved scan-age and blocked cases assert full deep equality of proposal AND decision across two evaluations of the same object; stale-quote buy/short cases assert proposal deep-equal, single note, identical approval/reasons.  Pre-fix the suite failed 4/4 with literally doubled notes.

## Decisions & Trade-offs
- EstimateNotional persisted-anchor skip intentionally NOT done: `executionPriceSource`/`reference_submitted` do not exist anywhere in this base (grep-verified; `referencePriceProvenance` is not a submitted/fill anchor), and `estimateNotional` is a pure three-line derivation that `policy.ts:334` already bypasses when `context.estimatedNotional` is supplied.  Inventing the proof would violate the careful-slice rule; it stays open on ST-4654 until a persisted anchor lands.
- Residual re-evaluation divergences deliberately left: on re-eval of a stale-quote-converted proposal, `decision.quoteStale.originalType/originalLimitPrice` report the converted values (audit-only consumers), and entry-drift/permitted-order-type checks evaluate against the converted limit type.  Full decision deep-equality there would require persisting originals on `TradeProposal` — a bigger money-path diff than this slice allows.
- Dollar-exit semantics and the SQL daily-notional rewrite untouched, per the critic downgrades on ST-4654.

## Verification State
- Writer lane: pre-fix 4/4 failing to post-fix 5/5 on the new suite; regressions 85 + 123 passed; tsc clean; eslint 0 errors.  First-evaluation output byte-identical (existing staleness-gate assertions unchanged).
- Parent on harvested tree: full `npm run lint` 0 errors, `npx tsc --noEmit` clean, targeted vitest 7 files / 209 tests passed, `npm run build` exit 0.  Full serial suite runs in CI verify.

## Next Steps & Blockers
- Owner merge after review (`policy.ts` money path).  Overlap watch: #5436 also edits `policy.ts` (dead-PDT removal) in different regions; expect at most a trivial merge.

## Zero-Code Findings
- The estimateNotional anchor does not exist in this base or in any in-flight sibling branch checked; see Decisions.
