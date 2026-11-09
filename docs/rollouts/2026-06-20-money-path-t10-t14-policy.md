# 2026-06-20 — Money-path T10 (gross/net gates) + T14 policy cleanups

## Summary

Implemented the previously-silent whole-portfolio gross/net exposure gates and the
`policy.ts` half of T14, with tests. Part of the money-path safety plan; a concurrent
agent is running the other tasks (T5 done, T6/T9/T11–T14 in flight) in parallel in this
same `agent/claude` worktree, so this commit is scoped strictly to `policy.ts` +
`policy.test.ts` to avoid collision.

## What changed

- **T10 — `src/lib/policy.ts`.** `maxGrossExposurePct` / `maxNetExposurePct` were defined
  (`types.ts`), defaulted to 100 (`defaults.ts`), and adjustable by the LLM tuner
  (`strategy-tuning.ts`) but were NEVER read by `evaluateTradeProposal` — silent no-ops.
  Now enforced: gross = Σ|marketValue| (total involvement / leverage), net = Σ marketValue
  (directional bias). Each blocks only an order that pushes the metric FURTHER past its cap
  — a risk-reducing close is always allowed — mirroring the side-aware per-symbol/sector
  caps. Default 100% remains non-binding for normal flow.
- **T14 — `src/lib/policy.ts`.** (a) Returned `dailyNotionalUsed` now accumulates opening
  sides only (consistent with the daily/hourly cap checks, which are gated on `isOpening`),
  so a sell/cover no longer inflates the running daily total. (b) Removed the dead, unused
  `currentPriceForPosition` helper. The empty-account-number scoping part of T14 (db.ts
  WHERE clauses) is DEFERRED — see open questions.

## Tests (`test/policy.test.ts`)

- T10: gross cap blocks an opening buy over cap; net cap blocks an opening buy over cap;
  neither blocks a risk-reducing sell even when already over the cap; default 100% caps
  don't block a small in-policy order.

## Verification

- `npx tsc --noEmit` — clean (whole project, incl. the concurrent T5 changes).
- `npx vitest run test/policy.test.ts` — 37 passed. (Ran the policy suite only; a concurrent
  agent has in-flight work on `performance.ts`/`performance.test.ts`.)

## Open questions / follow-ups

- **Coordination:** a parallel agent is running the same plan in this worktree. Remaining
  tasks (T6, T9, T11, T12, T13, T14-db) should be divided explicitly to avoid duplicate work.
- **T10 net-exposure semantics:** the net cap compares `|Σ marketValue|` to the cap and
  blocks only when the order increases `|net|`. Confirm this matches the intended directional
  cap (vs. a signed long-only / short-only bound).
- **T14 db:** empty/missing account-number normalization in `db.ts` scoping is deferred —
  it's risky (could re-bucket existing notional across accounts) and may need a data migration.
- STATUS.md intentionally not edited here to avoid colliding with the concurrent agent's
  active edits to it; add a T10/T14 line when convenient.

## Blockers

- None.
