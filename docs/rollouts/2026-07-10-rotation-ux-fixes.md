# 2026-07-10 — Rotation-UX fixes: effort control visible under "__rotate__", sentinel-aware copy

Branch `claude/rotate-ux-fixes`, stacked on `monet/mistral-capmap-fix` (#1279, which owns the
latest `src/lib/llm-request.ts` Mistral capability map). Committed locally per the pickup
instructions (one commit, no push — the orchestrating session owns landing/sequencing).

## Summary

Two owner reports, plus one regression found while investigating them:

1. **Hidden effort control under rotation (owner report a).** With the Proposer and/or Reviewer
   seat set to "Rotate all models" (`__rotate__`), the Strategy page filtered the sentinel out of
   the reasoning-control inputs. With both seats rotating (or proposer rotating + reviewer blank,
   which inherits it) the model list emptied, the whole "Reasoning / Thinking Effort" select
   unrendered, and the summary printed the actively false line "These selected models do not
   expose a provider-specific reasoning or thinking control here." The stored
   `llmReasoningEffort` still silently applied to every rotated pick at call time but was
   invisible and uneditable.
2. **False independence warning (owner report b).** `app/console/settings/models.tsx` compared
   the two seats as raw strings, so two `__rotate__` sentinels matched and fired "Strategist and
   Reviewer are the SAME model — it will be critiquing its own proposals."
3. **Disappear-on-default shared control (c2f0d754 regression).** The (correct, evidence-backed)
   no-silent-escalation guard added in c2f0d754 returns `undefined` for mixed-provider pairings
   whose shared option set collapses to the high tier (e.g. `mistral-medium-3-5` + `gpt-5.4` →
   `{high}`), and the render condition `reasoningControl && reasoningValue` then hid the WHOLE
   control — a chicken-and-egg: the selector needed to opt into High was the hidden one.

## What changed

- **`src/lib/llm-request.ts`** — new UI-only export `ROTATION_UI_REASONING_CAPABILITY`
  (provider `"rotation"`, added to the `LlmReasoningProvider` union; full generic effort ladder;
  honest description that the effort applies per served model, clamped per run).
  `reasoningCapabilityForModel` deliberately STILL returns `undefined` for the raw sentinel, so
  every server wire-shaping path (`withLlmRequestBounds`, `normalizeReasoningEffortForModel`,
  `resolveOpenAiModel`) keeps failing closed on a leaked `__rotate__`. **No call-time semantics
  changed anywhere in this PR.**
- **`app/console/strategy/reasoning-control.ts` (new)** — the page's reasoning-control helpers
  (`reasoningControlForModels`, `normalizeReasoningValueForControl`, `reasoningSummary`,
  `reasoningPatchFor`, `HIGH_TIER_REASONING_EFFORTS`) extracted from `page.tsx` into a pure,
  unit-testable module. Sentinel-aware: a rotating seat maps to the synthetic capability instead
  of being filtered out; `reasoningSummary` says the effort applies to each run's served model,
  clamped to that model's supported range; `reasoningPatchFor` still excludes the sentinel from
  renormalization inputs (all-rotate ⇒ empty patch — the stored effort is never clamped against
  the synthetic ladder).
- **`app/console/strategy/page.tsx`** —
  - `reasoningModels` no longer filters the sentinel; the control renders whenever a control
    exists (`reasoningControl &&` instead of `reasoningControl && reasoningValue &&`).
  - New "Per-model default (no high-tier escalation)" blank option, shown when the guard
    normalizes the stored effort to `undefined` OR when every shared option is high-tier (so
    choosing High is never a one-way door). Selecting it clears the stored effort via
    `savePolicy({ llmReasoningEffort: null })` (verified: the policy route's `stripNullsDeep`
    turns the null back into absent). Local overlay gains a `"cleared"` state for the optimistic
    render.
  - One-line note when a selected concrete model takes no reasoning parameters at all (e.g.
    `mistral-small-2603`): "takes no reasoning parameters — this setting applies only to the
    other selected model(s)."
  - AI review panel: when EVERY inheritable seat rotates, the blank strategist option/hint now
    disclose upfront that the review runs on local rules (no LLM) instead of only showing the
    after-the-fact "local rules" chip (server behavior unchanged — `policyForTuningReviewer`
    already routes around the sentinel).
- **`app/console/settings/models.tsx`** — independence hint checks the both-rotate case FIRST
  and shows positive copy: both teams rotate through the curated pool, each run serves concrete
  audited round-robin picks, the runtime skips same-model pairings whenever more than one model
  is eligible, and per-model history accrues on both sides. One sentinel + concrete stays
  hint-free; two identical concrete models keep the existing SAME-model warning. (The skip
  clause was qualified post-review: `advanceRotationPointers` — merged via #1294 — can only
  skip with >= 2 eligible models; a single-model eligible pool degenerately serves that model
  to both seats, so the unqualified "skips when both seats rotate" and the "not one model
  critiquing itself" absolute were tightened to stay strictly true.)
- **`app/console/components/approval-card.tsx`** — provenance strings and model badges never
  leak the raw sentinel: "configured to rotate; served X (this run's rotation pick)" replaces the
  "served X; configured primary was __rotate__" anomaly framing; the failover chip no longer
  claims a rotation pick "differs from configured primary"; `greenModel`/`redModel` badge
  fallbacks skip the sentinel (legacy unstamped proposals show "(policy rotates models)" instead
  of a bogus `__rotate__` badge with an OpenAI logo).
- **`app/console/lib/red-team.ts`** — `redTeamFailureModel` returns null instead of attributing
  a failed review to the configured `__rotate__` sentinel (a marker, not a model that ran).

## Why

Owner requirements for this pickup: rotation must not hide per-model customization (show the
control with a generic ladder + honest per-served-model copy — do NOT change call-time
normalization); two rotate sentinels are not "the same model"; and the mistral-pair control
disappearance needed an honest note/opt-in rather than re-widening the capability map (the
narrowing is provider-400-evidence-backed and stays).

## Files

- `src/lib/llm-request.ts`
- `app/console/strategy/reasoning-control.ts` (new)
- `app/console/strategy/page.tsx`
- `app/console/settings/models.tsx`
- `app/console/components/approval-card.tsx`
- `app/console/lib/red-team.ts`
- `test/llm-request.test.ts`
- `test/strategy-reasoning-control.test.ts` (new)
- `test/console-red-team-labels.test.ts`
- `STATUS.md`, `docs/EFFORT-LOG.md`, `docs/rollouts/2026-07-10-rotation-ux-fixes.md`

## Verification

Run in the stacked worktree (base `origin/monet/mistral-capmap-fix` @ c2f0d754):

```bash
npx tsc --noEmit                        # clean
npx vitest run test/llm-request.test.ts test/strategy-reasoning-control.test.ts test/console-red-team-labels.test.ts
                                        # 3 files, 33 tests, all pass
npm test                                # full suite: 311 files, 3262 tests, all pass
npx eslint src/lib/llm-request.ts app/console/strategy/page.tsx \
  app/console/strategy/reasoning-control.ts app/console/settings/models.tsx \
  app/console/components/approval-card.tsx app/console/lib/red-team.ts \
  test/llm-request.test.ts test/strategy-reasoning-control.test.ts \
  test/console-red-team-labels.test.ts   # 0 errors (1 pre-existing grandfathered warning in models.tsx)
```

`npm run build` was not run here (per the pickup's verification scope); the `verify` CI gate and
`scripts/land.sh` run it before merge.

Post-#1294 re-verification (2026-07-10, after merging `origin/main` @ 597b991c into this
branch — clean merge, no conflicts):

```bash
npx vitest run test/model-rotation.test.ts   # 18 tests pass (incl. never-self-pair cases)
npx vitest run test/llm-request.test.ts test/strategy-reasoning-control.test.ts \
  test/console-red-team-labels.test.ts test/model-rotation.test.ts   # 4 files, 51 tests pass
npx tsc --noEmit                             # clean
```

## Follow-ups / sequencing

- **RESOLVED (2026-07-10): the parallel rotate-fix lane merged first, as required.** PR #1294
  landed the same-model skip in `src/lib/model-rotation.ts` `advanceRotationPointers` (red skips
  one slot when its pick would equal green's, pool >= 2), and this branch then merged
  `origin/main`, so the independence-hint skip clause is true of this tree. Re-verified here
  post-merge: `test/model-rotation.test.ts` (18 tests incl. the never-self-pair cases) passes,
  and the hint copy was tightened to "whenever more than one model is eligible" so it stays
  strictly true even for the single-eligible-model degenerate pool (see the models.tsx bullet
  above).
- Coordination keepouts honored: no edits to `app/api/strategy/run/route.ts`,
  `app/console/components/chrome.tsx`, `src/lib/model-rotation.ts`, or the
  recommendedGreen/recommendedRed regions of `app/ui/llm-model-catalog.ts`.
- `app/settings-search.ts`'s "reasoning effort" synonym now lands on a page where the control
  exists under all-rotate (self-healed by fix 1; no change needed).
- The approval-card "(policy default)" hover copy for the non-rotating no-model case still
  mentions an `OPENAI_MODEL` env default that no longer exists (pre-existing stale copy, out of
  scope here).
- **Drive-by gate unblock (2026-07-10, two-line, documented here because it rides this PR):**
  `src/lib/db-health.ts` `getServiceHealthLog` now orders `ts DESC, rowid DESC`. The new
  main-tip test `test/data-providers.test.ts` "TwelveData logs an ok:false health row..."
  (from #1267/#1287) asserts on the NEWEST health row, but `ts` is ms-resolution — on a fast
  machine sibling tests' rows tie on `ts` and return in arbitrary order, intermittently
  failing the file on pristine `origin/main` (passes alone; CI's slower runners rarely tie,
  hence green there). This blocked `scripts/land.sh`'s local `npm test` gate. GOTCHA hit en
  route: the first attempt used `id DESC`, but `api_health_log.id` is a **randomUUID** TEXT
  PK — ordering by it is a per-run coin flip, and the flake came back under land.sh's suite
  run. `rowid` (implicit; a TEXT PRIMARY KEY does not alias it) is the monotonic insertion
  order. Verified: 93/93 in the file, 6 consecutive runs post-rowid. Other `ORDER BY ts DESC`
  sites in db-health.ts (incl. the last-5 circuit-breaker read) share the theoretical tie and
  are left for a follow-up sweep (background chip spawned with the rowid guidance).
