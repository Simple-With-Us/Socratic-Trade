# 2026-07-16 - public-renderer-decision-legacy-primitives-slim

## Summary

- Settled a WS-E follow-up decision from the 2026-07-16 UI wave: after `/admin` moved
  onto the console `con-*` design system, the legacy glass-token system
  (`app/ui/primitives.tsx` + `app/globals.css` semantic tokens) remained the renderer
  for the public/marketing surfaces. Decision: **no public page migrates to `con-*`** —
  the public renderer stays deliberately distinct from the console. `app/ui/primitives.tsx`
  is slimmed to its real consumers (`Card`, `Button`, `buttonClass`); every export that
  was reachable only through the `.design-sync` UI-Kit re-export is deleted, along with
  the dead `ThemeToggle` and eight consumer-free `app/globals.css` utilities.
- No page content, routing, or behavior changed. This is a decision-plus-dead-code-removal
  pass on the primitive/token layer underneath the public pages, not a redesign of any
  of them.

## Why

Per `docs/reviews/2026-07-05-ui-audit-and-design-system-unification.md`
("One-sentence recommendation: *Two renderers, one brand core — unify the tokens and the
tone vocabulary now (S-M), defer or abandon the full primitive merge (L, low payoff).*"),
the app deliberately runs two renderers:

- `app/ui` (glass surfaces, animated orbs, light-default, `.dark`-class theming) for
  logged-out marketing/public prose.
- `app/console` (+ `/admin`, migrated 2026-07-16) for the authenticated cockpit, on
  `.console-root`-scoped `con-*` primitives.

Reasons no public page migrates to `con-*`:

1. `app/console/console.css` tokens are scoped to `.console-root` and the file is
   **unlayered**, so `.con-*` class rules beat Tailwind v4 utility rules on specificity.
   Porting prose-heavy marketing pages into that scope is exactly the specificity trap
   documented by the 2026-07-16 settings-de-iOS rollout
   (`docs/rollouts/2026-07-16-settings-deios-admin-integration-ui-review.md`).
2. The brand core is **already shared**, not duplicated: `--brand-accent` /
   `--brand-accent-dark` in `app/globals.css` `:root` feed both `--accent` (public) and
   `--con-accent` (console) — 2026-07-08 UI-audit Package G — and the radius canon
   (`--radius-card: 12px` / `--radius-control: 8px`) is shared the same way. The "one
   brand core" half of the recommendation was already done before this pass.
3. The 2026-07-05 review explicitly says keep glass/orbs for marketing and only drop
   them on data-dense surfaces — public pages are the former, not the latter.
4. Console chrome idioms (rail navigation, `con-card` information density) don't map to
   logged-out marketing prose; forcing them on would be a net regression, not a
   unification.

### Per-page decision table

| Page | Decision | Reason |
|------|----------|--------|
| `app/welcome/page.tsx` | Stays on public renderer | Marketing surface; imports legacy `Card` |
| `app/welcome/decision-trace-illustration.tsx` | Stays on public renderer | Same page family as above |
| `app/how-it-works/page.tsx` | Stays on public renderer | Marketing/explainer surface; imports legacy `Card` |
| `app/framework/framework-viewer.tsx` | Stays on public renderer | Public explainer content |
| `app/framework/page.tsx` (shell) | Stays on public renderer | Legacy-token shell around the viewer above |
| `app/privacy-policy/page.tsx` | Stays on public renderer | Public legal prose |
| `app/terms-and-conditions/page.tsx` | Stays on public renderer | Public legal prose; imports legacy `Card` |
| `app/login` | Stays on public renderer | Legacy-token surface (not `primitives.tsx`-based) |
| `app/access-denied` | Stays on public renderer | Legacy-token surface (not `primitives.tsx`-based) |
| `app/mobile/mobile-pwa-client.tsx` | Stays on public renderer for now | Heaviest remaining legacy-token surface; any future con-* migration is explicitly out of scope for this pass (see Follow-ups) |
| `app/error.tsx` | Stays on public renderer | Root error boundary rendered inside the root layout for any segment without its own boundary (there is no `app/console/error.tsx`); `.console-root` token scoping does not exist at that point in the tree, while `app/globals.css` tokens always do. Pairs with `app/global-error.tsx`, which is deliberately inline-styled and untouched. |
| `app/ui/theme.tsx` | Stays | Root-layout consumer that applies the `.dark` class for the public renderer. Console themes itself independently via `[data-theme]` on `.console-root` plus a console-scoped storage key — the two theming mechanisms are deliberately separate, not a duplication to collapse. |
| `/admin` (all clients) | Already on `con-*` (2026-07-16 UI wave, prior rollout) | Authenticated internal tool, not public/marketing |
| `/console/*` | Already on `con-*` | Authenticated cockpit |

### Stale-premise correction

The task brief that triggered this effort claimed **exactly three** remaining
`app/ui/primitives.tsx` consumers: `app/error.tsx`, `app/framework/framework-viewer.tsx`,
`app/privacy-policy/page.tsx`. Exhaustive recon found **seven** app consumers: those
three plus `app/terms-and-conditions/page.tsx`, `app/welcome/page.tsx`,
`app/welcome/decision-trace-illustration.tsx`, and `app/how-it-works/page.tsx` (all
importing `Card`) — plus an eighth non-app consumer, the `.design-sync/ds-src/index.tsx`
UI-Kit re-export file. Additional legacy-token (non-`primitives.tsx`) surfaces were also
identified during recon: `app/login`, the `app/framework/page.tsx` shell,
`app/access-denied`, and `app/mobile/mobile-pwa-client.tsx`. The premise was corrected
before any deletion — every symbol removed from `app/ui/primitives.tsx` was verified
consumer-free first (reachable only through the `.design-sync` re-export, itself
slimmed in this pass).

## Files

Code (implemented by a parallel agent in this same effort; listed here for the record):

- `app/ui/primitives.tsx` - slimmed to `Card`, `Button`, `buttonClass` (+ internal button
  class maps). Deleted: `ICON` const, `IconButton`, `PanelHeader`, `Tone` type +
  `toneClasses`, `Chip`, `Dot`, `Switch`, `Segmented`, `Tabs`, `Field` (+ internal
  `HelpTip`), `inputClass`, `RawNumInput`, `StatTile`, `EmptyState`.
- `app/ui/theme.tsx` - deleted dead `ThemeToggle` (no importers anywhere).
  `ThemeProvider` / `themeInitScript` / `useTheme` kept unchanged.
- `app/globals.css` - deleted dead utilities: `.elev-surface` / `.elev-raised` /
  `.elev-overlay` (+ six `--elev-*` vars), `.backdrop-blur-scrim` (+ `--blur-scrim`),
  `.skeleton` (+ shimmer keyframes), `.boot-strip-glow` (+ boot-strip keyframes),
  `.scroll-fade-edge`, `.animate-pulse-fast` (+ `pulse-fast` keyframes); the
  `prefers-reduced-motion` block trimmed accordingly. `--shadow` / `--shadow-lg`,
  `.tnum`, the orbs, scrollbar/focus/safe-area rules, and the `@theme` token bridge all
  kept.
- `.design-sync/ds-src/index.tsx` - UI group slimmed to `Button` / `Card` /
  `buttonClass`; preview files for the deleted components removed; config/NOTES
  updated. A full UI-Kit re-sync is a pending follow-up (see below).

Docs (this pass):

- `docs/rollouts/2026-07-16-public-renderer-decision-legacy-primitives-slim.md` (new,
  this file)
- `STATUS.md` (new dated entry at top)
- `docs/design/visual-system.md` (intro bullet; new "Two renderers, one brand core"
  section; "Icon size scale", "Elevation & blur scale", "Primitives & empty/loading
  states", and the Color-tokens Chip/Dot/StatTile paragraph all updated to match the
  slim-down)
- `docs/EFFORT-LOG.md` (In Progress row added before implementation began, per the
  effort-board protocol; flips to Completed when the PR merges)
- `PLAN.md` (new dated entry at top recording the renderer decision; no scope/timeline
  impact on other lanes)

## Verification

All run on the exact final tree in the cloud session (Node 22, fresh `npm install`):

- `npm run lint` - 0 errors, 490 pre-existing grandfathered warnings.
- `npx tsc --noEmit` - clean (run twice: once by the implementation agent right after
  the code edits, once by the orchestrator as part of the ordered gate).
- `npm test` - 402 files / 4,664 tests, all passed (447s).
- `npm run build` - clean; full route table emitted (all public routes present).
- Screenshots (Playwright chromium against a local `next start` of the production
  build): full-page shots of `/welcome`, `/how-it-works`, `/framework`,
  `/privacy-policy`, `/terms-and-conditions`, `/login` in desktop-light AND
  desktop-dark (via the `theme` localStorage key - also proving the theming path
  still works after the `ThemeToggle` deletion), plus `/welcome` at 390px mobile
  width. All render correctly; no visual regression (expected - deletion-only
  change). Notes: `/framework` requires a non-headless UA (its UA gate `notFound()`s
  automation UAs) and `--disable-blink-features=AutomationControlled` for the
  viewer's `navigator.webdriver` check - both are the page's designed anti-scraper
  behavior working, not regressions.
- Dead-reference sweep: repo-wide grep for every deleted class/export name across
  `app/`, `src/`, `scripts/`, `.design-sync/` - zero live references remain (only
  explanatory comments).

## Follow-ups

- `.design-sync` UI-Kit re-sync is pending: the ds-src re-export was slimmed to match
  the real primitive surface, but a full re-sync of the design-sync tooling/catalog
  against the new, smaller `app/ui/primitives.tsx` has not been run.
- Deeper public-page polish items from the WS-E backlog (radius/type sweeps, and other
  items noted in `docs/rollouts/2026-07-16-settings-deios-admin-integration-ui-review.md`)
  remain deferred — this pass only settled the renderer decision and removed dead code,
  it did not redesign any public page.
- `ThemeProvider` / `useTheme` (`app/ui/theme.tsx`) are currently caller-less beyond the
  root-layout wiring itself (no `ThemeToggle` consumer remains after this pass) but are
  kept as the live public-renderer theme API (root layout depends on `ThemeProvider` /
  `themeInitScript` for the `.dark` class + FOUC-avoidance script). Candidate for future
  simplification, or for a future public-page theme toggle if one is ever added.
- `app/mobile/mobile-pwa-client.tsx` is the heaviest remaining legacy-token surface
  identified during recon. Any future decision to migrate it toward `con-*` (or keep it
  on the public renderer) is explicitly out of scope for this pass.

## Environment note

Cloud session, branch `monet/vigilant-fermi-220244`. The branch-neutral live board
`/Users/jay/apps/TRADING-EFFORT-LOG.md` could **not** be updated from this container (no
host filesystem access from a cloud session) — only the repo-tracked mirror
`docs/EFFORT-LOG.md` was updated. The next host-side agent should sync the live board
from the repo mirror for this effort's row.

## Codex autofix triage (2026-07-16, round 1)

- **Codex finding:** `.design-sync/conventions.md` (the design-sync `readmeHeader`) still
  referenced `inputClass` and `StatTile` as importable exports, and the build-snippet example
  imported `StatTile` — all stale after the UI-primitives slim-down.
- **Fix:** Already applied by the Monet/parallel agent in commit `3ec84b8d` before this
  autofix round ran. Prose now explains the removed exports as history; the build snippet
  imports only `Card`, `Button`, `ConBtn` with inline markup replacing the `StatTile` grid.
- **Merge resolution:** `origin/main` was merged into the PR branch (was behind/DIRTY);
  resolved via `git merge` (no conflicts). All 4,665 tests pass (the merge added one test
  from main).
- **Auto-merge** (`--squash --auto`) enabled, awaiting the `verify` CI gate.
