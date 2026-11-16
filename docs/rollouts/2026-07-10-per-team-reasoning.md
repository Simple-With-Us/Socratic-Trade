# 2026-07-10 — Per-team reasoning levels, rotation auto-effort, usage & Learning Review links

**Agent:** Claude (Fable), branch `claude/per-team-reasoning` off fresh `origin/main` (9236ec70,
post-#1340 Settings IA restructure). Owner-directed, four items.

## Summary

1. **Per-team reasoning levels.** One policy field (`llmReasoningEffort`) used to steer BOTH the
   Proposer (Green) and the Reviewer (Red) — an owner-flagged confusing overlap. There is now a
   reviewer-specific `redTeamReasoningEffort` (named to mirror `redTeamLlmModel`):
   - Legacy `llmReasoningEffort` is formally the **PROPOSER's** (doc'd in types.ts/defaults.ts).
   - The reviewer **falls back to the proposer's value until explicitly set**. The fallback lives in
     exactly one place: `resolveReviewerReasoningEffort(policy)` in `src/lib/llm-request.ts`; call
     sites never read `policy.redTeamReasoningEffort` directly.
   - Wired at every reviewer/red-team resolution: `debateProposal` (`src/lib/red-team.ts`, the wire
     `reasoningEffort`), `policyForTuningReviewer` (`src/lib/strategy-tuning.ts` — when the AI-review
     reviewer inherits the Red model it now carries the reviewer's effort too), and the AI-review
     panel's default value in the Framework UI. Green sites (strategy.ts proposeTrades & failover)
     keep reading `llmReasoningEffort` — that IS the proposer's field.
   - `validatePolicy` (`app/api/policy/route.ts`) now applies the interactive gpt-5.5+high rejection
     PER TEAM — the proposer combo with the proposer's effort, the reviewer combo with
     `resolveReviewerReasoningEffort` — and a violating combo on EITHER team rejects with a message
     naming which team ("Proposer (green team): …" / "Reviewer (red team): …"). New enum validation
     for the new field; `reasoningConfigChanged` gate extended so stale stored configs still never
     block unrelated saves.
   - **No default for `redTeamReasoningEffort`** on purpose: absent means "inherit the proposer's";
     a seeded default would break the fallback for every policy. Account-scoped automatically (it is
     not in `USER_LEVEL_POLICY_FIELDS`); deliberately NOT added to `LEGACY_STRATEGY_MODEL_FIELDS` /
     the db.ts v7 migration lists — those seed legacy user-level values and this field never existed
     at user level.

2. **Framework UI (`app/console/strategy/page.tsx`).** The single shared "Reasoning / Thinking"
   select is replaced by PER-SEAT controls:
   - Each picker (Proposer / Reviewer) gets its own reasoning select (`#proposer-effort` /
     `#reviewer-effort`), rendered only when THAT seat's model exposes a reasoning knob
     (`reasoningControlForModels([model])` — already per-model). Models with no knob get a one-line
     disclosure instead.
   - The reviewer select has a blank "Same as proposer (<resolved label>)" option representing the
     unset/inheriting state; picking it saves `redTeamReasoningEffort: null` (stripped to absent).
   - Curated per-model guidance renders under each control from the NEW
     `src/lib/model-reasoning-recommendations.ts` (extends PR #849's curated catalog with the
     reasoning dimension; lives in src/lib because both the rotation server path and the UI consume
     it, and src/lib must not import from app/). gpt-5.5's advice surfaces the interactive-high rule
     BEFORE any save, and the High option is `disabled` in the select for gpt-5.5 (labelled
     "— disabled for interactive runs") so the doomed 400 can't be picked at all.
   - `seatReasoningPatch` (replaces `reasoningPatchFor` in
     `app/console/strategy/reasoning-control.ts`) bundles a per-seat renormalized effort into model
     saves; it clamps through `interactiveStrategyReasoningEffort` (picking gpt-5.5 with a stored
     "high" saves the run-time-honest "medium"), and NEVER materializes an explicit reviewer value
     from the inheriting state.
   - **Rotation** ("Rotate all models (testing)", PR #1117): a rotating seat HIDES the manual
     control and shows one line — "Reasoning is auto-set per rotated model at its curated
     recommended level (models without a curated recommendation run Medium)." Implemented
     server-side in `resolveModelRotationForRun` (`src/lib/model-rotation.ts`): each rotating seat's
     run-scoped override now also carries `llmReasoningEffort` / `redTeamReasoningEffort` =
     `recommendedReasoningEffortForModel(pick)` (unknown → "medium"; DeepSeek/Mistral-medium →
     "none", their honest fast tier), recorded as `reasoningEffort` on the `model_rotation_pick`
     audit. The persisted per-team efforts are untouched; strategy.ts's existing
     `runPolicy = { ...policy, ...rotationOverride, ...runLlmOverride }` merge carries it to
     proposeTrades/debateProposal unchanged. Stale rotation copy updated (`reasoningSummary`,
     `ROTATION_UI_REASONING_CAPABILITY.description`).

3. **"LLM usage & cost" link** in the Framework Models card header → `/console/usage`.

4. **"Model settings" links** on BOTH Learning Review blocks in
   `app/console/approvals/learned-context.tsx` (the pending queue header and the archive section's
   header row) → `/console/settings#learning-review`; the anchor is NEW in
   `app/console/settings/page.tsx` (wrapping `<LearningReviewCard />`, `scroll-mt-28`, served by the
   page's existing post-snapshot hash-scroll effect).

## Why

Owner-flagged overlap: one reasoning field silently steering two teams made the Framework model
config ambiguous, and rotation mode had no honest story for what effort each rotated model ran at.
Splitting the field per team (with a safe inherit-until-set fallback), auto-setting rotation efforts
at curated recommended levels, and surfacing per-model advice before save makes the stored config
mean what it says. The two links are owner-requested navigation stitches after the #1340 Settings
restructure.

## Files

- `src/lib/types.ts` — `redTeamReasoningEffort` on `TradingPolicy`; proposer doc on `llmReasoningEffort`.
- `src/lib/llm-request.ts` — `resolveReviewerReasoningEffort`; rotation-capability copy update.
- `src/lib/model-reasoning-recommendations.ts` — NEW curated per-model recommended efforts + advice.
- `src/lib/model-rotation.ts` — per-seat recommended effort on the rotation override + audit.
- `src/lib/red-team.ts` — reviewer wire effort resolves via the fallback helper.
- `src/lib/strategy-tuning.ts` — `policyForTuningReviewer` carries reviewer effort when inheriting Red.
- `src/lib/defaults.ts` — comment: no reviewer-effort default on purpose.
- `app/api/policy/route.ts` — per-team validation, team-named messages, new-field enum check.
- `app/console/strategy/page.tsx` — per-seat selects, advice, rotation note, usage link, AI-review default.
- `app/console/strategy/reasoning-control.ts` — `seatReasoningPatch` (replaces `reasoningPatchFor`), summary copy.
- `app/console/settings/page.tsx` — `#learning-review` anchor.
- `app/console/approvals/learned-context.tsx` — two "Model settings" links.
- Tests: `test/strategy-reasoning-control.test.ts` (seatReasoningPatch + fallback helper),
  `test/policy-notification-events.test.ts` (per-team rejection/rescue/enum),
  `test/model-rotation.test.ts` (rotation efforts + audit + recommendations invariants).
- Docs: `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification

Commands run (all green, in order):

```bash
npx tsc --noEmit                      # clean
npm run lint                          # 0 errors (376 grandfathered warnings)
npm test                              # 3383 tests / 315 files, all passed
npm run build                         # clean
```

Live browser smoke against the worktree dev server (`next dev -p 3999`, dev `data/app.db` seeded
with gpt-5.5 proposer + deepseek-v4-pro reviewer + test API keys via a scratchpad tsx script):
- Per-seat controls rendered with correct ladders; gpt-5.5's High option disabled with the rule
  shown as advice; DeepSeek advice shown.
- Reviewer "Same as proposer (None)" correctly displayed the inherited proposer "medium" resolving
  to DeepSeek's thinking-off tier.
- Selecting High on the reviewer persisted `redTeamReasoningEffort: "high"` (proposer untouched);
  re-selecting the blank option stripped it back to absent — both verified by reading the policy
  from the DB.
- Flipping the proposer to `__rotate__` hid its control and showed the auto-set rotation line;
  the concrete reviewer kept its control.
- "LLM usage & cost" link present in the Models card header; both "Model settings" links present on
  /console/approvals (archive one inside the collapsible); `/console/settings#learning-review`
  scrolled to the Learning Review card containing `#learning-review-model`.

Note (pre-existing, NOT introduced here): with NO model configured, the proposer `<select>` (which
has no blank option) visually falls back to its first option "Rotate all models (testing)" even
though the policy is unset — display-only quirk of the native select; the summary line honestly says
"Not Set".

## Follow-ups

- ~~The Reviewer picker's "Blank = same as proposer" hint (pre-existing copy) contradicts the
  server's fail-closed behavior...~~ **DONE 2026-07-10, PR #1349, branch `claude/models-card-truth`**
  (this PR — #1346 — had already squash-merged to `main` as `c7a2fa95` by the time this follow-up
  started, via the known auto-merge-race pattern, so the fix landed as a standalone PR rather than
  a push onto this branch). Two things fixed, copy/display only — no resolution behavior changed:
  1. **Proposer `ModelSelect` had no blank option** (`allowBlank` unset for `role="proposer"`):
     when `policy.llmModel` is `""`, a native `<select value="">` with no matching `<option
     value="">` falls back to visually showing its first rendered option ("Rotate all models
     (testing)"), making an unconfigured Proposer look like rotation is on. Fixed in
     `app/console/strategy/page.tsx`'s `ModelSelect` with a new `blankDisabled` prop — the Proposer
     now renders an unselectable placeholder option ("Not set — choose a model") when blank, so the
     select's own visual state matches the honest "Not Set" the summary line already showed.
  2. **Reviewer hint/blank-label said "Blank = same as proposer" / "Same As Proposer", but the
     server never inherits the Reviewer MODEL** — `resolveRoleModel(policy, "red")` in
     `src/lib/llm-provider.ts` returns `policy.redTeamLlmModel?.trim() || ""` with no fallback to
     `llmModel` (owner directive 2026-07-07), and `debateProposal` (`src/lib/red-team.ts`) fails
     CLOSED to human review (`not_configured`) when that's `""`. Fixed the copy (hint + blank
     label) to state the real consequence, and audited every use of the page's
     `effectiveRedTeamModel = redTeamModel || proposerModel` derivation (reasoning-control display,
     summary line, per-model advice, the reviewer "no reasoning knob" message) — all now read the
     Reviewer's own `redTeamModel` directly (blank stays blank) instead of silently substituting
     the Proposer's model. A blank Reviewer now shows NO reasoning control at all (there is no
     model to have one) plus a new explicit "No Reviewer model set... every risk-adding opening
     routes to human review" message, and the bottom summary line honestly reads "Reviewer: Not
     Set" instead of borrowing the Proposer's provider label. Reasoning-EFFORT inheritance
     (`resolveReviewerReasoningEffort`, item 1 above) is unaffected — that fallback is real and
     still only rendered once a Reviewer model is actually configured.
  - **Owner decision surfaced, not resolved here:** should a blank Reviewer instead inherit the
    Proposer's model (matching what the old copy implied) rather than failing closed to human
    review? This PR only makes the UI tell the truth about current behavior; switching the actual
    behavior is a separate, owner-directed change. See PR #1349's description.
- Curated recommended efforts are all "medium" except the opt-in-thinking providers ("none") —
  re-derive as rotation history accrues, same as the catalog's rec chips.
