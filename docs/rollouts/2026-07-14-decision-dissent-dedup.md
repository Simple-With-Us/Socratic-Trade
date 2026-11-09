# Decision-detail dissent deduplication

## Summary

The decision trace previously showed the same Red Team reason in the structured verdict card,
the generic dissent list, and a generated policy wrapper. The renderer now treats the structured
verdict as canonical and removes only exact or recognized generated echoes. Distinct policy
objections and override context remain visible. Persisted decision data is unchanged.

## Files changed

- `app/console/decisions/[id]/page.tsx` uses the display-filtered dissent list.
- `app/console/lib/dissent.ts` contains the pure exact/generated-echo filter.
- `test/console-dissent-dedup.test.ts` covers canonical echoes, generated wrappers, override
  context, distinct policy objections, and legacy cases without a structured verdict.
- `STATUS.md`, `PLAN.md`, `docs/phase-8-cockpit-ui.md`, and `docs/EFFORT-LOG.md` record the change.

## Verification

- Node 24 focused Vitest: 1 file / 5 tests passed.
- `npm run lint`: passed.
- `npx tsc --noEmit`: passed.
- Pre-review `npm test`: 369 files / 4,132 tests passed locally and in `scripts/land.sh`.
- `npm run build`: passed, including TypeScript and 32 static pages. Existing middleware,
  documentation-token CSS scanning, webpack cache, and Sentry Edge warnings remain unrelated.
- `git diff --check`: passed.
- In-app Browser QA passed on desktop and 390 x 844 mobile: one canonical Red Team card, no
  duplicated objection/policy cards, no horizontal overflow, no console errors, and the
  `Promote lesson` interaction opened the coach-note field.

## Follow-ups

- Review and merge ready PR #1593, then verify the automatic production deployment. Production
  was not changed by this work.

## Round 1 autofix — preserve overridden Red Team dissent rows (P2, Codex review)

**What changed:** `dissentItemsForDisplay` previously seeded its `seen` set with the canonical
Red Team verdict reason, then dropped ALL dissent items whose summary matched — including
`red_team` items whose title said "overridden" but whose summary was the bare reason text. The
override context was lost from the trace.

**Fix:** Skip the exact-summary dedup check for `red_team` items whose title contains
"overridden" — they carry meaningful context the canonical verdict card doesn't show.

**Test gap closed:** The original test used a modified summary with the override annotation
appended to the reason text. The real `syncSocraticDecisionLifecycle` keeps `redTeamVerdict.reason`
as the summary verbatim, so the original test didn't actually catch the bug. Added a test case
that matches production behavior (bare reason as summary).

Post-fix focused Vitest (5/5), scoped ESLint, standalone TypeScript, and diff-check passed. Required
hosted CI, Playwright smoke, and gitleaks passed on the pre-autofix head; final-head reruns remain.
Auto-merge is disabled and production is unchanged.

## Round 2 autofix — keep verdict status explicit without duplicate rationale (two P2s)

### Summary

The canonical Red Team card now renders the shared verdict label next to its trigger. An
`approve-at-half` verdict therefore remains visibly “Approved at half size,” and an available
rejecting verdict remains visibly “Rejected by Red Team.” The generic half-size policy wrapper and
matching Red Team dissent row stay filtered, so the reviewer rationale still appears exactly once.

### Why

Filtering the duplicate rows was correct for rationale deduplication, but those rows previously
carried the only explicit status wording. The canonical card already owns the structured verdict
and reason, so it must own the status label as well.

### Files

- `app/console/decisions/[id]/page.tsx` — renders `redTeamVerdictLabel(...)` on the canonical card.
- `test/console-dissent-dedup.test.ts` — proves both half-size and rejection labels remain explicit
  while their duplicate rationale rows remain hidden.
- `STATUS.md`, `PLAN.md`, `docs/phase-8-cockpit-ui.md`, `docs/EFFORT-LOG.md`, and this note — record
  the two review fixes and current verification state.

### Verification

- Node 24 (`v24.18.0`) focused Vitest: 2 files / 24 tests passed.
- `npm run lint`: passed.
- `npx tsc --noEmit`: passed.
- `npm test`: 369 files / 4,135 tests passed.
- `npm run build`: passed, including the real TypeScript phase and 32 static pages. The inherited
  generated-CSS token warning remains non-fatal and unrelated.
- `git diff --check`: passed.

### Follow-ups

- Commit `40853f3e` contains the two fixes. Run `scripts/land.sh` after the active fleet gate clears,
  request final review, then reply to and resolve only `PRRT_kwDOS7mOVM6Q6zNL` and
  `PRRT_kwDOS7mOVM6Q6zNO`.
- Do not merge or deploy; auto-merge remains disabled and production remains unchanged.

### Landing reconciliation

The first `scripts/land.sh` pass on current `main` passed TypeScript, 370 files / 4,168 tests, and
the production build, then correctly refused a non-fast-forward push because remote autofix
`02c03fe5` advanced the PR branch during the gate. No force-push was used. The remote commit only
added a simpler verdict-label span and had no tests; its history is merged, while the single conflict
keeps the already-tested Chip, semantic status tone, applied-override argument, and two focused
regressions. A focused/TypeScript check and serialized landing retry remain before hosted review.

### Current-main finalization

Exact head `47bfbc0b` received a clean Codex review; every actionable thread was replied to and
resolved, hosted smoke/classify/gitleaks passed, and squash auto-merge was armed. GitHub then marked
the branch dirty after `main` advanced through #1604. Main commit `f54e43aa` is now merged additively
at `a84a9dfd`, preserving both lanes' shared status/plan/effort records. The final current-main
`scripts/land.sh` pass, refreshed hosted verify, auto-merge, and merged-SHA/production verification
remain. No other PR is in scope.
