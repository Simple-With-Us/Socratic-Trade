# 2026-07-01 — UX / IA / aesthetics (audit workstream "Chat F", UI portion)

## Summary

Implemented the UI/IA/aesthetics items (F1, F3–F10) of the "Chat F" audit
workstream (`docs/reviews/2026-07-01-audit-work-split.md`, lines 200–245). This
is the pure UI/IA/docs half; the `src/lib` half (F2 audit call, and populating
the `redTeamVerdict` field) is owned by a sibling agent (Agent B). F1 here is the
**render side only**, coded against the contracted optional shape
`redTeamVerdict?: { rejected: boolean; available: boolean; reason: string }`.

Items landed:

- **F1 — Bear Review block (render).** New `BearReview` component in
  `app/dashboard-client.tsx` renders `p.proposal.redTeamVerdict` as a distinct
  tinted/bordered callout below the Bull rationale in `DecisionView`'s
  pending-approval card. Three states — survived (green/`ShieldCheck`), rejected
  (red/`ShieldAlert`), unavailable (neutral/`Shield`) — plus the `reason`.
  Renders `null` when the field is `undefined` (backward compat with old data).
- **F3 — Persistent ⌘K command-bar button.** Added a `Search`-icon button with a
  `⌘K` `<kbd>` hint to the header "Action buttons" sub-container; it calls the
  same `setCmdOpen(true)` the keydown listener uses. Has `aria-label`,
  `aria-keyshortcuts`, and `title`. `<kbd>` styling matches
  `command-palette.tsx`.
- **F4 — Fixed `docs/phase-8-cockpit-ui.md` IA.** "User-Facing Tabs" now lists
  all **7 workspace tabs** (`Decision, Assistant, Market Scan, Macro,
  Performance, Tax, Strategy`) and all **4 feed tabs** (`Activity, Runs,
  Notifications, Audit`), documents the new Macro/Tax overflow, and corrects the
  stale "three fixed rows … bottom drawer" layout-model claim (feeds are a right
  slide-over now).
- **F5 — Macro + Tax demoted to a "More" overflow.** New `WorkspaceTabsBar`
  component renders the 5 primary tabs via the shared `Tabs` primitive plus a
  "More" menu holding Macro and Tax. Overflow items are `role="tab"` +
  `aria-selected`; the trigger shows the active overflow tab's label. Deep-link /
  persistence unchanged — still the same `workspaceTab` state + `WORKSPACE_TAB_KEY`.
- **F6 — Tap-to-expand rationale.** New `ProposalRationale` component: the
  clamped Bull rationale (`line-clamp-3`) now has a keyboard-focusable "Show
  more"/"Show less" toggle so touch users can expand it; the desktop `title`
  tooltip is kept as a secondary affordance. Only the clamped site was touched.
- **F7 — Empty/loading primitives.** Converted 3 bare-text empty states to
  `<EmptyState>` (positions dropdown, wash-sale lockout, harvest candidates), and
  added a real `.skeleton` loading placeholder (previously dead CSS) at the
  account-deletion-preview loading spot, with an `sr-only role="status"`.
- **F8 — Named elevation/blur tiers.** Added a 3-tier elevation scale
  (`--elev-surface/raised/overlay-*` vars + `.elev-surface/.elev-raised/.elev-overlay`
  utilities) pairing shadow + blur, plus `--blur-scrim` / `.backdrop-blur-scrim`.
  Migrated the four arbitrary `backdrop-blur-[2px]`/`[3px]` sites onto the scrim
  tier. `grep -rn 'blur-\[' app/` → empty.
- **F9 — 3-step icon scale.** Added `export const ICON = { sm:14, md:16, lg:20 }`
  to `primitives.tsx`; migrated the long tail
  (`10/11/12/13→14`, `15/17→16`, `18/24/28→20`) across `app/*.tsx`, `app/ui/*.tsx`,
  and `app/components/*.tsx`. Left `strategy-flow.tsx`'s `<Background size={1}>`
  (a React-Flow dot prop, not an icon). Distinct icon sizes now: 14, 16, 20.
- **F10 — `docs/design/visual-system.md`.** New doc covering color/spacing/radius
  tokens, the elevation/blur tiers (F8), the icon scale (F9), primitives, motion,
  and the WCAG-AA contrast source of truth.

## Why

The audit found the core Bull/Bear decision architecture buried in a truncated
rationale string, the command palette had no discoverable trigger, rationale
truncation was unreachable on touch, an IA doc was stale, and several aesthetic
primitives had drifted (dead `.skeleton` CSS, 12 icon sizes, 7 blur values incl.
arbitrary brackets). These changes surface the Bear verdict, add discoverable
affordances, and consolidate the drifted scales into documented tiers.

## Contract with Agent B (F1)

Agent B added `redTeamVerdict?: { rejected: boolean; available: boolean; reason:
string }` to `TradeProposal` (`src/lib/types.ts:634`) and populates it in
`src/lib/strategy.ts:462`. Confirmed present at implementation time. My render
(`BearReview`) is typed as `verdict: TradeProposal["redTeamVerdict"]` and
gracefully renders nothing when `undefined`, so it is safe regardless of whether
a given proposal carries the field.

## Files

Modified:
- `app/dashboard-client.tsx` — F1 (`BearReview`), F3 (⌘K button + `Search`/`ICON`
  imports), F5 (`WorkspaceTabsBar` + primary/overflow tab config, render swap),
  F6 (`ProposalRationale`), F7 (3 `EmptyState` conversions + `.skeleton` loader),
  F8 (one scrim migration + `Shield`/`ShieldAlert`/`ShieldCheck` imports), F9
  (icon-size literals).
- `app/ui/primitives.tsx` — F9 `ICON` constant export; used it for the `HelpTip`
  icon.
- `app/ui/command-palette.tsx` — F8 scrim migration; F9 `ICON` import + usage.
- `app/ui/overlays.tsx` — F8 scrim migration (2 sites) and F9 icon-size literals.
- `app/globals.css` — F8 elevation/blur tiers + `.elev-*` / `.backdrop-blur-scrim`.
- `app/ui/assistant-console.tsx`, `app/ui/learned-context-queue.tsx`,
  `app/ui/model-picker.tsx`, `app/ui/strategy-flow.tsx`,
  `app/ui/symbol-drilldown.tsx`, `app/error.tsx`,
  `app/components/ConfirmationModal.tsx` — F9 icon-size literal normalization only.
- `docs/phase-8-cockpit-ui.md` — F4 tab lists + layout-model correction.

Created:
- `docs/design/visual-system.md` — F10.
- `docs/rollouts/2026-07-01-ux-ia-aesthetics.md` — this note.

## Verification

Per the coordination rules (four agents sharing one tree), project-wide
`build`/`tsc`/argless `test`/`lint` were **not** run here — the orchestrator runs
the final verify quartet. Targeted acceptance greps confirmed:

- `grep -rn 'blur-\[' app/` → no output (F8).
- `grep -ohE 'size=\{?[0-9]+\}?' app/*.tsx app/ui/*.tsx | sort | uniq -c` → only
  `14`, `16`, `20` (plus the excluded `size={1}` React-Flow Background) (F9).
- `<EmptyState>` conversions present at the 3 target sites; `.skeleton` used at
  the deletion-preview loader (F7).
- ⌘K trigger button present in the header action buttons (F3).
- `docs/design/visual-system.md` exists; `docs/phase-8-cockpit-ui.md` lists 7
  workspace + 4 feed tabs (F4/F10).

## Follow-ups / risks

- **F1 integration:** depends on Agent B's `strategy.ts` populating
  `redTeamVerdict`. If B's change is reverted, the block simply never renders (no
  crash). No type risk — the indexed-access type resolves from the shared
  interface.
- **F5 keyboard nav:** the shared `Tabs` primitive's roving arrow-key nav covers
  the 5 primary tabs; the "More" trigger and its items are Tab/Enter/Escape
  operable and `role="tab"`-annotated, but arrow keys do not traverse into the
  overflow menu (acceptable per acceptance criteria). A future pass could unify
  the two into a single roving tablist if desired.
- **F7:** the positions-dropdown `EmptyState` (default `py-10`) is slightly taller
  than the old one-line text inside its `max-h-72` scroll box — intentional, no
  clipping. Revisit if density feedback warrants a compact `EmptyState` variant.
- Icon-size migration also normalized `app/components/ConfirmationModal.tsx`
  (`24→20`) beyond the stated `app/*.tsx`/`app/ui/*.tsx` acceptance glob, for
  scale consistency; harmless.
- The `.elev-*` utility classes are defined and documented but not yet retrofitted
  onto existing card/menu surfaces (those still use `backdrop-blur-*` +
  `shadow-[var(--shadow✱)]` — ✱ stands for a real asterisk, defused so Tailwind's
  class scanner never treats this note as a candidate); adopting them incrementally
  is a low-priority follow-up.
