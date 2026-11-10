# 2026-07-10 — Green/Red picker label coloring + copy sweep

## Summary

Owner-directed pure display-copy change to the console's LLM model pickers
(Settings → Models card, Strategy page → Models card):

1. The field labels now read **"Proposer Model"** and **"Reviewer Model"**,
   with only the words "Proposer"/"Reviewer" colored — Proposer in green
   (`var(--con-pos)`), Reviewer in red (`var(--con-neg)`) — via a `<span
   className="text-[color:var(--con-pos)]">`/`text-[color:var(--con-neg)]`
   wrapper. "Model" stays the default label text color. Same font-weight as
   before (the parent `.con-label` still sets `font-weight: 600`; the spans
   don't override it). Token colors only, never hex.
2. Helper copy simplified: "aka Green Team or Bull" → "Green"; "aka Red Team
   or Bear" → "Red", everywhere those phrases appeared in the two target
   files' hints, the settings-page intro paragraph, and the missing-model
   banner text.
3. Swept the one remaining "Green Team"/"Red Team" user-facing string that's
   directly wired into these same two pages: the model-stats info-drawer's
   role label (`app/console/components/model-stats-drawer.tsx`), which
   renders as the `IconButton` tooltip and `Sheet` title for the small stats
   button next to each picker. "Proposer (Green Team)" → "Proposer (Green)",
   "Reviewer (Red Team)" → "Reviewer (Red)".

## Why

Owner-directed copy/style pass to make the Proposer/Reviewer color-coding
(green = writes proposals, red = adversarial review) visible directly in the
field labels themselves, and to drop the verbose "Team"/"Bull"/"Bear"
aliasing down to just the color word now that the labels carry the color.

This explicitly reverses part of the prior "Picker copy" pass
(`docs/rollouts/2026-07-09-picker-copy-strategist.md`, PR #1202), which had
shortened "Proposer Model"/"Reviewer Model" to plain "Proposer"/"Reviewer".
That's fine — it's a distinct, newer owner directive; nothing in this pass
touches the *other* half of #1202's work (the separate AI-review/"Strategist"
panel, which is unaffected and unrenamed).

## Scope decisions

- **In scope:** `app/console/settings/models.tsx`, `app/console/strategy/page.tsx`
  (the two named target files), and `app/console/components/model-stats-drawer.tsx`
  (the info-drawer button rendered directly next to each picker in both of
  those files — reachable only from the Models UI, so treated as part of it).
- **Out of scope, deliberately untouched:** `app/console/components/approval-card.tsx`,
  `app/console/results/page.tsx`, `app/console/decisions/[id]/page.tsx`, and
  `app/console/lib/red-team.ts`. These are different console pages/areas
  (dashboard approval cards, the Results analytics page's "Red Team veto
  efficacy" scorecard, the Decision detail page's review badge, and a shared
  client helper for rendering the review verdict) — not part of the
  settings/strategy Models UI this task named. The instruction's sweep was
  scoped to "the console settings/strategy UI"; renaming those other surfaces
  was never requested and would be a materially larger, separate change.
- Code comments, internal variable/prop names (`green`/`red`, `redTeamLlmModel`,
  `role: "red-team"`, etc.), test file prose, and server/lib code were left
  untouched per the task's explicit instruction — only user-facing display
  strings changed.
- One user-facing string in `model-stats-drawer.tsx` still says "Results page
  'Red Team veto efficacy' scorecard" (a doc-comment/description quoting the
  *actual, unchanged* title of that other page's card) — left as-is since
  that page's title wasn't renamed.

## Files

- `app/console/settings/models.tsx` — missing-model banner strings
  ("Strategist (green team)"/"Reviewer (red team)" → "Strategist
  (Green)"/"Reviewer (Red)"), intro paragraph ("aka Green Team or
  Bull"/"aka Red Team or Bear" → "aka Green"/"aka Red"), and the two `Field`
  `label`/`hint` props (colored-span labels + simplified hints).
- `app/console/strategy/page.tsx` — the two `Field` `label`/`hint` props on
  the Models card (colored-span labels + simplified hints).
- `app/console/components/model-stats-drawer.tsx` — `roleLabel` string.
- `STATUS.md` — new snapshot entry.
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — Completed
  effort-log row (added to both; neither file's other rows were touched, per
  the never-delete-another-agent's-row rule — the two boards had already
  diverged slightly from other agents' concurrent edits before this change).

## Verification

Run from this worktree (`node_modules` already present):

```bash
npx tsc --noEmit   # clean, no errors
npm test           # 315 files / 3351 tests passed
npm run build      # succeeded, no errors
```

Also visually verified via a local `next dev` preview (temporary
`.claude/launch.json`, removed after use — not committed):
- Navigated to `/console/settings` and `/console/strategy`, confirmed the
  rendered label markup is `<span class="text-[color:var(--con-pos)]">Proposer</span>
  Model` / `<span class="text-[color:var(--con-neg)]">Reviewer</span> Model`.
- Inspected computed styles in both light and (via `prefers-color-scheme:
  dark` emulation) dark mode: Proposer resolved to `rgb(21, 127, 78)` (light,
  `--con-pos` = `#157f4e`) and `rgb(55, 197, 140)` (dark, `--con-pos` =
  `#37c58c`); Reviewer resolved to `rgb(209, 51, 46)` (light, `--con-neg` =
  `#d1332e`) and `rgb(240, 99, 94)` (dark, `--con-neg` = `#f0635e`) — exact
  token matches in both themes. `font-weight: 600` unchanged (inherited from
  `.con-label`).
- Confirmed the simplified hint/intro copy renders correctly on both pages
  (screenshots taken, not committed).

Confirmed before editing that no test asserts the old "Green Team"/"Red
Team"/"Bull"/"Bear" strings in these three files (`grep -rl` over `test/`
found only server/lib-facing test prose unrelated to this UI copy).

## Follow-ups

- None outstanding for this task. If the owner later wants the sweep
  extended to `approval-card.tsx`/`results/page.tsx`/`decisions/[id]/page.tsx`,
  that is a distinct, separately-scoped follow-up (different pages, different
  review surfaces) — not implied by this change.
