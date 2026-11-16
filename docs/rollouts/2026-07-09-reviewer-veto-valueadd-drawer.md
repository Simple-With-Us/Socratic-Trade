# 2026-07-09 - reviewer-veto-valueadd-drawer

## Summary

- The Model Stats drawer (info affordance next to the Proposer/Reviewer model
  pickers on `settings/models` + the strategy page) previously showed a
  hard-coded dash in the 4th column for the Reviewer (Red Team) role. That
  column now surfaces **per-reviewer-model veto value-add** — the ALREADY-BUILT
  metric that the Results page 'Red Team veto efficacy' scorecard renders and
  `getRedTeamEfficacy` computes/gates.
- This is **plumbing only**. No new financial math, no DB/schema change, no
  `strategy.ts` change, and no new `reviewedByModel` field. Veto value-add keys
  off the existing `proposal_rejected_by_red_team` audit (which already stamps
  the reviewer model) via `getRedTeamEfficacy(userId).byModel`.

## What the metric means (and the inversion)

Veto value-add is **NOT** win-rate or realized P&L. It is the counterfactual
"had-it-run" outcome of the risk-adding proposals a reviewer model vetoed:

- `vetoValueAddRate` = % of matured vetoes whose counterfactual return was
  NEGATIVE (the veto avoided a loser). **HIGHER = BETTER.** Rendered as
  "X% good vetoes".
- `avgReturnPct` = mean counterfactual return of the vetoed names.
  **NEGATIVE = GOOD** (losses avoided). Rendered via the existing
  `redTeamReturnTone`, so a negative average shows in the positive/"good" tone
  (`--con-pos`) and a positive average in the "bad" tone (`--con-neg`) — the
  same inversion the Results scorecard uses.
- Sample unit = one matured blocking veto keyed `(runId, symbol)`; it resolves
  ~5 trading days after the veto. Gated on 20/50 MATURED vetoes with the shared
  `RED_TEAM_EFFICACY_MIN_RESOLVED` / `redTeamSampleTier` / `redTeamSampleGate`
  helpers (identical to the scorecard).

## Why

- Owner-directed: the Reviewer column's dash was a placeholder; the metric was
  already computed, gated, and rendered on the Results page but never plumbed
  into the drawer. This gives the Reviewer picker the same per-model decision
  support the Proposer picker already has (realized performance).

## Files

- `src/lib/model-stats.ts` — new `ReviewerPerf` interface + `reviewerPerf:
  ReviewerPerf | null` field on `ModelRoleStats`; `AggregateModelStatsInput`
  gains optional `reviewerPerfByModel`; `aggregateModelStats` builds a
  model→ReviewerPerf map (skipping the `"unattributed"` bucket, adding those
  models to the modelSet) and sets `reviewerPerf` on RED rows only (null on
  GREEN and on RED rows with no matching data). Updated the file header comment.
- `app/api/llm-usage/model-stats/route.ts` — imports `getRedTeamEfficacy`;
  calls it USER-WIDE (`{ auditLimit: 500 }`, no `connectedAccountId`) so it
  aggregates across all the user's accounts (matching how the Proposer's
  realized P&L already spans accounts); passes `.byModel` as `reviewerPerfByModel`.
- `app/console/components/model-stats-drawer.tsx` — mirrored `ReviewerPerf` +
  `reviewerPerf` field into the hand-duplicated interfaces; imports and reuses
  the gates/tone from `app/console/lib/red-team-efficacy.ts` (does not redefine
  them); replaced `PerfCell`'s red-team early-return dash with a `ReviewerPerfCell`
  that renders "X% good vetoes · avg ±Y%" (avg toned via `redTeamReturnTone`) and
  a tier chip (caution → warn `small sample (n=X)`, ready → plain `resolved n=X`),
  or a faint `— needs >=20 resolved vetoes (n=X)` below threshold; made the 4th
  column header role-aware ("Realized performance" / "Veto value-add"); rewrote
  the reviewer footnote and the drawer's top file comment.
- `test/model-stats.test.ts` — new `aggregateModelStats — reviewer veto value-add`
  block: `reviewerPerf` populates on the matching RED row and stays null on the
  GREEN row; the `"unattributed"` bucket is excluded; RED rows without matching
  data (and with no input) default to null.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (369 grandfathered warnings; all touched files lint
  clean, no new warnings).
- `npm test` — 306 files / 3171 tests pass (includes the new reviewer block and
  the existing `red-team-efficacy-ui.test.ts` gate coverage).
- `npm run build` — compiled successfully, all pages generated.

## Follow-ups

- **Forward-only data (honest note):** there is NO retroactive veto backfill.
  The Reviewer column stays at "needs >=20 resolved vetoes (n=X)" for a model
  until 20 of its blocking vetoes mature (~5 trading days each), and carries the
  small-sample caveat until 50. New/rarely-picked reviewer models will show the
  gated placeholder until enough of their vetoes resolve — this is expected, not
  a bug.
- The drawer duplicates `src/lib/model-stats.ts`'s response shapes by hand (a
  pre-existing pattern); `ReviewerPerf` was mirrored verbatim. If either copy
  changes, keep both in sync.
- The `"unattributed"` filter uses a local literal in `model-stats.ts` (that
  module is a pure `src/lib` unit and does not import app-layer code); it mirrors
  `RED_TEAM_UNATTRIBUTED_MODEL` in `app/console/lib/red-team-efficacy.ts` and the
  `"unattributed"` bucket key in `getRedTeamEfficacy`.

## Concurrency

- A separate PR (`monet/model-stats-drawer-wide`) also edits
  `model-stats-drawer.tsx` but in a different region (adds a `wide` prop to the
  `<Sheet>` + CSS). The edits do not overlap at the hunk level (this change
  touches the file header comment, the interfaces/imports, `PerfCell`, the 4th
  `<th>`, and the footnote). If `scripts/land.sh`'s same-file overlap guard
  refuses, merge `origin/main` first, confirm no real conflict in
  `PerfCell`/interfaces/footnote, then re-run with `LAND_ALLOW_STALE_OVERLAP=1`.
