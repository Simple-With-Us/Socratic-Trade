# 2026-07-08 — UI wave 4: scope-selector dropdown, floating Tabs sheet, badge spacing (+ 55-findings audit)

**Author:** CLAUDE (3-agent expert team: opus design-lead, sonnet mobile-nav engineer, sonnet auditor)
**Branch:** `claude/ui-polish-wave` · owner phone/desktop feedback wave 4.

## Summary

1. **ScopeSelector rebuilt: Sheet → real anchored dropdown** (`chrome.tsx`). The trigger already read
   as a dropdown (chevron), so it now behaves like one; Sheets stay reserved for run-state rituals.
   Rows: account name + reality/running chips, `broker · ··last4` second line; loaded account is a
   `menuitemradio` marker; bottom **"Configure accounts"** item links to `/console/settings#brokers`.
   Desktop width `sm:min-w-[190px] max-w-[300px]` (labels stop truncating); chevron aligned to the
   name line (`items-start` + `mt-0.5`) and rotates when open. `role="menu"`, Escape-closes with
   focus return, click-away, `aria-haspopup/expanded`. Reuses `.con-menu-drop` slide-down; new
   `.con-scope-row` class (token-based, 44px rows on coarse pointers, light+dark).
2. **UserMenu:** Escape/click-away now return focus to the trigger (keyboard parity); its
   slide-down animation already existed.
3. **Mobile Tabs sheet floats above a still-visible tab bar** (`nav.tsx`) — the owner's floated
   alternative. `MobileTabBar` live-measures its height (ResizeObserver) → `TabsSheet` anchors at
   `bottom: barHeight+8px` with `max-height: calc(100dvh - bar - 24px)`, scrim stops at the bar, all
   four corners rounded. All destinations fit on a 390×844 iPhone; pin toggles reflect on the real
   bar in real time; internal scroll remains for small screens. Slide-up animation (MONET's) verified
   compatible.
4. **Tab-bar badge clearance:** `.con-tab-item` top padding 6→9px + badge offset `-top-1.5`→`-top-1`
   (~5px clearance) so the Proposals count no longer sits clipped against the bar edge.
5. **55-findings backlog audited against current main** (post-MONET #1103/#1110/#1173/#1178):
   **37 DONE, 2 PARTIAL** (primitive parity mostly ported; monolith extraction has `derive.ts` but
   pages still large), **7 OPEN** — 6 of which are the deliberate owner-decision TBDs (dark-mode dual
   mechanism, console.css→@theme epic, Vol semantics, React.memo, useConsoleData abort, order-column
   consolidation) and 1 actionable-but-deferred internal refactor (`useConsoleSnapshot()` hook).
   No conflicts with past decisions found.

## Files
`app/console/components/chrome.tsx`, `app/console/components/nav.tsx`, `app/console/console.css`,
`docs/EFFORT-LOG.md`, `STATUS.md`, this note.

## Verification
`npm run build` (regenerates stale `.next/types`) → `npx tsc --noEmit` → `npm test` — run by the
coordinator after the team's edits; results recorded on the PR. Agents each verified tsc on their
own files during implementation.

## Follow-ups
- Deferred: `useConsoleSnapshot()` narrowing hook (S), monolith extraction completion (M).
- TBDs remain owner decisions (already on the board).
- Owner visual check on device recommended after merge: scope dropdown on desktop + phone, Tabs
  sheet on iPhone (bar visible beneath), badge clearance.
