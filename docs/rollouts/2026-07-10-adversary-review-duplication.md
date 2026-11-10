# 2026-07-10 — Console approval card: de-duplicate the Red Team failure state

Branch: `claude/adversary-review-duplication-026e6b` (CLAUDE)

## Summary

The console approval card ([app/console/components/approval-card.tsx](../../app/console/components/approval-card.tsx))
rendered a **failed** Red Team (adversarial) review **twice** for the same pending
proposal:

1. the "Devil's advocate (red team)" verdict panel (which shows `reason` +
   "No verdict: review failed (…)"), and
2. a separate "Red Team review unavailable (provider error)" warning callout

…both printing the same provider-error `reason` string. The owner reported it
("why is there a devil's advocate and red team review both if there was single
adversary consolidation") with a screenshot showing the two stacked cards.

There is only **one** adversarial reviewer — "Devil's Advocate" and "Red Team"
are the same single Red Team (`src/lib/red-team.ts`; one LLM call per risk-adding
opening). The single-adversary consolidation (#1191) was a backend consolidation
and remains correct. The duplication was purely a **UI double-render**: two
adjacent JSX blocks whose conditions overlapped on the failure case.

## Why it existed

- `#1076` (2026-07-08, MONET) gave the verdict panel a built-in failure branch
  ("model attribution on every decision surface incl. failure states").
- `#1191` (2026-07-09), the single-adversary consolidation commit, then added a
  *second* "review unavailable" callout for §5.1/R19 — without noticing the panel
  had, the day before, started rendering that exact failure state. The callout's
  condition (`(redTeamVerdict && !available) || adversaryUnavailable`) was a
  strict subset of the panel's (`redTeamVerdict`), so on failure both fired.

## Change

Made the three Red Team sections **mutually exclusive by construction** instead of
via overlapping ad-hoc conditions:

- New pure, total helper `redTeamCardState(hasVerdict, adversaryUnavailable)` in
  [app/console/lib/red-team.ts](../../app/console/lib/red-team.ts) returns exactly
  one of `"verdict-panel" | "legacy-unavailable" | "no-review"`. The verdict panel
  owns the structured verdict (success **and** failure); the legacy callout only
  fires when there is **no** structured verdict but the legacy
  `adversaryUnavailable` decision flag is set (old proposals persisted before the
  consolidation); the "no review triggered" note fires otherwise.
- The approval card computes `redCard` once and switches all three blocks on it.
- The "No model critiqued this trade — review it as the sole adversary." framing
  (previously only on the duplicate callout) was folded into the verdict panel's
  failure branch so it is preserved for the common (structured-verdict) case.
- Regression test in [test/console-red-team-labels.test.ts](../../test/console-red-team-labels.test.ts):
  asserts a failed verdict maps solely to `"verdict-panel"` (even when the legacy
  flag is also set), and that the mapping is total + mutually exclusive.

The decisions detail page (`app/console/decisions/[id]/page.tsx`) was already
mutually exclusive (`available` vs `!available`, no separate callout) — unchanged.

## Files

- `app/console/lib/red-team.ts` — added `redTeamCardState` + `RedTeamCardState`.
- `app/console/components/approval-card.tsx` — import + `redCard` derivation; three
  blocks switched to `redCard`; folded the "sole adversary" line into the panel;
  simplified the now-legacy-only callout.
- `test/console-red-team-labels.test.ts` — 5 new `redTeamCardState` assertions.

## Verification

Local, in this worktree:

- `npx tsc --noEmit` — clean (run under node@24).
- `npm run lint` — 0 errors (376 grandfathered warnings).
- `npm test` — 315 files / 3400 tests passed.
- `npm run build` — succeeded.

**Node ABI note:** this ephemeral `.claude/worktrees/…` worktree has no
`better-sqlite3` in its own `node_modules`, so resolution walks up to the **main
repo** `node_modules`, whose native `better_sqlite3.node` is currently built for
node26 (ABI 147). The DB-touching tests therefore require running the suite/build
under the default **node26**, not node@24 (running under node@24/ABI 137 mass-fails
with `NODE_MODULE_VERSION 147 vs 137`). tsc/lint are ABI-independent. CI is
unaffected — the `verify` workflow does a fresh `npm ci` against `.nvmrc` (node24)
so it rebuilds the binary for node24.

## Follow-ups

- None functional. If the shared main-repo `node_modules` is ever rebuilt for
  node24, gates here run clean under node@24 again (the memory note's original
  guidance).
