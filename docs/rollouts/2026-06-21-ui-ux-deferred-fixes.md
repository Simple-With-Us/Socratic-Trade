# Rollout — UI/UX deferred-fix pass (2026-06-21)

**Branch:** `agent/claude-ui` (isolated worktree `~/apps/trading-claude-ui`, off `origin/main` @ `dc4867b`)
**Author:** Claude (Opus 4.8)

## Summary
Cleared a batch of deferred items from the UI/UX issue register
(`docs/reviews/2026-06-21-ui-ux-issue-register.md`) — accessibility, mobile
safe-area, visual/Strategy-Flow polish, scan-table perceived-perf, copy, and a
dead-code deletion.

## Why a separate worktree/branch
The assigned `~/apps/trading-claude` worktree had a **live concurrent session**
actively committing (it landed `049f9e8` — Alpaca snapshot provider + PDT
retirement — mid-pass and kept editing `strategy.ts`/`web-sources/*`). To avoid
racing it, this work was done in a fresh isolated worktree off `origin/main` and
lands via its own PR. The concurrent session's uncommitted WIP was left
untouched in its worktree.

## Items fixed (register IDs)
- **REL-6** — Strategy Flow: themed animated edges with arrowheads
  (`defaultEdgeOptions`), respaced source nodes (no overlap), `proOptions:
  {hideAttribution:true}` (watermark gone), removed the unstyled minimap (the
  stray gray box), and `colorMode` follows the app's dark/light toggle.
- **IPH-9 / IOS-1** — safe-area insets: `viewport-fit=cover` (`app/layout.tsx`)
  + `env(safe-area-inset-*)` body padding under an `@supports` guard
  (`app/globals.css`). Zero on non-notched devices, so desktop/portrait are
  unaffected.
- **A11Y-7** — added `--down-fg` token (light `#ffffff`, dark `#2b0a10`) +
  `--color-down-fg`; danger buttons in `primitives.tsx`/`overlays.tsx` now use
  `text-down-fg` (fixes dark-mode AA contrast).
- **MISC-1** — scoped the equity-curve SVG gradient id with `useId()`.
- **DUP-1** — deleted the dead, unimported `app/ui/dashboard/{views,components,
  utils,settings}.tsx`. This also resolves **CPY-7** (the source-path leak lived
  only in the dead `settings.tsx`) and **VIS-2** (dead row `backdrop-blur`), and
  removes the dead half of **CPY-5** (the divergent `SettingsContent`).
- **CPY-9** — stopped CSS-uppercasing the safety banner; the mode prefix is
  already caps in the string, so the clarifying sentence now reads sentence-case.
- **A11Y-5** — Activity button has a dynamic `aria-label` announcing the pending
  count; the count badge is `aria-live="polite"`.
- **A11Y-8** — raised the 9px Universe / Daily-volume pill labels to 11px.
- **SCN-2** — `TableVirtuoso overscan={600}` + `initialItemCount` to kill the
  blank-row flash (populated scan table looked empty for a beat after fetch).

## Files touched
- `app/globals.css` — `--down-fg` token, `--color-down-fg`, safe-area insets.
- `app/layout.tsx` — `viewport` export with `viewportFit: "cover"`.
- `app/ui/strategy-flow.tsx` — full rework (edges/nodes/minimap/attribution/colorMode).
- `app/ui/charts.tsx` — `useId()`-scoped gradient.
- `app/ui/primitives.tsx`, `app/ui/overlays.tsx` — `text-down-fg` danger buttons.
- `app/dashboard-client.tsx` — banner casing, Activity aria, pill sizes, virtuoso overscan.
- `app/ui/dashboard/*` — **deleted** (dead code).
- `docs/reviews/2026-06-21-ui-ux-issue-register.md` — statuses updated.

## Verification (all run in `~/apps/trading-claude-ui`)
- `npx tsc --noEmit` — clean.
- `npm test` — **557 passed (69 files)**.
- `npm run build` — clean.
- Live/visual: NOT run here (isolated worktree has no preview; the session
  preview points at the main worktree). The Strategy-Flow visual is best
  confirmed on a preview after merge.

## Follow-ups (still deferred)
- **REL-5 / A11Y-3** — full ⌘K command-palette wire-up (component exists,
  unmounted). The stale on-screen hint is already gone, so no broken affordance
  remains; the full mount + dialog ARIA + command set is a feature add best
  exercised interactively.
- **CPY-8 (root)** — why `policy.accountNumber` is empty when
  `connectedAccountId` is set (`src/lib/strategy.ts`) — needs backend
  investigation + tests.
- **CPY-10/11/12** — internal-identifier mapping, mode-label phrasing,
  freshness-aware "· live" (needs a market-open signal in scope).
- **IA-2/3/4/5**, **IPH-5** (header overflow popover), **A11Y-6** (column-picker
  ARIA/Escape), **SCN-4**, **MISC-2/3**, **REL-3/REL-4**.
- **next 16 / zod 4** dependabot migrations (PRs #3, #5) — land separately.
