# 2026-08-04 — UX PR-B1: Plain-language console nav labels

## Context & Objective

Owner D2 default from `docs/design/ux-improvement-program.md` Wave B: rename
metaphorical rail destinations to plain language so first-time users know where
they are without learning Socratic vocabulary. Hover `desc` tooltips keep the
metaphor.

## Changes Made

Label map (rail + `destinationLabel` + page h1s that already call it):

| Was | Now | href |
|-----|-----|------|
| Thesis | **Home** | `/console` |
| Evidence | **Scan** | `/console/scan` |
| Journal | **Activity** | `/console/activity` |
| Outcomes | **Results** | `/console/results` |
| Regime | **Macro** | `/console/macro` |

- Hard-coded deep-link CTAs on the console home page (Journal / Outcomes)
  now use `destinationLabel(href)` so they cannot drift from the rail.
- Mobile tab pins were already href-based (`console.mobileTabs.v1`); comment
  updated to document that renames are safe.
- Domain jargon left alone (trade-thesis scorecards, "Relevant Evidence" in
  decision drawers, iOS proposal thesis/regime detail lines).

### Files touched

- `app/console/components/nav.tsx` — `DESTINATIONS` labels + comment
- `app/console/lib/mobile-tabs.ts` — comment only (pins by href)
- `app/console/page.tsx` — CTA links via `destinationLabel`
- `test/console-nav-labels.test.ts` — new unit coverage for plain labels + pins
- `test/e2e/dashboard-smoke.spec.ts` — assert "Scan" instead of "Evidence"
- `docs/rollouts/2026-08-04-ux-b1-plain-nav-labels.md` — this note
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — board
- `STATUS.md` — snapshot

## Decisions & Trade-offs

- **No dual subtitle** ("Home · Thesis") this release — owner D2 preferred plain
  labels; optional dual label deferred.
- **Pins by href** already satisfied; no localStorage migration needed.
- Page h1s for scan/activity/results/macro already called `destinationLabel`;
  they pick up renames automatically.

## Verification State

```bash
npx vitest run test/console-nav-labels.test.ts   # 4/4 pass
npx eslint app/console/components/nav.tsx app/console/lib/mobile-tabs.ts \
  app/console/page.tsx test/console-nav-labels.test.ts test/e2e/dashboard-smoke.spec.ts
  # 0 errors (pre-existing warnings only)
npx tsc --noEmit
npm test
```

## Next Steps & Blockers

- PR-B2 Autonomy surface and PR-B4 Settings TOC are separate Wave B slices.
- No dual-label follow-up unless users report muscle-memory confusion.
