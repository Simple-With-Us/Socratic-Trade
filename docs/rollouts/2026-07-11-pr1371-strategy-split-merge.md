# 2026-07-11 — PR #1371: reconciling main's strategy.ts split refactor

## Summary

`main` picked up commit `f25e485` (PR #1397 "fix(orders): inline broker-truth reconcile on
placement throw"), which — bundled in the same squash commit — also included a large,
independent refactor (PR "Refactor strategy.ts to separate risk and execution logic", AG/Fable
session, branch `agent/strategy-split`) that split `strategy.ts` into three files:
`strategy.ts` (barrel + remaining functions), `strategy-execution.ts` (execution loop, broker
reconciliation), `strategy-risk.ts` (risk/veto gates, sizing). Merging `origin/main` into this
branch produced real conflicts because this branch's per-position-stop-plan edits are scattered
across functions that physically moved to the two new files.

Resolved by:
- Deleting from `strategy.ts` (now correctly living only in the new files): `executeProposal`,
  `reconcilePendingFills`, `flagStalePlacingIntents` (→ `strategy-execution.ts`),
  `applyDeterministicSizing` and its risk-gate siblings (→ `strategy-risk.ts`).
- Porting this branch's stop-plan logic into the new locations:
  - `strategy-execution.ts`'s `executeProposal`: re-added `preFillPosition` lookup +
    `existingPosition` on the `recordFillFromProposal` call.
  - `strategy-execution.ts`'s `reconcilePendingFills`: re-added the `liveBasisFor` lazy lookup,
    `commitStopPlanIfOpening` (stop-plan commit deferred to actual execution, not placement
    time), and made `bookExecuted` async — merged alongside main's own new
    `resolveBrokerVerificationNotifications` call on the "filled" branch (from #1397) rather
    than overwriting it.
  - `strategy-execution.ts`'s `flagStalePlacingIntents`: re-added `liveBasisFor` +
    `stopPlanBasisOverride` on the recovered-fill's `recordFillFromProposal` call — merged
    alongside main's new declined-order branch and already-booked dedup check (both from
    #1397).
  - `strategy-risk.ts`'s `applyDeterministicSizing`: re-added the `stopPlanBySymbol` parameter
    and threaded it into its call to `bracketWholeShareMinimum`.
- `bracketWholeShareMinimum` stayed in `strategy.ts` (main's split kept it there since
  `strategy-risk.ts` imports it), keeping this branch's 4-param stop-plan-aware signature —
  now `export`ed (main's version already exports it, since `strategy-risk.ts` needs it).
- `runStrategyOnce`, `proposeTrades`, `recordLlmOutcome`, `sanitizeProposals`,
  `enrichOpeningProposal`, `generateProactiveRiskProposals` all stayed in `strategy.ts` on
  main's side too, so those hunks auto-merged cleanly (git's 3-way merge, not a real conflict) —
  verified they retained every stop-plan addition after the merge.
- Two test files had import-list conflicts from functions relocating: `isRiskAddingOpening` and
  `deterministicBearFilter` now import from `../src/lib/strategy-risk` (main's structure) instead
  of `../src/lib/strategy`; kept this branch's additional imports (`filterStopPlansByLiveBasis`,
  `sanitizeProposals`, `getStopPlans`, `recordStopPlan`) alongside them.
- `npm install` to pick up the new `ts-morph` devDependency (used by the refactor's one-time
  migration scripts, not runtime code).

## Why

Two independently-developed changes landed on `main` in the same commit — a bug fix and an
unrelated structural refactor of the exact file this branch has been extending for 6 rounds of
stop-plan work. Textual conflicts were unavoidable; the risk was silently losing stop-plan logic
during the merge (a function's body auto-merges fine when untouched by the other side, but a
function that MOVED to a new file shows as a full delete on main's side, conflicting with any
edit on this branch — git can't auto-migrate edits across a file split). Resolved by identifying
exactly which of this branch's functions moved (via `git diff origin/main...HEAD -- strategy.ts`
before touching anything) and porting each one's specific diff into its new home rather than
blindly picking a side.

## Files

- `src/lib/strategy.ts` — conflict resolution: removed functions that moved out, kept
  `bracketWholeShareMinimum` (exported) with the stop-plan param
- `src/lib/strategy-execution.ts` — ported stop-plan logic into `executeProposal`,
  `reconcilePendingFills`, `flagStalePlacingIntents`; added `clearStopPlans`/`recordStopPlan`
  imports
- `src/lib/strategy-risk.ts` — added `stopPlanBySymbol` param to `applyDeterministicSizing`,
  threaded to `bracketWholeShareMinimum`; added `StopPlanStyle` import
- `test/reconciliation-risk.test.ts`, `test/strategy-hardening.test.ts` — import conflict
  resolutions only
- All other conflicted-then-auto-merged files (STATUS.md, docs/EFFORT-LOG.md, db.ts, types.ts,
  and ~35 more) — no independent changes, main's refactor content merged in as-is
- `package-lock.json` — `npm install` for the new `ts-morph` devDependency

## Verification

```
npx tsc --noEmit   # clean
npm test           # 323 files / 3590 tests passed
npm run build      # clean (next-env.d.ts / tsconfig.json restored after)
npm run lint       # 0 errors, 408 pre-existing grandfathered warnings
```

## Follow-ups

- Still open: OCO sibling-identity pairing (see PR #1331's comment thread) — needs a broker API
  change to fix precisely.
- Auto-merge was enabled on PR #1371 by the owner before this merge landed; pushing this commit
  should let CI re-run and auto-merge proceed once green.
