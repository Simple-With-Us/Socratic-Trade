# 2026-07-11 — Team display names back to "Green Team" / "Red Team" (CLAUDE)

## Summary

Owner-directed copy rename: the console UI had drifted to "Proposer" /
"Reviewer" (and one "Strategist (green team)" lead-in) for the two adversarial
team seats. All user-visible labels now lead with **Green Team** and **Red
Team** — matching the how-it-works diagram, the new /framework page, and the
original team vocabulary. Owner: "change the name of the teams back to green
team and red team since you even saw that it was better to say that for your
diagram."

Display strings only — internal identifiers (`role: "proposer" | "red-team"`,
state/variable/function names, API fields like `redTeamLlmModel`,
`proposedByModel`) and LLM prompt text are deliberately untouched.

## Renamed surfaces

- `app/console/strategy/page.tsx` (Framework page): "Green Team Model" /
  "Red Team Model" pickers (hints reworded to "The proposer —…" / "The
  adversarial reviewer —…"), "(Rec Green Team)" / "(Rec Red Team)" option
  suffixes, "Same as Green Team" reviewer-effort option + title, "Green Team
  Fallback Models", the provider summary line, save-error titles, and the AI
  Review card's inherited-seat labels ("Same As Red Team/Green Team" — the
  `inheritedReviewerLabel === "Red Team"` comparison updated in lockstep).
- `app/console/components/model-stats-drawer.tsx`: role labels →
  "Green Team (proposer)" / "Red Team (reviewer)".
- `app/console/results/page.tsx`: both veto-efficacy table columns
  "Reviewer" → "Red Team".
- `app/api/policy/route.ts`: interactive-reasoning rejection copy →
  "Green Team: …" / "Red Team: …".
- `src/lib/llm-required.ts`: model-required message now leads with
  "Green Team (strategist) and Red Team (reviewer)".
- `app/console/components/approval-card.tsx`: legacy confidence-trigger title
  → "The Green Team confidence cleared…".
- `app/console/settings/help.tsx`: "Green Team pick" reference; team-name
  search aliases added; and a **factual fix**: the Red team definition still
  claimed "blank means the strategist model reviews itself" — wrong since the
  2026-07-07 single-adversary consolidation (blank fails closed: every
  risk-adding opening routes to human approval). Definition rewritten to
  match actual behavior (universal coverage, final-size review, fail-closed).

## Why

Consistent team vocabulary across product surfaces; the dialectic
(Green proposes / Red challenges) is the brand story and the clearer mental
model. The help-copy fix rode along because the old text misdescribed a
safety-critical behavior.

## Files

- `app/console/strategy/page.tsx`
- `app/console/components/model-stats-drawer.tsx`
- `app/console/components/approval-card.tsx`
- `app/console/results/page.tsx`
- `app/console/settings/help.tsx`
- `app/api/policy/route.ts`
- `src/lib/llm-required.ts`
- `test/policy-notification-events.test.ts` (assertions follow the new copy)
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this note

## Verification

- `npx tsc --noEmit` clean (Node 24).
- Focused: `test/policy-notification-events.test.ts` 3/3,
  `test/strategy-run-once-async-route.test.ts` 8/8 (imports the renamed
  message constant), `test/middleware-auth.test.ts` 25/25.
- Repo-wide grep confirms no user-visible "Proposer"/"Reviewer" seat labels
  remain (internal identifiers intentionally unchanged).
- Full ordered gate via `scripts/land.sh` (tsc → full vitest → build) before
  push; hosted verify/smoke/gitleaks gate the merge.

## Follow-ups

- None. If a future pass renames internal identifiers, do it separately from
  copy — this change was scoped to display strings to keep the diff reviewable.
