# 2026-06-26 — Rationale-diversity / template-collapse check (item #8)

Branch `agent/claude-reasoning-diversity`. Improvement-program item #8.

## Summary
Detects reasoning/template collapse — when a run's proposal rationales are near-duplicate / input-agnostic
boilerplate (an LLM emitting the same canned reasoning regardless of the actual symbol/data).

- New `src/lib/rationale-diversity.ts`: pure, deterministic, dependency-light. Multiset character-trigram
  Jaccard over normalized rationale text (lowercase → strip punctuation → collapse whitespace → trim), returning
  `{ count, meanPairwiseSimilarity, maxPairwiseSimilarity, collapsed, threshold }`. `collapsed` =
  `meanPairwiseSimilarity > threshold` (default 0.85). Edge cases: 0/1 rationales → `collapsed:false`,
  similarity 0; two empty strings → Jaccard 0 (not NaN).
- `src/lib/types.ts`: `RationaleDiversity` result type.
- `src/lib/strategy.ts`: computed in `runStrategyOnce` after `applyCorrelationClusterGate` finalizes the
  proposal set; attached to `StrategyResult` (optional field, non-breaking to callers); persisted via
  `audit("rationale_diversity", { runId, ... })` (no schema change); `console.warn("[strategy] ...")` on
  collapse.
- `test/rationale-diversity.test.ts`: 30 tests (identical→collapsed, diverse→not, threshold boundary,
  empty/single, whitespace/punctuation normalization).

## Why
Item #8 — a guard against an LLM that's not actually reasoning over the inputs. Surfaces it for review without
touching trade flow.

## Design decision: advisory-only, no flag
The check is **advisory-only** — it never blocks, drops, or modifies a proposal; it only annotates the run and
logs a warning. Because it's pure with no side effects beyond an audit-log write, it's always-on (no feature
flag) per the spec's lowest-risk additive option. It cannot affect trades.

## How (model-tiered subagent team)
Run `wf_1e76947a-56e`: all sonnet (recon → design → implement → adversarial review). Review verdict:
`implementsSpec/correct/moneySafe/tscGreen/testsGreen` all true, no required fixes. Confirmed it never alters
proposal generation/selection.

## Files
- new `src/lib/rationale-diversity.ts`, `src/lib/strategy.ts`, `src/lib/types.ts`
- new `test/rationale-diversity.test.ts`
- `docs/improvement-program-2026-06-26.md`, `STATUS.md`

## Verification
- `npx tsc --noEmit` clean (post-merge with #193 + llm-required-gate); `npx vitest run
  test/rationale-diversity.test.ts test/persistence-notification.test.ts` → 45 pass.
- Full `tsc → test → build` trio via `scripts/land.sh`.

## Follow-ups
- Could later surface the diversity metric on the dashboard / strategy-flow board, and feed `collapsed` runs
  into the learning loop as a low-confidence signal. Not needed now.
