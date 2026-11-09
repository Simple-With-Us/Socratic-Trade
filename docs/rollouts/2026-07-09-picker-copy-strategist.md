# 2026-07-09 — Picker copy: "Proposer"/"Reviewer" + AI-review panel "Strategist"

## Summary

Owner-directed pure display-copy change (no functional/behavioral/variable-name
changes). Renamed the two Green/Red team picker labels from "Proposer Model" /
"Reviewer Model" to "Proposer" / "Reviewer" in both places they appear
(Settings → Models card, Strategy page). Renamed the separate AI-review
(strategy-tuning) panel's model field from "Reviewer model" to "Strategist" to
remove the naming collision with the newly-shortened "Reviewer" picker label,
and updated its intro sentence and inherited-label fallback text to match.

## Why

The strategy loop's two models are conceptually "Proposer" and "Reviewer" (aka
Green Team/Bull and Red Team/Bear). The picker field labels previously said
"Proposer Model" / "Reviewer Model" — redundant since the field is obviously a
model picker. Shortening "Reviewer Model" to "Reviewer" would have collided
with the unrelated AI-review (strategy-tuning) panel, which also used "Reviewer
model" as its own field label and defaulted its blank option to "Same As Red
Team" / "Same As Green Team". Renaming that panel's field to "Strategist"
(and its intro copy to "A strategist model reads...") disambiguates the two
concepts: the Reviewer is the per-run Red Team/Bear that critiques every
proposal; the Strategist is the separate, on-demand model that proposes
prompt/weight/guardrail changes to the strategy itself.

## Files

- `app/console/settings/models.tsx` — intro paragraph ("The Proposer ... the
  Reviewer ..."), `label="Proposer — required"`, `label="Reviewer — required"`.
- `app/console/strategy/page.tsx` — Proposer/Reviewer `Field` labels on the
  strategy-page picker, the "Proposer: ... Reviewer: ..." summary line, the
  `inheritedReviewerLabel` ternary's display strings (`"Reviewer"` /
  `"Proposer"` — variable name unchanged), the AI-review panel's intro
  sentence ("A strategist model reads..."), and its model-field
  `label="Strategist"`.
- `STATUS.md` — new snapshot entry.
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — Completed
  effort-log row.

No other files touched. All other "Red Team"/"Green Team" occurrences
(`approval-card.tsx`, `results/page.tsx`, decisions page, `model-stats-drawer.tsx`,
`red-team.ts`, `api/keys`, `settings-search.ts`, `api/policy` comments) are
untouched — those remain valid concept/aka names, not picker labels.

## Verification

Run from `/Users/jay/apps/trading-monet-picker-copy` (fresh worktree off
`origin/main`, `npm ci`'d):

```bash
npx tsc --noEmit   # clean, no errors
npm run lint       # 0 errors, 367 pre-existing warnings (unrelated backlog)
npm test           # 306 files / 3168 tests passed
npm run build      # succeeded
```

Confirmed no test asserts the old "Proposer Model" / "Reviewer Model" /
"Reviewer model" / "Same As Red Team" / "Same As Green Team" strings before
editing (`grep -rl` over `test/` returned nothing).

## Follow-ups

None identified. This is copy-only; no further wiring needed.
