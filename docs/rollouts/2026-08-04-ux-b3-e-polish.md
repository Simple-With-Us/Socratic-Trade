# Rollout: UX B3 Strategy progressive structure + E2 login warmth + E3 cmdk mobile

## Context & Objective

Implement three low-risk polish slices from `docs/design/ux-improvement-program.md`:
**PR-B3** (Strategy progressive structure), **PR-E2** (login value bullets matching iOS),
and **PR-E3** (command palette always visible on touch + healthy mobile freshness collapse).
No policy/behavior changes; display structure and discoverability only.

## Changes Made

### B3 — Strategy progressive structure
- Collapsible `Card` sections for **Models**, **Instructions**, **Scoring**, **Presets**
  via existing `collapsible` / `defaultOpen` on `app/console/ui/primitives.tsx` `Card`.
- **Models** + **Instructions** open on first paint; **Scoring** (advanced weights)
  collapsed; **Presets** open for discoverability.
- Section ids for deep-link anchors: `#models` (existing), `#instructions`, `#scoring`,
  `#presets`.
- AI Review panel left as a non-collapsible card (not part of the four named sections).
- **No** scoring-weight defaults, save paths, or policy fields changed.

### E2 — Login warmth
- `/login` shows three value bullets matching iOS `LoginView`:
  1. Review and approve proposals
  2. Track positions, orders, and performance
  3. Control the backend agent without moving credentials onto the device
- Placed above the OAuth buttons; uses existing surface/border tokens.

### E3 — Command palette + chrome density
- `CommandPaletteTrigger` no longer `hidden md:block` — always in the chrome bar.
- On phones, hide the ⌘K / Ctrl K badge (`hidden sm:inline`); icon-only 32px hit target
  so scope + STOP stay prioritized.
- Healthy mobile freshness bar collapses to one short line: `Fresh · Today: $…`;
  delayed/aging/loading keeps the fuller strip.

### Files touched
- `app/console/strategy/page.tsx`
- `app/login/page.tsx`
- `app/console/components/shell.tsx`
- `app/console/components/command-palette.tsx`
- `app/console/components/chrome.tsx`
- `app/console/console.css`
- `docs/rollouts/2026-08-04-ux-b3-e-polish.md` (this note)
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board `/Users/jay/apps/TRADING-EFFORT-LOG.md`)

## Decisions & Trade-offs

- Renamed card titles to short section names (Instructions / Scoring / Presets) for scanability;
  body copy still explains each section. Old long title “The strategist's written instructions”
  is no longer the summary label.
- Presets default **open** (not collapsed) so applying a preset remains one click after
  first paint; only advanced weights are collapsed per acceptance criteria.
- Did **not** touch welcome page, middleware unauth routing, empty-state theme (E1),
  nav labels, approval-card, checklist hero, or dashboard cache (peer keepouts).

## Verification State

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node -v   # expect v24.x
npm ci
npm run lint
npx tsc --noEmit
npm test
npm run build
# land
bash scripts/land.sh
```

(Gates run via land.sh after local tsc/lint smoke.)

## Next Steps & Blockers

- None for this slice. Peer agents own A1–A5, B1/B2/B4, C*, D*, E1.
- Optional later: sticky jump chips on Strategy for `#models` / `#instructions` / `#scoring` / `#presets`.

## Zero-Code Findings

- N/A — UI structure only.
