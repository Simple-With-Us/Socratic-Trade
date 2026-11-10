# Visual System — Design Tokens & Scales

> Created 2026-07-01 (audit workstream "Chat F", item F10). Source of truth for
> the app's color, spacing, radius, elevation/blur, and icon-size tokens. Cite
> this doc in future PRs instead of re-deriving values, and update it when you
> add or change a token.

The cockpit's visual language is a small set of **semantic tokens** that flip
between light and dark, plus a handful of **consolidated scales** (elevation,
blur, icon size) introduced to stop ad-hoc drift. Almost everything lives in two
files:

- `app/globals.css` — CSS custom properties (`:root` for light, `.dark` for
  dark), the `@theme inline` bridge that exposes them to Tailwind utilities, and
  the utility classes for the consolidated scales.
- `app/ui/primitives.tsx` — the **public/marketing renderer's** primitive layer:
  `Button`, `Card`, `buttonClass`. Slimmed to just these three exports 2026-07-16
  (`docs/rollouts/2026-07-16-public-renderer-decision-legacy-primitives-slim.md`)
  once every other former export (`Chip`, `Tabs`, `EmptyState`, `ICON`, etc.) was
  found reachable only through the `.design-sync` UI-Kit re-export, not the app
  itself. The console cockpit (`/console`, `/admin`) has its own separate
  primitive home, `app/console/ui/primitives.tsx` — see "Two renderers, one
  brand core" below for which pages use which.

Prefer semantic tokens and primitives over raw hex, raw pixel shadows, or
arbitrary Tailwind bracket values (`bg-[#…]`, `shadow-[…]`, `backdrop-blur-[…]`,
`size={13}`). If a value will be shared across panels/feeds/popovers, add a token
here rather than inlining it.

## Color tokens

Defined in `app/globals.css` and exposed to Tailwind as `bg-*`, `text-*`,
`border-*` utilities via `@theme inline`. Values flip per theme, so the same
markup themes automatically.

| Token | Tailwind | Role |
|-------|----------|------|
| `--bg` | `bg-bg` | App background (behind the glass surfaces). |
| `--surface` / `--surface-2` / `--surface-3` | `bg-surface` / `bg-surface-2` / `bg-surface-3` | Layered translucent glass surfaces (resting → nested). |
| `--line` / `--line-strong` | `border-line` / `border-line-strong` | Hairline borders / stronger dividers & scrollbars. |
| `--fg` | `text-fg` | Primary foreground text. |
| `--muted` | `text-muted` | Secondary text (labels, subtitles). |
| `--faint` | `text-faint` | Tertiary text (hints, meta). |
| `--accent` / `--accent-fg` | `text-accent` / `bg-accent` / `text-accent-fg` | Brand/CTA green + its on-color. |
| `--pos` / `--neg` / `--neg-fg` | `text-pos` / `text-neg` / `text-neg-fg` | Gains / losses (and the loss on-color for danger buttons). |
| `--warn` / `--info` | `text-warn` / `text-info` | Warning / informational status. |
| `--ring` | `focus-visible:ring-[var(--ring)]` | Focus ring. |

Status tones were previously also wrapped by public-renderer `Chip`/`Dot`/
`StatTile` primitives (`neutral | pos | neg | warn | info | accent`); those
three were deleted 2026-07-16 as consumer-free
(`docs/rollouts/2026-07-16-public-renderer-decision-legacy-primitives-slim.md`)
— no public page used them. Tone-wrapping now lives only in the console
system's own `Chip`/`Dot`/`Stat` primitives (`app/console/ui/primitives.tsx`);
use those for any `/console` or `/admin` tinted badge. (Tone vocabulary
standardized on `pos/neg` per the 2026-07-05 UI audit, finding 1.2 — `up/down`
collided with price-direction language, and the console system already used
`pos/neg`.)

### WCAG-AA contrast — source of truth

Contrast is guaranteed at the token level, documented inline where the tokens are
defined:

- `app/globals.css` light + `.dark` blocks — `--muted` and `--faint` are chosen
  to meet **4.5:1 (normal text)** on every surface tier. Recorded worst cases:
  **≥7.3:1** on `surface-3` in light mode; **≥4.85:1 (faint) / ≥6.6:1 (muted)**
  on dark `surface-3` (`#2a2a2a`) after the 2026-07-22 near-black retint.
- **Dark base is neutral near-black** (2026-07-22): public `--bg` and console
  `--con-bg` are `#0a0a0a` (not slate `#111827` / teal-navy `#0b1114`). Surfaces
  step up in grey only. Dark mesh orbs are intentionally low-opacity so login
  and other public pages do not wash blue behind the brand logo.
- `--neg-fg` exists specifically so danger buttons pass AA in dark mode
  (`text-white` on `--neg` measured ≈4.07:1, below 4.5:1). History:
  `docs/reviews/2026-06-21-ui-ux-issue-register.md:89` (issue A11Y-7) and
  `docs/reviews/2026-06-20-ui-ux-and-mobile-audit.md:245`.

Rule: `text-faint` is used for **real** labels/table headers, not just decoration,
so any new faint-on-surface combination must still clear 4.5:1. When adding or
retinting a text token, re-check it against `surface-3` (the worst-case
background) in both themes before committing.

## Brand accent (2026-07-08, UI-audit Package G)

The app ships two design systems — `app/ui` (legacy/marketing surfaces) and
`app/console` (the `/console` cockpit) — that previously carried two distinct
brand accents (`app/ui` green `#0e9f6e`/`#10b981`, console teal `#12616f`/
`#58c7d3`). **Console teal is now the single brand accent both systems derive
from**, per `docs/reviews/2026-07-05-ui-audit-and-design-system-unification.md`.

- `app/globals.css` `:root` defines two invariant constants —
  `--brand-accent: #12616f` (light) and `--brand-accent-dark: #58c7d3` (dark).
  They're plain, non-flipping values (not a `:root`/`.dark`-switching pair)
  because `app/console/console.css` themes itself independently via
  `[data-theme]`, not the `.dark` class, so it needs to resolve either one
  directly regardless of ancestor `.dark` state.
- `app/globals.css` `--accent` (light) / `.dark --accent` (dark) now read
  `var(--brand-accent)` / `var(--brand-accent-dark)` — `app/ui`'s accent moved
  green → teal. `--accent-fg` (`#ffffff` light, `#04130d` dark) already clears
  WCAG AA against the new teal (~7.1:1 light, ~9.5:1 dark) — no change needed,
  and it mirrors console's own `--con-accent-contrast` pairing (`#ffffff` /
  `#071316`). `--ring` is now derived (`color-mix(in oklab, var(--accent) …%,
  transparent)`) instead of a hardcoded rgba, so the focus ring always tracks
  brand accent.
- `app/console/console.css` `--con-accent` (light) and both dark blocks now
  read `var(--brand-accent)` / `var(--brand-accent-dark)` — same visual values
  as before, console is simply the canonical source the shared tokens were
  read from. Every `--con-*-soft`/`--con-*-border` derived tint is unaffected
  (they `color-mix` off `--con-accent` already).
- `--accent` stays distinct from `--pos` (gain/green) in both systems by
  design — accent is brand/CTA, not a P&L signal.

## Radius canon (2026-07-08, UI-audit Package G)

Console's card/control radii are canonical. `app/globals.css` `@theme inline`
defines `--radius-card: 12px` and `--radius-control: 8px` (sourced from
console's own `--con-radius`/`--con-radius-sm`), and
`app/console/console.css` maps `--con-radius`/`--con-radius-sm` back to them
so both stay in lockstep. This does **not** retarget `app/ui`'s existing
`rounded-xl`/`rounded-2xl` usage — those are unchanged. Future `app/ui` work
that wants to align with the console radius scale should reach for the new
`rounded-card`/`rounded-control` Tailwind utilities (generated from the
`--radius-card`/`--radius-control` `@theme inline` vars) rather than
`rounded-xl`/`rounded-2xl` or an arbitrary value.

## Two renderers, one brand core (2026-07-16)

The app deliberately ships **two renderers**, not one unified system, per
`docs/reviews/2026-07-05-ui-audit-and-design-system-unification.md` ("Two
renderers, one brand core — unify the tokens and the tone vocabulary now, defer
or abandon the full primitive merge"). This was reaffirmed as a settled decision
2026-07-16
(`docs/rollouts/2026-07-16-public-renderer-decision-legacy-primitives-slim.md`)
when the last public-page consumers of the legacy primitive layer were audited:
no public page migrates onto the console's `con-*` system.

**Which pages ride which renderer:**

- **Public renderer** (`app/ui/primitives.tsx` + `app/globals.css` semantic
  tokens; glass surfaces, animated orbs, light-default): `app/welcome`,
  `app/how-it-works`, `app/framework`, `app/privacy-policy`,
  `app/terms-and-conditions`, `app/login`, `app/access-denied`,
  `app/mobile/mobile-pwa-client.tsx`, and the root `app/error.tsx` boundary
  (rendered inside the root layout for any segment without its own error
  boundary — there is no `app/console/error.tsx`, so `.console-root` token
  scoping does not exist at that point in the tree).
- **Console renderer** (`app/console/ui/primitives.tsx` + `app/console/console.css`
  `con-*` tokens): `/console` and `/admin` (the latter migrated onto `con-*` in
  the 2026-07-16 UI wave).

**The shared brand core.** The "one brand core" half of the recommendation was
done in 2026-07-08 UI-audit Package G and did not change in this pass:
`--brand-accent` / `--brand-accent-dark` in `app/globals.css` `:root` feed both
`--accent` (public renderer) and `--con-accent` (console renderer), and the
radius canon (`--radius-card: 12px` / `--radius-control: 8px`) is shared the
same way — see "Brand accent" and "Radius canon" above.

**Why the renderers stay separate.** `app/console/console.css` tokens are
scoped to `.console-root` and the file is **unlayered**, so `.con-*` class
rules beat Tailwind v4 utility rules on specificity. Mixing `con-*` classes
into a public page (or public-renderer classes into `.console-root`) is the
specificity trap documented in the 2026-07-16 settings-de-iOS rollout
(`docs/rollouts/2026-07-16-settings-deios-admin-integration-ui-review.md`) —
don't do it in either direction.

**Where each renderer themes.** The public renderer applies dark mode via a
`.dark` class on `<html>`, toggled by `app/ui/theme.tsx` (`ThemeProvider` /
`themeInitScript` / `useTheme`) and persisted under a `theme` storage key.
Console themes itself independently via `[data-theme]` on `.console-root` with
its own console-scoped storage key. These are deliberately two separate
mechanisms, not a duplication to collapse — `app/ui/theme.tsx` stays as the
public renderer's theme API for exactly this reason.

## Radius & typography

- Radius tokens: `--radius-xl: 16px`, `--radius-2xl: 20px` (`@theme inline`),
  surfaced as `rounded-xl` / `rounded-2xl`. Cards use `rounded-2xl`; inputs,
  buttons, chips, and menu items use `rounded-lg`/`rounded-md`. See "Radius
  canon" above for the separate `--radius-card`/`--radius-control` pair
  console.css sources from.
- Fonts: `--font-sans` (Inter) for UI, `--font-mono` (JetBrains Mono) for code.
  Numeric/tabular data uses the `.tnum` helper (`font-variant-numeric:
  tabular-nums`) so digits align in tables.

## Spacing

Spacing follows Tailwind's default 4px scale — there are no custom spacing
tokens. Conventions in use: cards pad `px-4 py-3`/`p-4`; panel headers
`px-4 pt-4`; inter-card gaps `gap-2`/`gap-3`; dense inline gaps `gap-1.5`.
Touch targets honor a `max-sm:min-h-11` (44px) minimum on interactive controls
(buttons, tabs, icon buttons) for mobile accessibility.

## Elevation & blur scale (consolidated 2026-07-01, item F8; `.elev-*` tier retired 2026-07-16)

Previously there were only two shadow tiers (`--shadow`, `--shadow-lg`) while
`backdrop-blur` usage had drifted to seven distinct values, including arbitrary
`backdrop-blur-[2px]` / `backdrop-blur-[3px]` that bypassed the Tailwind scale.
2026-07-01 (item F8) introduced a named 3-tier elevation scale (`.elev-surface`
/ `.elev-raised` / `.elev-overlay`, each pairing a shadow with a backdrop-blur
var) plus a dedicated `--blur-scrim` / `.backdrop-blur-scrim` utility for
overlay scrims, to stop that drift.

**2026-07-16 update:** the `.elev-surface` / `.elev-raised` / `.elev-overlay`
utility classes, their six `--elev-*-shadow` / `--elev-*-blur` variables, and
`--blur-scrim` / `.backdrop-blur-scrim` were all deleted as consumer-free
(`docs/rollouts/2026-07-16-public-renderer-decision-legacy-primitives-slim.md`)
in the same pass that slimmed `app/ui/primitives.tsx`. The base tokens they
were built on were **not** touched: `--shadow` / `--shadow-lg` remain the
app's two shadow tiers, still flip light/dark automatically, and are still the
right tokens to reach for via `shadow-[var(--shadow)]` /
`shadow-[var(--shadow-lg)]`-style Tailwind arbitrary-value utilities. Plain
`backdrop-blur-{sm,md,lg,xl,2xl}` utilities also remain valid for one-off
surfaces. If a coordinated shadow+blur elevation tier is needed again in the
future, reintroduce it deliberately rather than assuming `.elev-*` still
exists.

## Icon size scale (consolidated 2026-07-01, item F9; `ICON` export retired 2026-07-16)

Lucide icon `size=` values had drifted to twelve distinct numbers
(10,11,12,13,14,15,16,17,18,20 plus stray 24/28). 2026-07-01 (item F9)
collapsed them to a 3-step scale, `ICON = { sm: 14, md: 16, lg: 20 }`, exported
from `app/ui/primitives.tsx`, with this migration mapping applied to the long
tail: `10/11/12/13 -> 14`, `15/17 -> 16`, `18/24/28 -> 20`.

**2026-07-16 update:** the `ICON` export itself was retired
(`docs/rollouts/2026-07-16-public-renderer-decision-legacy-primitives-slim.md`)
— its only consumers were primitive components (`IconButton`, `PanelHeader`,
etc.) deleted in the same pass. The underlying **3-step convention still
stands** for the public renderer; public-page code now writes the literal
values directly instead of importing the constant (e.g. `app/error.tsx` uses
`size={20}` on its header icon and `size={14}` on its retry-button icon). The
console renderer manages its own icon sizing independently and was never a
consumer of this export.

| Step | Value | Use |
|------|-------|-----|
| sm | 14 | Inline / dense: chips, table cells, tight button glyphs, "Show more" toggles. |
| md | 16 | Default: buttons, panel-header icons, most controls. |
| lg | 20 | Prominent: modal-header icons, empty-state glyphs. |

**Out of scope:** `app/ui/strategy-flow.tsx`'s `<Background ... size={1}>` is a
React-Flow dot-grid prop, **not** an icon — leave it.

## Primitives & empty/loading states

- **Empty states:** the public renderer's `EmptyState` primitive
  (`app/ui/primitives.tsx`) was deleted 2026-07-16 as consumer-free
  (`docs/rollouts/2026-07-16-public-renderer-decision-legacy-primitives-slim.md`)
  — no public page currently renders an empty state. The console's `Empty`
  primitive (`app/console/ui/primitives.tsx`) remains the cockpit's empty-state
  idiom; use it for any `/console` or `/admin` empty state.
- **Loading skeletons:** the public renderer's `.skeleton` class
  (`app/globals.css`) was likewise deleted 2026-07-16 as consumer-free, along
  with its shimmer keyframes and `prefers-reduced-motion` variant.

## Motion & accessibility notes

- A global `:focus-visible` outline plus `focus-visible:ring-[var(--ring)]` makes
  keyboard focus visible on all interactive primitives.
- `@media (prefers-reduced-motion: reduce)` disables the background orbs. Its
  `.skeleton` shimmer, boot-strip, and fast-pulse entries were removed
  2026-07-16 along with those utilities themselves (see "Elevation & blur
  scale" and "Primitives & empty/loading states" above).
- Tab groups use `role="tablist"`/`role="tab"` with `aria-selected` and roving
  `tabIndex`. (The public renderer's `Tabs` primitive that established this
  pattern was deleted 2026-07-16 as consumer-free — the pattern itself still
  binds any future tab implementation; the console implements its own tab
  semantics.)
- iOS zoom is prevented by forcing 16px form-control font size below `sm`, and
  safe-area insets are applied via `env(safe-area-inset-*)`.

## Related docs

- `docs/phase-8-cockpit-ui.md` — cockpit information architecture, tab lists,
  display semantics, and accessibility expectations.
- `docs/reviews/2026-06-30-improvement-audit.md` — the audit that flagged the
  drifted scales (dimension 6.6, "Aesthetic appeal") this doc consolidates.
