# 2026-07-09 — Single-adversary consolidation: Mac-side landing (MONET)

## Summary

Landed the single-adversary consolidation (branch `monet/single-adversary-consolidation`,
Cowork-lane implementation) onto `main` from the Mac worktree `~/apps/trading-monet-sac`. This
session was the **landing operator**: the feature itself was authored in the earlier Cowork Claude
session (see `docs/rollouts/2026-07-07-single-adversary-consolidation-impl.md`). Work here was
merging `origin/main` (47 commits ahead of the branch fork) into the branch, resolving the
conflicts per the authoritative principles in `/Users/jay/apps/monet-handoff-2026-07-09.md`,
reconciling several **semantic** (marker-free) conflicts the auto-merge introduced, and driving the
full local gate + `land.sh`.

## Why

The consolidation was code-complete and verified on Linux x64 but never landed; `origin/main` had
moved 47 commits (this week's owner-directed features: model-stats drawer #1115, model-picker
naming, per-account LLM usage attribution #1030/migration v14, PWA icons, bracket stops, etc.). The
merge had heavy overlap in the adversarial-review path — exactly the money-path code both parents
rewrote — so it required careful conflict resolution rather than a mechanical merge.

## Conflict resolution (per handoff spec a–h)

Six git-marked conflicts + four semantic (marker-free) conflicts:

**Git-marked:**
- `src/lib/strategy.ts`, `src/lib/red-team.ts` — the prior subagent had already resolved these to
  zero markers (their rewrite wins structurally, spec a/d); re-verified against the spec.
- `app/console/settings/models.tsx` (spec f) — kept main's "Proposer Model"/"Reviewer Model"
  naming + `ModelStatsButton` drawer (#1115), integrated the consolidation's fail-closed messaging
  (both models required, no default, empty routes to approval).
- `app/console/components/approval-card.tsx` (spec c/d/h) — kept the consolidation's no-defaults
  model attribution (`"unknown"`, never a fabricated default) + approve-at-half verdict rendering,
  AND main's honest failure attribution (`redTeamFailureMeta`/`redTeamFailureModel`, the
  `!available` "review failed" branch, trigger-guard chip).
- `docs/EFFORT-LOG.md` — additive union of both sides.
- `test/red-team.test.ts` — reset to the consolidation's coherent suite (new 2-arg signature,
  three-way `{verdict, reason}` shape) and re-added the #1091 bare-array recovery guards adapted to
  the new signature (spec d).

**Semantic (no git marker — auto-merge silently combined incompatible sides):**
- `parseBearSurvivors` (strategy.ts) + `test/inline-bear-parse.test.ts` — inline-Bear #1095
  stopgap, dead after the inline-Bear deletion (no call sites). **Deleted** per spec a.
- `BEAR_UNAVAILABLE_ALERT_COOLDOWN_KEY`/`_MS` constants (strategy.ts) + `bearUnavailable()` alert +
  `strategy_bear_review_unavailable` audit kind + `test/strategy-bear-alert-cooldown.test.ts` —
  the consolidation removed this inline-Bear alert machinery and replaced it with the per-proposal
  `strategy_red_team_unavailable` audit + human-review routing + `adversaryUnavailable` amber card
  badge. main's orphaned constants + alert test leaked through the merge. **Deleted** the orphaned
  constants and the test (spec a: the stopgap dies with the code it guarded); operator visibility
  is preserved via the new audit kind + fail-closed routing.
- `test/e2e-money-path.test.ts` (main-added) — expected a placed order but its policy set no
  `redTeamLlmModel`, so the no-defaults reviewer failed closed → "proposed". **Fixed** by giving
  the policy an explicit `redTeamLlmModel` and updating the stubbed verdict from the old
  `{rejected}` shape to the three-way `{verdict:"approve"}` shape so the money path completes.
- `scripts/benchmark-llm-models.ts` (main-added) referenced the deleted `buildBearSystem` and the
  renamed `LLM_OUTPUT_TOKEN_CAPS.strategyCritique`. **Rewired** the red role to the single-reviewer
  API: `buildRedTeamReviewSystem({side,symbol})` + the real `RED_TEAM_VERDICT_SCHEMA` (now exported
  from `src/lib/red-team.ts`) + `LLM_OUTPUT_TOKEN_CAPS.adversaryReview`.

Verified the spec-b latency-capture concern: BOTH parents already use `withLlmGeneration` (not
`recordLlmOutcome`) for the reviewer call, so nothing was grafted on; `recordLlmOutcome` step:"bull"
stays on the Bull call in the strategy loop. Migration v15 (`seed_red_team_model_from_env_override`)
is the next free version (main took v14 for `llm_usage_connected_account`); no renumber needed.

## Files (beyond the mechanical merge)

- `src/lib/strategy.ts` — deleted `parseBearSurvivors` + orphaned `BEAR_UNAVAILABLE_*` constants.
- `src/lib/red-team.ts` — `export const RED_TEAM_VERDICT_SCHEMA`.
- `app/console/settings/models.tsx`, `app/console/components/approval-card.tsx` — merged resolutions.
- `scripts/benchmark-llm-models.ts` — red role rewired to the reviewer API.
- `test/red-team.test.ts` — reset to consolidation suite + #1091 bare-array guards.
- `test/e2e-money-path.test.ts` — reviewer model + three-way verdict stub.
- Deleted: `test/inline-bear-parse.test.ts`, `test/strategy-bear-alert-cooldown.test.ts`.
- `docs/EFFORT-LOG.md` (union), `STATUS.md`, this rollout note.

## Verification (actually run in `~/apps/trading-monet-sac`)

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (360 grandfathered warnings).
- `npm test` — 302 files / 3121 tests pass.
- `npm run build` — succeeds.
- `land.sh` — (recorded on the PR).

## Follow-ups

- Then-unblocked queue (do not start until this merges): `reviewedByModel` per-proposal stamp,
  Mistral capability-map fix, strategy.ts split.
- Stale example comment `strategy_bear_review_unavailable` remains in `src/lib/db-execution.ts`
  (line ~273) and a consolidation-authored comment in `test/redteam-failure-routing.test.ts` —
  harmless, left as-is (out of scope for this landing).
