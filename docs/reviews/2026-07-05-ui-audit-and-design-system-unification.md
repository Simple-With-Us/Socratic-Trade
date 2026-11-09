# UI Audit & Design-System Unification — Expert Panel Review

**Date:** 2026-07-05 · **Author:** CLAUDE (multi-agent expert panel) · **Type:** review + design direction + plan
**Interactive report:** https://claude.ai/code/artifact/792a356c-79df-4bb1-b413-5979dd67a909

> Owner asked for a team of experts to thoroughly test the UI for flaws, analyze the
> "Socratic Trade UI Kit" (claude.ai/design project), improve/polish the design, and plan how to
> adopt the Kit. This doc is the durable record; the interactive artifact distills it for scanning.

## Method

A 7-lens expert panel (design-system architecture, visual/brand polish, UX & information
architecture, accessibility/WCAG, responsive/mobile/PWA, trading-domain data UX, frontend
engineering) audited the live code. Each lens's findings passed through an **adversarial verifier**
that re-opened the cited files in current code — **4 rejected, 23 severity-adjusted, 55 survived**
(1× P0, 12× P1, 27× P2, 15× P3). A 2-track analysis decoded the UI Kit's
fidelity and role; two synthesis leads produced the direction and plan below. 18 agents, ~1.67M tokens.

## The reframe (three verified facts)

1. **Two disjoint design systems, not one.** `app/ui/primitives.tsx` + `app/globals.css` (semantic
   Tailwind tokens, glassmorphism, light-default) powers marketing + the legacy dashboard; a separate
   bespoke `app/console/ui/primitives.tsx` + `app/console/console.css` (`con-*` classes, `.console-root`,
   `data-theme`) powers every `/console` page. They share no code ("no imports from app/ui/*"); three
   files (`primitives.tsx`, `symbol-drilldown.tsx`, `ticker-logo.tsx`) are duplicated across both.
2. **The "Socratic Trade UI Kit" is a faithful export of the app's own code**, not a nicer redesign —
   its `.jsx` are re-export shims over a compiled bundle, hash-tied to source (`_ds_sync.json`). It
   mirrors both systems (12 `ui` + 18 `Con*` = 30 leaf primitives) and adds per-component docs. Any
   "it looks more polished" impression is a neutral-canvas presentation effect, not a design/code delta.
3. **Both systems are well-built** (semantic tokens, WCAG-AA notes, "money-reality is word-first,"
   `color-mix` tones, zero raw hex in `ui`). This is a coherence & polish job, not a rescue.

---

# Unified & Polished Design Direction — Socratic Trade

## 1. The two-system split: verdict and reconciliation path

**Verdict: keep two rendering systems, but collapse them onto ONE shared token core and ONE shared tone vocabulary. Do not attempt a full component merge, and do not keep the token layers independent.**

The instinct to unify everything into one primitives file is wrong here, and the instinct to leave the split alone is also wrong. The evidence points to a specific middle path:

- The console (`app/console/console.css`, 1032 lines of bespoke `con-*` classes over `--con-*` tokens) and the "ui" system (`app/globals.css` `@theme inline` + Tailwind utilities) are **genuinely different styling methodologies**, not two skins of one thing. `console.css` header explicitly declares "Own design system — no imports from app/ui/\*" and `app/console/ui/primitives.tsx:3` repeats it. Adoption is ~even (49 files on `con-*`, 43 on `ui/primitives`). A big-bang merge is an L-effort migration that touches ~90 files and risks regressing the real operator cockpit for no user-visible gain — the Kit analysis is decisive on this ("any 'Kit looks better, let's use its style' instinct is a false signal — there is no distinct Kit style to adopt").
- But the split has leaked into **the token layer**, and that is where it actively hurts. The brand accent hue diverges (`--accent: #0e9f6e` green vs `--con-accent: #12616f` teal — verified `globals.css:27` and `console.css:34`), the tone vocabularies diverge (`neutral|up|down|warn|info|accent` vs `muted|accent|pos|neg|warn|none|paper|live`), radius diverges (16px card vs 12px card), and dark-mode is flipped by two uncoordinated mechanisms (`.dark` class + `theme` key vs `data-theme` attribute + `console:theme` key). A user crossing from `app/page.tsx` into `/console` sees the primary brand hue change with no explanation. **That is drift, not a design decision** — `docs/design/visual-system.md` documents only the green side and never mentions the teal, so nobody chose this.

### The reconciliation: a shared "brand core" both systems consume

Introduce a single, framework-agnostic root token file — `app/design-tokens.css` (plain CSS custom properties on `:root`, no `@theme`, no `con-` prefix) — that owns the decisions that must be identical across the whole product:

```css
:root {
  /* Brand + semantic hues — ONE source of truth */
  --brand-accent-l: #0e9f6e;  --brand-accent-d: #10b981;
  --sem-pos-l:  #157f4e;  --sem-pos-d:  #37c58c;
  --sem-neg-l:  #d1332e;  --sem-neg-d:  #f0635e;
  --sem-warn-l: #9a6209;  --sem-warn-d: #e5aa4b;
  --sem-info-l: #2563eb;  --sem-info-d: #60a5fa;
  /* Money-reality — the app's most load-bearing semantics */
  --reality-none-l: #64748b; --reality-paper-l: #4f46e5; --reality-live-l: #d1332e;
  /* Shape */
  --shape-card-radius: 14px;   --shape-control-radius: 8px;
}
```

Then `globals.css` and `console.css` each **derive** their own named tokens from this core rather than hardcoding hex:

```css
/* globals.css */         --accent: var(--brand-accent-l);
/* console.css */         --con-accent: var(--brand-accent-l);
```

This is a **near-mechanical change** (S–M effort) that fixes four findings at once: brand-accent divergence, radius divergence, tone-hue divergence, and the undocumented-drift problem. Each system keeps its own methodology (`con-*` classes stay, `@theme` utilities stay) — only the *values* converge. Pick **one accent hue** in that core. My recommendation: keep the **green** (`--accent` green is the documented brand color, the marketing pages, the logo comps in commit `940d3f4f`, and the domain identity all lean green) and retire the console teal — the teal reads as an accident of a separate author, not a deliberate "cockpit is cooler" choice.

### The three migration seams, in priority order

1. **Tone vocabulary (S, do first).** Standardize on `pos/neg` everywhere and delete `up/down` as a tone name. `up`/`down` collides with price-direction language in a trading app; `pos/neg` is unambiguous. Port `pos/neg/warn/info/accent/muted` into `app/ui`'s `Tone` union (`primitives.tsx:109`) and keep console's domain-only tones (`paper`/`live`/`none`) as console-specific with a documented reason. One shared headless `Tone` type both files import.
2. **Dark-mode resolution (M).** Share one resolved light/dark state so a single toggle flips both surfaces. `app/ui` applies it via `.dark`, console via `data-theme` — that's fine — but both should read one persisted source and the console's tri-state `system|light|dark` must map cleanly (don't reduce it to a boolean). Generate `console.css`'s duplicated `@media (prefers-color-scheme)` dark block from the explicit `[data-theme="dark"]` block at build time to kill the hand-maintained "KEEP THE TWO BLOCKS IDENTICAL" hazard (`console.css:13`).
3. **Rename the three ambiguous duplicate files (S).** `symbol-drilldown.tsx`, `ticker-logo.tsx` exist in both `app/ui/` and `app/console/ui/` with **forked logic**, not shared code (console's `symbol-drilldown` is 424 lines + a 641-line `drilldown-sections.tsx` over `useConsoleData()`; ui's is 303 lines, prop-based). Identical filenames falsely imply "one component, two skins" and misdirect searches. Rename the console copies (`console-symbol-drilldown.tsx`, `console-ticker-logo.tsx`) and extract the genuinely-shared bits (`monogram()` slice, size maps) into a headless module — `normalizeTickerLogoSymbol` is already shared via `@/lib/ticker-logos`, so this is a small residual.

**One-sentence recommendation:** *Two renderers, one brand core — unify the tokens and the tone vocabulary now (S–M), defer or abandon the full primitive merge (L, low payoff).*

---

## 2. Elevated visual language for a professional trading cockpit

The current system is competent — token discipline in `app/ui` is genuinely good (0 raw `bg-[#...]`, 0 `blur-[...]`), and both palettes hit WCAG AA on text. The gap between "competent" and "the cockpit a serious trader trusts with real money" is **restraint and rhythm**, not more color. Specific, actionable moves:

### Glassmorphism / animated orbs — **DROP over data-dense surfaces, keep for marketing**
Decide it cleanly: the animated background orbs (`globals.css:130–156`, two `::before/::after` layers with 24s/28s infinite radial-gradient animation) are body-scoped to `app/ui` pages and correctly **do not reach `/console`** (verified: `.console-root` is a separate stacking context; the earlier "orbs compete with the thesis card" finding was downgraded to P3 precisely because they don't apply there). So:
- **Marketing/entry (`welcome`, `how-it-works`, `page.tsx`, `login`):** keep the orbs. They're on-brand and only visible where there's no data to misread.
- **Console:** it already has no orbs — good. But the `.con-thesis-hero` diagonal accent wash (`console.css:222–224`, `linear-gradient(135deg, accent 10%, transparent 46%)`) should go. A cockpit selling *inspectable reasoning* should hold its live thesis text on a **flat, legible surface**. Replace the wash with a **3px accent left-rule** — signals "this is the primary reasoning surface" with zero tint over text.
- **Translucent `backdrop-blur` on resting cards:** tame it. `app/ui` Card is `bg-surface/80 backdrop-blur-sm` — fine for marketing, but the console's `--con-surface` is already **opaque** (`#ffffff` / `#11191d`), which is the right call for data density. Do not add glass to console cards. On `app/ui` **data** surfaces (the legacy dashboard), sweep the 34 raw `backdrop-blur-md/-lg/-xl` in `dashboard-client.tsx` onto the built-but-unused 3-tier `.elev-surface/.elev-raised/.elev-overlay` utilities (`globals.css:222–236`) so glass depth is a 3-value decision, not a per-instance guess.

### Type scale — **name the micro-sizes, kill the bracket drift**
`dashboard-client.tsx` uses one-off pixel brackets heavily: `text-[10px]`×23, `text-[11px]`×52, `text-[12px]`×13 (byte-identical to `text-xs` — pure noise), `text-[13px]`×53 (one step off `text-sm`). There's no named home for micro-labels so they read as sized-by-eye. Console has a proper 7-step named scale (`--con-fs-xs..xxl`, 11→30px) — mirror that discipline into `app/ui`:

```css
/* globals.css @theme */
--text-2xs: 11px;   /* new: the only legit micro size */
/* keep: text-xs=12px, text-sm=14px, text-base=16px */
```
Then sweep: `text-[10px]`/`text-[11px]` → `text-2xs`, `text-[12px]` → `text-xs`, `text-[13px]` → `text-sm`. Delete every bracket size. Do this in the same pass as the `elev-*` sweep — one "ad-hoc scale drift" PR on `dashboard-client.tsx`.

### Spacing rhythm & density
The console's `--con-fs-base: 13.5px` at `line-height: 1.5` (`console.css:92–93`) is the right *information density* for a cockpit — keep it. Establish a **4px base grid** as a documented rule (both systems already mostly land on it) and a **two-density contract**: `comfortable` (marketing, forms) vs `compact` (tables, scan, orders). Today "compact" is implicit; make it a class the tables opt into so row padding is one decision, not per-table.

### Color semantics — **collapse the rainbow to the 5-tone system**
The account-capability badges in `dashboard-client.tsx` use a **9-color non-semantic rainbow** (blue IRA, yellow Margin, orange Short, purple Options, cyan Crypto, pink Futures — verified `:6988–7007`), none of which reference `--info/--warn/--up/--down`. This is the single most unprofessional color moment in the app. Collapse to **one `--info` chip** for all informational capability tags, `--warn` for "OAuth needed" only, and reserve `--up/--down` strictly for gain/loss. If capability types need to be distinguished, **vary the icon under one shared Chip style, not seven hues.**

### Elevation — three tiers, enforced
Adopt the already-defined tiers as the *only* elevation vocabulary: `surface` (4px blur, resting cards), `raised` (12px, popovers/menus), `overlay` (40px, modals/palette). Give console equivalent named shadow tiers derived from the same shared scale (console currently has `--con-shadow` / `--con-shadow-lg` — a 2-tier scale; align it to the 3-tier model).

---

## 3. Per-primitive polish (the 30 Kit primitives, grouped)

The Kit is a **faithful hash-tied mirror** — refining a primitive means refining the app source it points at, then re-syncing. Grouped by what actually needs work:

**Group A — Tone/semantics unification (highest value, touches the most primitives):**
`Chip`, `Dot`, `Stat`/`StatTile`, `SignedText`, `Meter`. These carry the tone divergence. Fixes: (1) both `Chip`s adopt the shared `pos/neg/...` vocabulary; (2) console's three separate tone→token maps (`CHIP_CLASS` at `primitives.tsx:69–78`, untyped `DOT_COLOR` at `:98–104`, inline `Stat`/`SignedText` ternaries at `:138`/`:280`) collapse to **one exported `TONE_VAR: Record<Tone,string>`** so adding a tone is one edit and `Dot` can't silently drift from `Chip`; (3) **`Meter` breach state** — it clamps at 100% and renders at-cap and over-cap identically (`primitives.tsx:112–121`). When `value > max`, keep width at 100% but switch to a **hatched/striped breach fill** + show the overage magnitude. This is a risk-legibility primitive; "at cap" vs "over cap" must be visually distinct.

**Group B — Parity gaps (port across, don't leave asymmetric):**
`IconButton` and `Segmented`/`Tabs` exist in `app/ui` but **not console**; `Meter`, `LiveTag`, `RawNumInput`, `Ago`, `SignedText`, `Dash` exist in console but **not `app/ui`**. Domain primitives (`Meter`, `LiveTag`) legitimately stay console-only. But **`IconButton` and `RawNumInput` are not domain-specific** and should exist in both — console currently hand-rolls a segmented control in `policy-form.tsx:217` because no `Segmented` primitive exists there.

**Group C — Control-state completeness:**
`Switch`/`Toggle` — `app/ui` `Switch` has **no `disabled` prop** (`primitives.tsx:152–160`) while console `Toggle` does. Add `disabled` to `Switch` (cheap) and migrate its thumb from inline ternary classes (`translate-x-6`/`translate-x-1`) to console's cleaner attribute-selector pattern. `Field` — reconcile `label: string` (ui) vs `label: ReactNode` (console); **`ReactNode` wins** (strictly more capable).

**Group D — Touch-target floor (a11y, affects every interactive primitive on console):**
`Btn`, `IconButton`-equivalents, chrome triggers. `.con-btn` has no `min-height` (`console.css:370`); `.con-btn-sm` renders ~26px tall (`:435`); `UserMenu` trigger is `h-8 w-8` = 32px (`chrome.tsx:674`). `app/ui` already bakes a mobile floor (`max-sm:min-h-11`, `primitives.tsx:33`). **Add a `@media (pointer: coarse)` 44px floor to `.con-btn` and the compact chrome triggers** — mirror the proven `app/ui` pattern.

**Group E — Leave alone:** `Card`, `Button`/`Btn`, `Empty`/`EmptyState`, `TextInput`/`NumInput`, `Select`, `TextArea`, `PanelHeader`, `LiveTag`, `Ago`, `Dash` are fine as-is beyond the token-core rewiring; don't add filler polish.

---

## 4. High-value composites to add to the system/Kit

The Kit documents 30 **leaf primitives** but none of the ~15 **composites** that actually constitute the cockpit — and the Kit analysis is explicit that these composites are "what actually drive the 'is the live app polished' perception." Promote these to first-class, documented, Kit-synced components (in priority order):

1. **DataTable** — the single highest-value add. Scan/Orders/Positions each hand-roll `<table class="con-table">` in an `overflow-x-auto` div with **zero responsive variant** (`grep` for `lg:hidden`/`md:hidden` returns nothing across all three). A shared `DataTable` should bake in: sticky first column, sortable headers, a **column chooser**, tabular numerals, and an **automatic `lg:hidden` card-list fallback** (one card per row) mirroring the Activity feed's proven `con-card` pattern. This kills the "dense desktop table served verbatim at 375px" problem in one component.
2. **CommandPalette (console-wired).** `CommandPalette` is fully built (`app/ui/command-palette.tsx`) but **never imported anywhere under `/console`** — the cockpit has zero Cmd+K. Wire a console-scoped palette into `ShellFrame`, seeded with the 13 `DESTINATIONS` + actions (Run once, Stop, switch account). Highest-leverage nav improvement given the destination count.
3. **Sheet/Modal (unified dialog).** Two dialog implementations exist; console `Sheet` (`sheet.tsx:122`) is **missing an accessible name** (no `aria-label`/`aria-labelledby` despite rendering a `<h2>`) while `app/ui` Modal sets it. Standardize one dialog contract with `useId`-derived `aria-labelledby`, focus trap, and **reduced-motion-gated** transitions (the Framer overlays in `app/ui/overlays.tsx:114–202` currently bypass `prefers-reduced-motion` entirely).
4. **AppShell / Nav / MobileTabBar.** `chrome.tsx` (778 lines) is the real app frame; promote its shell + nav + freshness strip as documented composites. Fix the mobile primary-tab selection (currently a positional `DESTINATIONS.slice(0,3)`, not a priority order) and the `FreshnessStrip` clipping under the fixed tab bar (`shell.tsx:119–120`).
5. **Toast**, **Chart set** (equity/price — the equity chart's auto-scale exaggerates flat curves, `equity-chart.tsx:35–41`; add a `±0.5%` minimum Y-span), and **ApprovalCard** (633 lines, the core decision surface).

---

## 5. Highest-impact before → after specs

### 5.1 Money-reality execution banner — P0, fix first
- **Current:** `dashboard-client.tsx:443` builds the LIVE/PAPER banner from fixed dark-palette Tailwind (`border-red-900 bg-red-950/70 text-red-200`). In **light mode (the default)** a LIVE banner renders near-black text on near-black fill on a light page — the app's single most safety-critical signal is illegible exactly where it must read instantly. It references none of the `--up/--down` tokens the rest of the UI repaints from.
- **Target:** rebuild with semantic tokens — `bg-down/15 text-down border-down/40` (live) and `bg-up/15 text-up border-up/40` (paper) — so it inherits the theme-aware pipeline. Pure color-token correctness; **no added confirmation ceremony** (respects product philosophy).

### 5.2 Meter breach state — P2, risk legibility
- **Current:** `Meter` clamps ratio at 1.0 (`primitives.tsx:114`); an at-cap value and a $420-over-cap breach render as the identical full red bar. Used for the daily-notional cap in the topbar and the capital-posture hero.
- **Target:** at `value > max`, hold width at 100% but switch to a **hatched breach fill** + an inline overage badge (`+$420 over`). The bar is the fast-scan affordance; it must distinguish the two states the numbers already report.

### 5.3 Account-capability chips — P1, professionalism
- **Current:** 9-hue rainbow (`:6988–7007`), none semantic, none in the token file.
- **Target:** one `--info` chip for informational capabilities, `--warn` for "OAuth needed," `--up/--down` reserved for P&L. Distinguish types by **icon**, not hue.

### 5.4 Scan → Watchlist deep-link — P1, task flow
- **Current:** Scan table (`scan-table.tsx`) has **no per-row action**; to watch a scanned symbol the user reads the ticker, navigates to `/console/watchlist`, and **retypes it** (watchlist `addSymbol` only reads free-typed `newSymbol` state; no query-param prefill). Two adjacent pipeline screens with a manual retype between them.
- **Target:** a per-row **"Watch" icon-button** that POSTs to `/api/watchlist` directly (or, minimum, deep-links `?add=SYMBOL` and prefills). Ships inside the new `DataTable`'s row-action slot.

### 5.5 Decision-trace back navigation — P1, IA
- **Current:** `/console/decisions/[id]` has one back affordance, a hardcoded `<Link href="/console">` appearing twice (`:118`, `:134`). Reached from Activity, Approvals, and framework links — always dumps the user at the top dashboard, not where they came from. No `router.back()`, `?from=`, or referrer handling.
- **Target:** `router.back()` guarded by `window.history.length > 1`, falling back to Activity/Journal (the primary entry). Or pass `?from=` when linking in.

### 5.6 Console command palette — P1, discoverability
- **Current:** 13 destinations + a mobile "More" overflow, and **every** navigation is a rail-click or tab-tap. `grep` for `metaKey`/`Cmd+K` under `/console` returns nothing.
- **Target:** Cmd+K/Ctrl+K palette in `ShellFrame` (composite #2 above). From-anywhere jump to any destination + core actions.

### 5.7 Bulk-reject inline confirm — P2, consistency (not paternalism)
- **Current:** `runBulkReject()` (`approvals/page.tsx:133`) fires immediately from `onClick` with no confirm; "Select visible" → "Reject selected (N)" discards the whole visible queue on one misclick. Bulk-*approve* is stakes-gated but bulk-*reject* isn't — inconsistent with the app's own asymmetric-friction pattern.
- **Target:** a **one-click inline confirm** (`Reject N proposals? [Confirm]`) — matching the app's existing light-friction ritual. **No typed phrase, no scolding** — a misclick shouldn't wipe the queue, but the owner isn't being protected from a decision they made.

### 5.8 iOS PWA icon + install target — P2, first impression
- **Current:** `apple-touch-icon` and manifest icon are **SVG-only** (`layout.tsx:22`, `manifest.ts:14`); iOS "Add to Home Screen" won't render an SVG, so the installed icon falls back to a generic mark — undercutting the mobile-control pitch. Separately, `start_url: "/mobile"` locks the PWA into the reduced surface with **zero links to `/console`** in the 658-line mobile client.
- **Target:** add 180×180 (apple) + 192/512 PNG manifest entries (keep SVG as an extra). Add an **"Open full console"** link in the `/mobile` header so the install isn't a soft trap.

---

## Constraints honored throughout
Every spec above is a **correctness or clarity** fix, never an obedience/paternalism one: the banner fix is color-token correctness (no new confirm gate); bulk-reject gets a light one-click confirm, not a typed ritual; the Meter breach and capability chips make risk *legible*, not *blocked*; provenance stays in native `title` tooltips per convention; `-` (unavailable) and `n/a` (computed no-value) remain distinct; tabular figures (`.tnum`/`con-num`) are preserved. The token-core unification and Kit composites are **documentation + consistency wins on real app source** — not a redesign, and not a "Kit looks nicer" chase, which the Kit analysis correctly identifies as a presentation-context illusion.

**Sequencing:** (1) P0 banner + the token-core file + `pos/neg` tone rename — one foundational PR. (2) `DataTable` + console command palette + `Meter` breach — the high-leverage composites. (3) The `dashboard-client.tsx` scale/elevation sweep + capability chips + a11y touch-target floor — one hygiene PR. (4) Dark-mode resolution sharing + duplicate-file renames — the deferred-but-cheap consistency cleanup.

Key file references: `app/globals.css`, `app/console/console.css`, `app/ui/primitives.tsx`, `app/console/ui/primitives.tsx`, `app/dashboard-client.tsx`, `app/console/components/chrome.tsx`, `app/console/scan/scan-table.tsx`, `app/console/decisions/[id]/page.tsx`, `app/ui/command-palette.tsx`, `app/console/ui/sheet.tsx`, `app/console/ui/primitives.tsx` (Meter/tone maps), `app/manifest.ts`, `app/layout.tsx`, `docs/design/visual-system.md`.

---

# Implementation Plan & Kit Workflow — Socratic Trade UI

## 1. The Kit workflow: how to actually use claude.ai/design going forward

The Kit is a **faithful, hash-tied mirror** of the app's real primitives, not a redesign. There is no distinct "Kit look" to import — its polish is a neutral-canvas presentation effect. Treat it accordingly: it is a **documentation surface, an isolated iteration bench, and a drift-check tool**, and the canonical direction is always **app → Kit**. The workflow below respects the `/design-sync` golden rule (one component at a time, never a wholesale replace).

### 1a. The per-component iteration loop (design in the Kit, land in the app)

For any single primitive you want to evolve (e.g. giving `Switch` a `disabled` state, or unifying the tone vocabulary on `Chip`):

1. **Pick exactly one component.** Never batch. The Kit regenerates from app source, so a multi-component edit round-trips as a wholesale replace and defeats hash reconciliation.
2. **Iterate the look in the Kit canvas.** Use the Kit's neutral-canvas variant grid (`*.html`) to see every tone/size/state at once — this is the Kit's genuine advantage over the live app, where the primitive is always buried in dense chrome (`console.css` is 1032 lines; `page.tsx` files run 400–900 lines).
3. **Port the change into the app primitive by hand.** Edit the real source — `app/ui/primitives.tsx` for a "ui" component, `app/console/ui/primitives.tsx` for a "Con*" component. The Kit's `.jsx` are re-export shims over a compiled bundle; you do **not** edit those. Keep the change surgical: one component, its `d.ts` prop contract, and its `prompt.md` usage note.
4. **Verify in the real app** at your worktree preview (this branch's port), under real information density — not just the isolated canvas. A primitive that looks right alone can misfire inside `approval-card.tsx` or a `con-table` row.
5. **Run the gate** (`npx tsc --noEmit` → `npm test` → `npm run build`) before you consider the port done.
6. **Re-sync app → Kit** via the DesignSync tool so `_ds_sync.json`'s source/render hashes reconcile to the new app source. Use `list_files`/`get_file` to diff, `finalize_plan` to lock the exact paths, then `write_files`. This closes the loop: the Kit now mirrors the shipped primitive again, and a future drift check is clean.

**Never** do the reverse-first (design a brand-new component only in the Kit and sync it *down* as the source of truth) — the Kit has no build/test/type gate and no composite context, so app-side is always where correctness is proven.

### 1b. A cheap drift-check you can run without opening claude.ai

Because every Kit export is hash-tied to app source, drift is detectable by comparing file hashes. Add a tiny script (S) that hashes `app/ui/primitives.tsx` + `app/console/ui/primitives.tsx` + `app/globals.css` + `app/console/console.css` and diffs against the hashes recorded at last sync. Run it in the same breath as a sync decision. This is the guard against the Kit silently falling behind after a token or primitive change lands.

### 1c. Growing the Kit with composites (the real gap)

The Kit today holds only the ~30 leaf primitives. The pieces that actually drive the "is the app polished" perception are the ~15 composites that live **only** in the app: `chrome.tsx` (778), `approval-card.tsx` (633), `drilldown-sections.tsx` (641), `sheet.tsx`, `overlays.tsx`, `toast.tsx`, `command-palette.tsx`, `alert-center.tsx`, `policy-form.tsx`. Grow the Kit **one composite per sync pass**, and only *after* its constituent primitives are stable — a composite whose primitives are still churning will thrash the Kit. Order them by documentation value: `approval-card` and `drilldown-sections` first (they carry the product's inspectable-reasoning story), chrome/nav last (most coupled to app routing).

### 1d. Also fix the app's own doc gap

`docs/design/visual-system.md` documents **only** the ui system and never mentions the console `--con-*` scale. The Kit's single guideline doc is currently *more complete than the app's own docs*. As you unify tokens (Phase 1), backfill the console token scale into `docs/design/visual-system.md` so the repo has a first-class unified reference and the Kit has an app-side doc to diff against.

---

## 2. Prioritized, sequenced roadmap

Effort: **S** ≈ <½ day, **M** ≈ 1–2 days, **L** ≈ multi-day epic. Phases are ordered so foundations land before the work that depends on them.

### Phase 0 — Quick wins (isolated, high-value, no cross-system risk)

These are self-contained bug/correctness fixes. Do them first; none blocks the others.

| # | Finding | Files | Fix | Effort |
|---|---------|-------|-----|--------|
| 0.1 **P0** | Money-reality banner hardcoded to dark-only Tailwind colors, wrong in light mode | `app/dashboard-client.tsx:443,459` | Rebuild `executionBanner()` on `bg-down/15 text-down border-down/40` (live) and `bg-up/15 text-up border-up/40` (paper) so it repaints per theme like every other status surface | **S** |
| 0.2 **P1** | Command palette built but never wired into console — zero keyboard nav | `app/ui/command-palette.tsx`, `app/console/components/shell.tsx` | Wire a console-scoped palette into `ShellFrame` with Cmd/Ctrl+K, seeded from `nav.tsx`'s 13 DESTINATIONS + Run once/Stop/switch account | **M** |
| 0.3 **P1** | PWA `start_url:"/mobile"` traps installed users off the console | `app/manifest.ts:8`, `app/mobile/mobile-pwa-client.tsx` | Add an "Open full console" link in the /mobile header (fastest, preserves the lite surface) | **S** |
| 0.4 **P1** | Decision-trace back link hardcoded to `/console` | `app/console/decisions/[id]/page.tsx:118,134` | `router.back()` guarded by `window.history.length > 1`, fallback to Journal | **S** |
| 0.5 **P1** | Scan rows have no "add to watchlist" action | `app/console/scan/scan-table.tsx`, `app/console/watchlist/page.tsx` | Per-row Watch icon-button → POST `/api/watchlist`, or deep-link `?add=SYMBOL` + prefill `newSymbol` | **S** |
| 0.6 **P1** | Account capability badges use a 7-hue rainbow off-palette | `app/dashboard-client.tsx:6954–7007` | Collapse to `--info` chips; `--warn` only for OAuth-needed; distinguish by icon not hue | **S** |
| 0.7 **P3** | Login `border-border` is an undefined class → border never renders | `app/login/page.tsx:58,92` | Replace with `border-line`; swap Apple button's manual `neutral-900/white` dark pair for `bg-fg text-bg` | **S** |
| 0.8 **P2** | Bulk-reject fires with no confirm (asymmetric to app's own friction) | `app/console/approvals/page.tsx:258` | One-click inline confirm ("Reject N? [Confirm]") — **not** a typed phrase (product philosophy) | **S** |

**Verify:** each is a single-surface change — run the full gate after the batch, eyeball the banner in **light** mode specifically (0.1), and confirm Cmd+K opens in the console (0.2).

### Phase 1 — Token & foundation unification (the bridge between the two systems)

Tokens are the safe unification seam: converge the *semantics* first, keep both apply-mechanisms (`.dark` class for ui, `data-theme` for console) so nothing visually breaks. **This phase de-risks everything after it.**

| # | Finding | Files | Fix | Effort | Depends on |
|---|---------|-------|-----|--------|------------|
| 1.1 **P1** | Brand accent diverges green (`--accent`) vs teal (`--con-accent`) with no shared source | `app/globals.css:27,64`; `app/console/console.css:34,122` | **Decide one brand hue.** Either derive `--con-accent` from a single `--brand-accent`, or — if marketing-vs-cockpit divergence is intentional — **document it** in `visual-system.md` (currently only covers green). This is an owner decision; surface both options | **S** |
| 1.2 **P2** | Same-named primitives use incompatible tone vocabularies (`up/down` vs `pos/neg`, 6-value vs 8-value) | `app/ui/primitives.tsx:109`; `app/console/ui/primitives.tsx:67` | **Standardize one tone vocabulary.** Adopt `pos/neg` (avoids collision with price-direction "up/down") in both systems. This is the single highest-leverage unification seam — do it before any primitive polish | **S** | — |
| 1.3 **P2** | Type-scale & radius independently defined, no mapping (card radius 16px ui vs 12px console) | `app/globals.css:96–97`; `app/console/console.css:71–81` | Start with radius (2 values each side): agree one card-corner + one control-corner value referenced by both. Defer type-scale (ui has no named scale to migrate into) | **M** | — |
| 1.4 **P1→P2** | Dark-mode dual mechanism (`.dark` + `theme` key vs `data-theme` + `console:theme` key) can desync; console dark block hand-duplicated | `app/ui/theme.tsx`, `app/console/lib/useConsoleTheme.ts`, `app/console/console.css` | Share **one resolved light/dark source of truth**; each system still applies its own way. Map the console tri-state (`system\|light\|dark`), not a boolean. Generate the `@media` dark block from the explicit block to kill the "KEEP THE TWO BLOCKS IDENTICAL" hazard | **M** | 1.2 (shared token layer) |
| 1.5 **P1** | 4th palette at `/design/socratic-trade` with raw hex matching neither system | `app/design/socratic-trade/socratic-trade.module.css` | Delete the route (welcome/how-it-works cover the marketing ground) **or** rebuild on `app/ui` tokens. Borderline P2 — one peripheral route | **M** | 1.1 (so it adopts the settled accent) |
| 1.6 **Doc** | `visual-system.md` documents only the ui system | `docs/design/visual-system.md` | Backfill the `--con-*` scale so the repo has a unified reference and the Kit has something to diff against | **S** | 1.1–1.3 landed |

### Phase 2 — Primitive polish & parity

With tone/radius unified, primitives can be brought to parity safely. Each is per-primitive (Kit loop from §1a applies).

| # | Finding | Files | Fix | Effort | Depends on |
|---|---------|-------|-----|--------|------------|
| 2.1 **P3** | ui `Switch` has no `disabled`; console `Toggle` does | `app/ui/primitives.tsx:152`; `app/console/ui/primitives.tsx:227` | Add `disabled` to ui Switch; consider migrating to console's attribute-selector CSS pattern | **S** | 1.2 |
| 2.2 **P2** | Console lacks a reusable Segmented; `policy-form` hand-rolls one | `app/console/ui/primitives.tsx`, `app/console/components/policy-form.tsx:217` | Port a console-themed `Segmented` into console primitives; refactor policy-form to use it. (Reuse gap, not an a11y defect — console has no true tab surface) | **S** | 1.2, 1.3 |
| 2.3 **P2** | Bidirectional parity gaps (ui: IconButton/PanelHeader; console: Meter/LiveTag/RawNumInput/Ago/SignedText) | `app/ui/primitives.tsx`, `app/console/ui/primitives.tsx` | Build a **parity matrix** (one row/concept, one col/system); port `IconButton` + `RawNumInput` (not domain-specific) both ways; mark Meter/LiveTag console-only with a reason | **M** | 1.2 |
| 2.4 **P3** | Console `Chip/Dot/Stat/SignedText` hardcode 3 separate tone→token maps; `Dot` key can drift from `ChipTone` | `app/console/ui/primitives.tsx:69–104,138,280` | One exported `TONE_VAR: Record<Tone,string>`; derive the rest so adding a tone is one edit | **S** | 1.2 |
| 2.5 **P2** | `dashboard-client.tsx` type-scale drift: `text-[11px]`×52, `text-[13px]`×53, `text-[12px]`×13 (== `text-xs`) | `app/dashboard-client.tsx` | Define 2–3 named micro-type utilities in `globals.css` (`.text-2xs`=11px); sweep brackets onto them; delete `text-[12px]` | **M** | — |
| 2.6 **P2** | `dashboard-client.tsx` uses raw `backdrop-blur-md/lg/xl`×34, `elev-*` scale ×0 (the built remediation was never adopted) | `app/dashboard-client.tsx`, `app/globals.css:222–236` | Sweep blur+shadow combos onto `.elev-surface/.elev-raised/.elev-overlay` | **M** | — |

> **Batch 2.5 + 2.6 as one "ad-hoc scale drift" pass** over `dashboard-client.tsx` — same file, same review, cheaper together.

### Phase 3 — Composites, IA & flows

Higher-surface-area work; do after primitives are stable so composites don't churn.

| # | Finding | Files | Fix | Effort |
|---|---------|-------|-----|--------|
| 3.1 **P2** | Wide tables (Scan/Orders/Positions) have no mobile layout — raw h-scroll only | `scan-table.tsx`, `orders/page.tsx`, `positions.tsx` | Add `lg:hidden` card-list per row, mirroring Activity feed's `con-card` pattern (`activity/page.tsx:404`) | **M** |
| 3.2 **P2** | Public pages are text-only Card grids, no imagery/diagram/screenshot | `welcome/page.tsx`, `how-it-works/page.tsx` | Add a console decision-trace mock (welcome) + loop diagram (how-it-works), built on `app/ui` primitives | **M** |
| 3.3 **P2** | Nav noun collision: "Decisions" (approvals) vs `/decisions/[id]` trace route | `nav.tsx:81`, `decisions/[id]/page.tsx` | Resolve the collision only — **keep the branded Socratic vocabulary**; make "Decisions" refer to one thing across nav and routes | **S** |
| 3.4 **P2** | No manual order-entry path and no note explaining its absence | `orders/page.tsx` | Add a discoverable note ("orders originate from approved proposals"). Manual entry only if in scope, gated like live approvals (no extra ceremony) | **S** |
| 3.5 **P2** | Meter caps at 100%, hiding overage — "at cap" and "over cap" pixel-identical | `console/ui/primitives.tsx:112–121` | On `value>max` keep 100% width but distinct breach treatment (hatched/marker) + surface overage magnitude | **S** |
| 3.6 **P2** | Guardrails edits caps with no inline utilization (derivation already exists) | `guardrails/page.tsx`, `lib/derive.ts` | Inline utilization sub-label/Meter next to Essentials/Exposure rows reusing `deriveRiskUtilization` | **M** |
| 3.7 **P2** | Equity chart auto-scales to visible min/max, exaggerating tiny moves | `equity-chart.tsx:35–41` | Minimum vertical span (≥±0.5% of vMin) so near-flat curves render flat | **S** |
| 3.8 **P2** | Approvals header count ≠ nav badge count (proposals only vs proposals+learned) | `nav.tsx`, `approvals/page.tsx` | Show learned-context count in header when >0 + jump-link anchor | **S** |
| 3.9 **P2** | Duplicated `symbol-drilldown.tsx`/`ticker-logo.tsx` are drifted forks, not skins | `app/ui/*`, `app/console/ui/*` | Rename one of each pair (e.g. `console-symbol-drilldown.tsx`) so identical filenames stop misdirecting searches; extract shared `monogram()` into a headless module | **S** |

### Phase 4 — A11y & mobile hardening

| # | Finding | Files | Fix | Effort |
|---|---------|-------|-----|--------|
| 4.1 **P1** | Console has no touch-target floor; triggers ~32px (< WCAG 2.5.8) | `console.css:370–384`, `chrome.tsx:674,100,191`, `app/ui/primitives.tsx:63` | Add `min-height/width` 44px on `@media (pointer:coarse)`/`max-sm` to `.con-btn` + chrome triggers, mirroring ui's proven `max-sm:min-h-11` | **S** |
| 4.2 **P1** | Table row actions (Cancel/Replace) ~26px — smallest targets on the urgent order screen | `console.css:435–438`, `orders/page.tsx:470,474` | Mobile-only `min-height ~40px` on row-action buttons, or per-row overflow menu on narrow viewports | **S** |
| 4.3 **P1** | AlertCenter filter buttons signal active state by color only, no `aria-pressed` | `alert-center.tsx:158–173` | Add `aria-pressed`; optional `aria-current` on ScopeSelector active row | **S** |
| 4.4 **P2** | Console `Sheet` dialog has no accessible name | `console/ui/sheet.tsx:122–130` | `useId()` heading id + `aria-labelledby`, matching ui's Modal/SlideOver | **S** |
| 4.5 **P2** | Framer overlays (Modal/SlideOver/CommandPalette) ignore `prefers-reduced-motion` | `app/ui/overlays.tsx:114–202`, `command-palette.tsx` | Gate Framer `transition` behind `useReducedMotion()`; correct `visual-system.md:153` overstatement | **M** |
| 4.6 **P2** | ConfirmationModal typed-phrase gate gives no `aria-live` match signal | `app/components/ConfirmationModal.tsx:218–222` | Visually-hidden `aria-live="polite"` on match; mark decorative Check `aria-hidden` | **S** |
| 4.7 **P2** | FreshnessStrip clipped behind fixed mobile tab bar | `shell.tsx:119–120`, `chrome.tsx:753` | Surface daily-spend meter + data-as-of in sticky top chrome on mobile; strip `lg`-only | **S** |
| 4.8 **P2** | SVG-only apple-touch-icon; iOS install won't render it | `app/layout.tsx:22–25`, `app/manifest.ts:14–21` | Add 180×180 PNG apple-touch-icon + 192/512 PNG manifest entries (keep SVG) | **S** |
| 4.9 **P2** | Scan tab switcher lacks ARIA tablist semantics | `console/scan/page.tsx:110–140` | `role="tablist"/"tab"` + `aria-selected` + `aria-controls`/`tabpanel` | **S** |
| 4.10 **P2** | Mobile "More" buries 10 destinations in a flat list; primary tabs are a positional slice | `nav.tsx:131–132,187–206` | Group More into Monitor/Configure/Review clusters; choose primary 3 deliberately (e.g. swap Journal → Orders/Mandates) | **S** |
| 4.11 **P3** | Mobile client has no offline/connectivity handling despite live EventSource | `mobile-pwa-client.tsx:136–150` | `navigator.onLine` + online/offline listeners → offline banner | **S** |

### Deferred / backlog (P2–P3, low ROI now — record, don't schedule)

- **console.css → @theme migration** (**L**, P2): the biggest lever but a dedicated epic across ~49 con-* files. Do **not** attempt incidentally. Prerequisite: Phase 1 tone/radius settled. This is where the two systems could truly converge — scope it as a real migration, not a re-sync.
- **`page.tsx`/`strategy/page.tsx` monolith extraction** (**M**, P2): move pure `derive*` into `lib/derive.ts`, extract presentational sub-components. Skip the RSC framing (interactive cockpit gets no RSC benefit).
- **`useConsoleSnapshot()` narrowed hook** (**S**, P2): removes ~7 top-of-page `!snapshot` guards; nested ones need per-component judgment.
- `app/old` dual-dashboard decision (P3), console memoization headroom (P3), `useConsoleData` unconditional-abort (P3), short-position P&L test (P3), scan Vol-semantics wording (P2), allocation concentration cue (P3), thesis-hero gradient (P3), Orders last-price age suffix (P2), partial/stale/status column consolidation (P3), guardrails framing consistency (P3).

---

## 3. Verification & guardrails

### The gate (every phase, non-negotiable)

Run in this order after each batch, **before** landing:

```bash
npx tsc --noEmit   # fast, first — also fails on stale .next/types (rebuild if so)
npm test           # vitest, ~723 tests / 81 files
npm run build      # full Next build; re-checks types; wipes .next → restart your PM2 preview after
npm run lint       # eslint 9 flat config; REQUIRED verify step; fails on errors only
```

Land via **`bash scripts/land.sh`** (never push to `main` — a pre-push hook blocks it). The script refuses dirty trees, refuses same-file overlap with `origin/main`, runs the tsc→test→build trio itself, and opens a PR. The **`verify` CI check gates merge** (it's a *ruleset*, so `branches/main/protection` reads 404 but is enforced; `--admin` does **not** bypass). Merge with `gh pr merge <n> --squash --auto`. Open PRs **ready, not draft**.

### Per-phase verification emphasis

- **Phase 0:** Toggle **light mode** and confirm the banner reads correctly (0.1 is the P0). Confirm Cmd+K opens in `/console` (0.2). Snapshot each fix in the worktree preview.
- **Phase 1 (highest risk):** After a token change, run the **§1b hash drift check** and eyeball *both* systems in *both* themes. The tone-vocabulary rename (1.2) touches many call sites — lean on `tsc` (the union types will flag every unmigrated `up/down`). Do 1.2 as its own PR so a regression is bisectable.
- **Phase 2:** Use the **Kit per-component loop (§1a)** — iterate on the neutral-canvas grid, port, verify under real density, re-sync. Batch 2.5+2.6 as one file pass with a visual before/after.
- **Phase 3:** Test tables at 375px (3.1); confirm branded nav vocabulary is preserved (3.3).
- **Phase 4:** Verify touch targets at mobile preset; check `prefers-reduced-motion` emulation (4.5); confirm SR announces the AlertCenter active filter (4.3) and the confirm-gate match (4.6).

### Risks of the two-system unification & how to de-risk

1. **Big-bang merge risk.** The console header says "Own design system — no imports from `app/ui/*`" *by design*. Do **not** attempt to merge the two primitive files. **De-risk:** unify *tokens/semantics* only (Phase 1); keep both apply-mechanisms and both class-merge helpers (`cn`/tailwind-merge vs naive `cx`). Tokens are the bridge.
2. **Per-surface blast radius.** con-* adoption spans ~49 files. **De-risk:** never sweep the whole console in one PR; go one primitive / one surface per PR so each is independently revertible and bisectable.
3. **Theme desync during 1.4.** A shared source of truth touches both `theme.tsx` and `useConsoleTheme.ts`. **De-risk:** land 1.2 (shared token layer) first; preserve the tri-state; add a test that a single toggle flips both systems.
4. **Kit drift.** Any token/primitive change silently ages the Kit. **De-risk:** the §1b hash check is part of the definition-of-done for Phases 1–2, and every primitive change re-syncs before the PR is called complete.
5. **Philosophy regressions.** Reviewers keep re-adding paternalism. **De-risk:** 0.8/3.4/3.5 explicitly use light-friction/annotation, never typed-phrase gates or blocking cages. Guardrails stay adjustable-with-override.

---

## 4. What you should do next — step by step

1. **Ship Phase 0.1 (the P0) alone, today.** It's the app's most safety-critical visual signal and it's *wrong in the default light theme*. Rebuild `executionBanner()` in `app/dashboard-client.tsx:443,459` on `--down`/`--up` tokens, verify in **light mode**, run the gate, `land.sh`. One tight PR.
2. **Batch the rest of Phase 0** (0.2–0.8) into 2–3 small PRs grouped by surface (nav/palette; scan↔watchlist flow; dashboard color cleanup; login/approvals). All are isolated and low-risk.
3. **Make the two Phase-1 brand decisions** — they're *yours*, and they unblock everything downstream: **(a)** one Socratic Trade accent hue (green vs teal, finding 1.1) and **(b)** adopt `pos/neg` as the single tone vocabulary (1.2). Record both in `docs/design/visual-system.md` as you go.
4. **Land tone unification (1.2) as its own PR** and let `tsc` drive you to every call site. This is the keystone that de-duplicates both the app's *and* the Kit's two Chip/Card/Field families.
5. **Do your first Kit round-trip on one primitive** — pick `Switch` + `disabled` (2.1): iterate the state grid in the Kit canvas, port to `app/ui/primitives.tsx`, verify, re-sync app→Kit, run the §1b hash check. This proves the workflow end-to-end before you rely on it for the harder unification work — and confirms the loop, not the Kit's isolated polish, is where the value is.

---

# UI Kit Analysis

## Fidelity & provenance

The UI Kit is confirmed to be a faithful, hash-tied mirror of two genuinely distinct, real design systems already living in the app (app/ui/primitives.tsx: Tailwind-utility-over-CSS-variable-tokens, clsx+tailwind-merge; app/console/ui/primitives.tsx: bespoke con-* atomic classes over console.css's own --con-* token block, naive class-join). Nothing about the Kit's described shape (12 ui + 18 console components, per-component prompt.md/d.ts/html) contradicts what's on disk — it is documentation and isolation, not redesign. The owner's sense that the Kit looks nicer is very plausible but attributable to presentation context: the Kit shows primitives alone on a neutral canvas with variant grids, while the live app always shows them embedded in dense composite chrome (console.css is 1032 lines; page.tsx files run 400-900+ lines) that the leaf-primitive Kit never has to contend with. Real, durable value: the Kit fills an actual gap in this repo's own documentation — docs/design/visual-system.md (the app's own token doc) covers only the ui system and does not mention the console system's separate --con-* scale at all, so the Kit's single guideline doc, if it truly covers both, is more complete than what the app documents about itself today. Its main limitation is scope: it captures ~30 leaf primitives but none of the ~15 composite pieces (nav chrome, approval cards, drilldowns, tables, modals) that actually constitute the cockpit experience.

**Verdict:** The Kit is a faithful, non-diverged mirror of real app source, not a nicer redesign — its polish is real (as documentation/isolation) but the app-vs-Kit quality gap the owner perceives is illusory, an artifact of neutral-canvas presentation vs. busy live composite screens. Its concrete value is filling a documentation gap (per-component prop contracts/usage, and a rare single reference spanning both token systems) that this repo's own docs currently don't fully cover, not visual improvement. Recommend: keep it as a documentation/iteration surface and drift-check tool, extend its next sync to include composite components, and treat any 'Kit looks better, let's use its style' instinct as a false signal — there is no distinct Kit style to adopt, since it's the same code.

### Assessment
- **Fidelity to app source (structural)** — _strong_. Verified by direct read of app/ui/primitives.tsx (406 lines) and app/console/ui/primitives.tsx (287 lines): the two component families the Kit claims to mirror are real, live, and exactly as described — two disjoint systems, not overlapping variants of one. 'ui' Card = `<div className={cn("rounded-2xl border border-line bg-surface/80 backdrop-blur-sm", ...)}>` (app/ui/primitives.tsx:72-79), Tailwind utility classes over CSS-var tokens, uses clsx+tailwind-merge (`cn`, app/ui/cn.ts:1-6, which resolves Tailwind class conflicts). 'console' Card = `<section className={cx("con-card", className)}>` (app/console/ui/primitives.tsx:10-34), a single bespoke atomic class resolved in app/console/console.css (1032 lines, own `--con-*` token block, e.g. console.css:32-81), using a naive `cx` (app/console/lib/format.ts:6-8, `filter(Boolean).join(' ')`, no conflict resolution — appropriate given con-* isn't Tailwind utilities). This is a real, non-cosmetic architectural fork (different theming mechanism, different class-merge semantics, different tone vocabularies: Tone={neutral,up,down,warn,info,accent} vs ChipTone={muted,accent,pos,neg,warn,none,paper,live}), and the Kit's claimed 12 ui + 18 console = 30 components lines up with what's actually exported from these two files (Button/IconButton/Card/PanelHeader/Chip/Dot/Switch/Segmented/Tabs/Field/StatTile/EmptyState = 12 in app/ui/primitives.tsx; Card/Btn/Chip/LiveTag/Dot/Meter/Stat/Field/TextInput/NumInput/RawNumInput/Select/TextArea/Toggle/Empty/Dash/signTone+SignedText ≈ 18 in console). Nothing in the Kit's described shape contradicts what's on disk.
- **Provenance / sync integrity** — _adequate_. Cannot independently verify the actual sourceHashes/renderHashes inside _ds_sync.json (no network access to claude.ai/design from this environment) or confirm the sync ran recently/cleanly — this is the one claim taken on the task's word, not independently re-derived. What CAN be verified: the app has zero self-knowledge of the Kit's existence. Grepped every docs/reviews/*.md (18 files, including the two most recent 2026-07-04 expert/composite design reviews) for 'kit', 'claude.ai/design', 'design-sync', '_ds_bundle', 'SocraticTradeDS' — zero hits anywhere. The app's own token doc, docs/design/visual-system.md (created 2026-07-01, 168 lines), documents ONLY the app/ui system (globals.css + app/ui/primitives.tsx) and explicitly does not mention app/console/console.css's completely separate --con-* token scale (console.css:32-81, e.g. --con-faint/--con-accent/--con-pos/--con-neg/--con-fs-xs..xxl) at all. So the Kit's 'ONE guideline doc covering both systems' is actually MORE complete than the app's own internal documentation, which only covers half. This means: if the Kit's guideline doc genuinely merges both scales into one reference, it is currently the single best consolidated description of the app's visual language — but that also means there is no app-side doc to diff it against for drift-checking, so 'is it still faithful' is unverifiable from this repo alone and depends entirely on whatever /design-sync last did.
- **Perceived vs actual polish** — _strong_. The owner's belief that the Kit 'looks nicer' is very plausible and almost certainly an artifact of presentation context, not superior code/design. Evidence: app/console/console.css alone is 1032 lines of dense bespoke CSS reached only through composite pages (console/page.tsx 865 lines, console/strategy 794 lines, console/components/chrome.tsx 778 lines) — the primitives are always seen embedded in nav chrome, alert centers, approval cards, tables, drilldowns, never in isolation. The Kit, per the task's provided facts, presents each of the 30 primitives alone on a neutral canvas with per-component variant grids (*.html) and no chrome/nav/table/modal noise around them — the Kit structurally CANNOT look worse because it never shows the primitives under real information density. Also the Kit is documentation-shaped (prompt.md usage notes + d.ts prop contracts) which reads as 'considered' even though the same information is implicit and undocumented in the live app. Since _ds_sync.json (per given facts) ties every export to the literal app source hash, there is by construction no independent visual design applied in the Kit — 'nicer' is a framing/isolation effect, not a fidelity or quality delta.
- **Value the Kit adds beyond app source** — _adequate_. Real, concrete value: (1) per-component prop contracts (*.d.ts) and usage docs (*.prompt.md) that don't exist anywhere in-repo today — grepped for JSDoc-style prop docs on primitives.tsx exports and found only scattered inline comments (e.g. the StatTile `title` prop doc at app/ui/primitives.tsx:376-382, the RawNumInput doc-comment at app/console/ui/primitives.tsx:172-182) rather than systematic per-component docs; (2) an isolated iteration surface for design work that doesn't require running the Next.js app; (3) crucially, the Kit's ONE guideline doc appears to be the only place the con-* and ui-* token scales are described together — filling a real gap since docs/design/visual-system.md (this repo) only documents half the system. Limits, confirmed from the task's own facts and consistent with what these two primitives files actually contain: it is leaf-primitives only (Button/Card/Chip/etc.) — none of the composite surfaces that make up the actual day-to-day cockpit experience (chrome.tsx 778 lines, approval-card.tsx 633 lines, drilldown-sections.tsx 641 lines, symbol-drawer/sheet/toast/command-palette) are represented, so it documents ~30 building blocks but not the ~15 composite components that assemble them into real screens.

### Gaps (missing composites, ranked)
1. The Kit's guideline doc content (guidelines/docs/design/visual-system.md) could not be fetched/read in this environment — its actual coverage of the con-* scale (vs. this repo's docs/design/visual-system.md, which explicitly omits console.css) is inferred from the task brief, not independently confirmed line-by-line.
2. No way to check _ds_sync.json's actual hash values or last-sync timestamp from this sandbox — provenance freshness (has it drifted since the last app change, e.g. the 2026-07-01 elevation/blur/icon-scale consolidation in docs/design/visual-system.md) is unverified.
3. The Kit reportedly documents 18 console components, but app/console/ui/primitives.tsx exports closer to ~17 distinct names plus two helper functions (signTone, SignedText) that may or may not both count toward the 18 — worth a precise recount against the actual export list if exact parity matters.
4. No visibility into whether app/console/ui/primitives.tsx or app/ui/primitives.tsx has changed since whatever commit the Kit's bundle was generated from; git blame/log on these two files against the Kit's stated sync date would confirm currency but the Kit's sync date isn't available here.

### Opportunities
- Point the Kit's guideline doc (or a new section of it) at BOTH docs/design/visual-system.md (ui system) and the --con-* block in app/console/console.css so the Kit becomes the canonical unified reference — then backfill a matching unified doc into this repo (or a cross-link) so the app's own docs stop being split, since right now this repo's own visual-system.md doesn't even describe its own console token scale.
- Because the two systems are structurally confirmed distinct (different class-merge helpers, different tone enums, different theming triggers — .dark ancestor vs data-theme="dark"), any future unification effort should be scoped as a real migration project, not a quick primitive swap; the Kit's faithful-mirror nature means it will need conscious redesign work (not just re-sync) if the goal becomes converging the two systems rather than documenting both as-is.
- Add the 15 composite components (chrome, approval-card, drilldown-sections, sheet/overlays, toast, command-palette, alert-center, policy-form) to the Kit's next sync pass — these are what actually drive the 'is the live app polished' perception, and are exactly what's currently missing from the leaf-primitive-only Kit.
- Use the Kit's neutral-canvas variant grids as a lightweight visual regression baseline: since they're hash-tied to source, a quick script comparing the Kit's last sync hash to current app/ui and app/console/ui file hashes would give a cheap 'has the Kit drifted' check without needing to open claude.ai at all.

## Quality & strategic role (2nd track, distilled)

- **Documentation — strong.** All 30 components ship matched `.jsx`/`.d.ts`/`.prompt.md`/`.html`
  variant grids; `.d.ts` mirror the real TS unions, `.prompt.md` teach trading vocabulary
  (`Approve`/`Liquidate`), README documents the two-system split and the `.console-root` gotcha.
- **Token completeness — adequate.** 250 custom props, but most are compiled Tailwind machinery;
  the meaningful semantic layer's *rationale* (AA notes, elevation/icon consolidation) lives only in
  the app's `docs/design/visual-system.md`, which the Kit doesn't carry.
- **Coverage — weak by design.** Leaf primitives only. The composites that define the app's feel are
  absent: `con-table` (used in 6+ pages — highest-value add), `approval-card` (633 lines, money-path),
  the modal/sheet family (`overlays`/`sheet`/`ConfirmationModal` — best unification test), `policy-form`,
  chrome/nav/shell, drilldown, charts, command palette, alert-center.
- **Fitness as unification home — promising but unproven.** It already loads both systems side-by-side
  (the hard prerequisite), but there's no unified-token proposal artifact, no composite examples to
  validate a merge against, and the `/design-sync` round-trip isn't demonstrated in-repo.
- **Highest-leverage next move:** add `con-table` and the three-way modal/sheet family first — together
  high-reuse and the best available test of whether `ui` and `console` can merge without losing function.

---

# All 55 verified findings

### P0 — Critical / blocking

**[P0] Money-reality safety banner is hardcoded to dark-only Tailwind colors, breaking in light mode and bypassing the --up/--down/--warn tokens**  
`Visual design & professional polish` · area: Visual design / color system integrity · effort: S  
- **Problem:** The live-vs-paper execution banner -- the most safety-critical status signal in the app -- is built from fixed dark-palette Tailwind classes instead of the semantic --up/--down tokens the rest of the UI uses. In light mode a LIVE-broker banner renders near-black text-red-200 on near-black bg-red-950/70 sitting on a light page, exactly where the color must read instantly and correctly. Every other status surface (Chip, StatTile, Dot) reads --up/--down and repaints per theme; this banner does not.
- **Fix:** Rebuild executionBanner()'s className using bg-down/15 text-down border-down/40 (live) and bg-up/15 text-up border-up/40 (paper) so it inherits the same light/dark-aware token pipeline as the rest of the UI.
- **Files:** `app/dashboard-client.tsx`


### P1 — Significant, core-surface

**[P1] AlertCenter filter buttons expose active state by border/background color only, with no aria-pressed**  
`Accessibility (WCAG)` · area: Color-only signaling / state exposed to assistive tech (WCAG 1.4.1, 4.1.2) · effort: S  
- **Problem:** The four AlertCenter filter `<button>`s (alert-center.tsx:158-173) toggle selected state purely via a class ternary (`filter === item.id ? 'border-[--con-accent] bg-[--con-accent-soft]' : 'border-[--con-line] ...'`) with no `aria-pressed` — a screen-reader user tabbing the four buttons cannot tell which filter is active, and a forced-colors/high-contrast user loses the only distinguishing signal. The ScopeSelector account rows (chrome.tsx:134-150) also encode active-ness by border color on a non-focusable `<div>`, but that case is mitigated: an `active` Chip with visible text renders in the row (chrome.tsx:150).
- **Fix:** Add `aria-pressed={filter === item.id}` to the four AlertCenter filter buttons (button role + aria-pressed is the correct toggle semantic here, not tablist). For ScopeSelector rows, the visible 'active' Chip text already mitigates; optionally add `aria-current="true"` to the active row wrapper for completeness — lower priority.
- **Files:** `app/console/components/alert-center.tsx · app/console/components/chrome.tsx`

**[P1] Console design system has no touch-target-size floor; icon/scope/user trigger buttons are ~32px, under the 44px WCAG 2.5.8 target**  
`Accessibility (WCAG)` · area: Touch target size (WCAG 2.5.8 Target Size Minimum) · effort: S  
- **Problem:** The console system's base button (.con-btn, console.css:370-384) is defined with padding-only (`padding: 7px 14px`) and no min-height/min-width; grep of console.css for min-height/min-width/44px returns only layout rules (96,244,286,718,797,825), never an interactive touch-target floor. UserMenu's trigger is `h-8 w-8` = 32x32px (chrome.tsx:674); ScopeSelector (chrome.tsx:100) and StateChip (chrome.tsx:191) triggers are `px-3 py-1.5` with no height floor and no mobile scale-up. The 'ui' system by contrast bakes in a mobile floor: IconButton uses `max-sm:h-11 max-sm:w-11 touch-manipulation` (primitives.tsx:63) and buttonSizes use `max-sm:min-h-11` (primitives.tsx:33-34). The console cockpit — the surface used on every /console/* page — has no equivalent.
- **Fix:** Add a `min-height`/`min-width` floor (e.g. 44px on touch viewports via a `@media (pointer: coarse)` or `max-sm` rule) to `.con-btn` and to the compact chrome triggers (UserMenu 32px button, ScopeSelector, StateChip), mirroring the `max-sm:min-h-11` pattern already proven in app/ui/primitives.tsx.
- **Files:** `app/console/components/chrome.tsx · app/console/console.css · app/ui/primitives.tsx`

**[P1] Brand accent color diverges between the two systems (green vs teal) with no shared source of truth**  
`Design-system architecture & tokens` · area: tokens · effort: S  
- **Problem:** The 'ui' system's --accent is green (#0e9f6e light / #10b981 dark) while the console system's --con-accent is teal/cyan (#12616f light / #58c7d3 dark). These are two different brand hues for the identical semantic role (primary interactive/brand accent) in the same product, with zero cross-reference between the two token files.
- **Fix:** Pick one accent hue as the Socratic Trade brand color and either (a) have console.css derive --con-accent from a single shared --brand-accent, or (b) if the console-vs-marketing divergence is intentional, document it explicitly in docs/design/visual-system.md (which currently only covers the ui green). Right now it reads as drift.
- **Files:** `app/globals.css · app/console/console.css`

**[P1] Console has no Segmented/Tabs primitive, so segmented-control UI is hand-rolled per page instead of reused** _(severity adjusted on verification)_  
`Design-system architecture & tokens` · area: primitives · effort: S  
- **Problem:** app/ui/primitives.tsx exports reusable Segmented and Tabs; app/console/ui/primitives.tsx has neither. policy-form.tsx hand-builds a segmented control inline with raw utility classes and role="group", re-deriving a solved pattern.
- **Fix:** Severity adjusted P1->P2: this is a reuse/DRY gap, not a P1 defect — policy-form's hand-rolled control works and is keyboard-operable via normal buttons; the missing accessible-tab semantics matter only for the true tab surfaces, of which console has none flagged. Port a console-themed Segmented (and Tabs if a real tab surface emerges) into app/console/ui/primitives.tsx so policy-form and future mode-switches reuse one component. Don't oversell the a11y angle: the honest gap is 'no reusable primitive', plus 'no accessible Tabs primitive exists console-side' for any future tabbed surface.
- **Files:** `app/console/ui/primitives.tsx · app/console/components/policy-form.tsx · app/ui/primitives.tsx`

**[P1] Dark-mode activation mechanism is fully duplicated and can desync (.dark class vs data-theme attribute)** _(severity adjusted on verification)_  
`Design-system architecture & tokens` · area: tokens · effort: M  
- **Problem:** The 'ui' system flips theme via a `.dark` class on <html> persisted under localStorage key `theme`; the console system flips via `data-theme` on `.console-root` persisted under a separate key `console:theme` with no synchronization. Setting one dark and the other light is possible with no reconciliation. Additionally the console dark token block is hand-duplicated (explicit `[data-theme]` + `@media prefers-color-scheme`) with a 'KEEP THE TWO BLOCKS IDENTICAL' comment.
- **Fix:** Severity adjusted P1->P2: this is a real consistency seam but not a broken/core-task-blocking defect — each system renders correctly in isolation, and a desynced marketing-vs-console theme is a mild polish issue, not a P1 UX failure (many apps intentionally theme a cockpit separately). Fix: share one resolved light/dark source of truth (console can still apply via data-theme, ui via .dark) so one toggle switches both; and generate the media-query dark block from the explicit block via build step to kill the hand-duplication hazard. Note console theme is tri-state ('system'), so reconciliation must map that, not just a boolean.
- **Files:** `app/globals.css · app/ui/theme.tsx · app/console/lib/useConsoleTheme.ts · app/console/console.css`

**[P1] PWA install locks users into the reduced /mobile surface with no path to the full console**  
`Responsive, mobile & PWA` · area: PWA / navigation · effort: S  
- **Problem:** The manifest's start_url is "/mobile" (app/manifest.ts:8), so an installed PWA always launches into the stripped phone control surface. app/mobile/mobile-pwa-client.tsx contains ZERO links to /console — the only outbound navigation in the whole 658-line file is window.location.href = "/logout" (line 208). A phone user who installs the app can never reach Guardrails/Mandates, Framework, Results, Macro, drilldowns, or full Watchlist alerts — they are confined to run controls, approvals, watchlist, alerts, positions, and the command log. Manifest scope is "/" (line 9), so it is a soft trap (a typed URL escapes it) rather than a hard lock, but there is no in-UI affordance.
- **Fix:** Add an explicit "Open full console" link in the /mobile header (fastest fix, preserves the intentional lite surface), OR repoint start_url at /console and treat the responsive console as the installed target per the codebase's console-is-the-cockpit philosophy. Note: the finding's evidence cited /logout at line 703; the actual location is line 208 (file is 658 lines) — the substantive claim is unaffected.
- **Files:** `app/manifest.ts · app/mobile/mobile-pwa-client.tsx · app/mobile/page.tsx`

**[P1] Table row actions (Cancel / Replace at market) render well under the 44px touch-target minimum** _(severity adjusted on verification)_  
`Responsive, mobile & PWA` · area: Touch targets · effort: S  
- **Problem:** .con-btn-sm is padding: 4px 10px with font-size: var(--con-fs-xs) (console.css:435-438). --con-fs-xs is 11px (console.css:75), not the 12.5px the finding claimed. Rendered height is ~11px x 1.5 line-height + 8px padding + ~2px border ~= 26px. OrdersPage's OpenOrderTr uses size="sm" for both "Replace at market" and "Cancel" (orders/page.tsx:470,474) inside a row-action cell — the only way to cancel/replace a stale or working order from a phone. ~26px is under Apple HIG / WCAG 2.5.5 (AAA, 44px) and only marginally meets WCAG 2.5.8 (AA, 24x24 CSS px) on height; these are among the smallest tap targets in the console, on the exact screen a user reacts to a stale/rejected order from their phone.
- **Fix:** Corrected the measured numbers (font 11px, rendered ~26px — not 12.5px / 20-24px). Fix stands: add a mobile-only min-height (~40px) on row-action buttons below the sm/md breakpoint, or move the row actions into a per-row overflow menu / bottom sheet on narrow viewports. Kept P1 — small tap targets on the urgent order-management surface are a real touch-usability gap, though note it is above the strict AA 24px floor, so it is a professionalism issue rather than an a11y violation.
- **Files:** `app/console/console.css · app/console/orders/page.tsx`

**[P1] Command palette component exists but is never wired into the console — the operator cockpit has zero keyboard-driven navigation**  
`UX, information architecture & flows` · area: IA / discoverability · effort: M  
- **Problem:** `CommandPalette` (app/ui/command-palette.tsx) is a fully built keyboard-navigable fuzzy command menu, but `grep -rln CommandPalette app/` returns only the component itself and app/dashboard-client.tsx (the marketing/legacy dashboard). No file under app/console imports it, and a grep for `metaKey`/`ctrlKey`/`Cmd+K` across app/console/ returns nothing — the console (13 destinations plus a mobile 'More' overflow) has no Cmd+K or quick-jump; every navigation is a rail-click or tab-tap.
- **Fix:** Wire a console-scoped command palette into ShellFrame with a Cmd+K/Ctrl+K binding, seeded with the 13 DESTINATIONS from nav.tsx plus common actions (Run once, Stop, switch account). Highest-leverage nav improvement given the destination count already present.
- **Files:** `app/ui/command-palette.tsx · app/dashboard-client.tsx · app/console/components/shell.tsx`

**[P1] Decision-trace back link always returns to the dashboard, discarding the actual navigation origin**  
`UX, information architecture & flows` · area: IA / navigation · effort: S  
- **Problem:** The only back-navigation on /console/decisions/[id] is a hardcoded `<Link href="/console">` labeled 'Back to console', appearing twice (error state line 118-120, ready state line 134-136). Decision detail pages are reached from Activity/Journal, Approvals, and framework proposal links, but the back link always drops the user at the top-level dashboard rather than the list they drilled in from. No `?from=` param, `router.back()`, or `document.referrer` handling exists anywhere in the file (verified: only useParams is imported from next/navigation, line 5).
- **Fix:** Use `router.back()` when in-app history exists (guarded by `window.history.length > 1`), falling back to a sensible default (Activity/Journal, the primary entry) otherwise; or pass the originating route as a `?from=` query param when linking into the page.
- **Files:** `app/console/decisions/[id]/page.tsx`

**[P1] Scan table has no 'add to watchlist' action, forcing a manual retype round-trip between two adjacent pipeline screens**  
`UX, information architecture & flows` · area: task flow · effort: S  
- **Problem:** The nav frames Scan ('Evidence': screened/scored symbols) and Watchlist ('symbols the agent monitors') as a discovery→monitoring pipeline. But scan-table.tsx has no per-row action column — its only interactive elements are sortable header buttons and the Columns chooser (lines 134-285); each row (lines 260-279) renders only the sortable data cells. To watch a scanned symbol the user must read the ticker, navigate to /console/watchlist, and retype it into the add-symbol TextInput (watchlist addSymbol only accepts free-typed `newSymbol` state, lines 90-110; no `?add=`/`?symbol=` deep-link handling exists).
- **Fix:** Add a small 'Watch' icon-button per scan row that POSTs to /api/watchlist directly, or at minimum deep-links to /console/watchlist?add=SYMBOL and prefills `newSymbol` from a query param.
- **Files:** `app/console/scan/scan-table.tsx · app/console/watchlist/page.tsx`

**[P1] A fourth, hand-rolled design system exists at /design/socratic-trade with its own hardcoded hex palette that matches neither app/ui nor console tokens**  
`Visual design & professional polish` · area: Design system fragmentation · effort: M  
- **Problem:** This in-app product-overview route defines a third, separate palette in a CSS module with raw hex (#08725f accent green, #172027 text, #52606d muted, #f5f7fa->#e8eef3 page gradient) that derives from no shared token file. Its accent green #08725f is close to but distinct from --accent #0e9f6e and --con-accent, so a visitor bouncing between /console, /welcome and /design/socratic-trade sees three subtly different brand greens with no shared source of truth.
- **Fix:** Either delete this route (welcome/how-it-works already cover the marketing ground with real tokens) or rebuild it on app/ui/primitives.tsx and the --accent/--bg/--fg token set so it stops being an undocumented fourth palette. Severity is borderline P2 since it is one peripheral showcase route, not a core operator surface.
- **Files:** `app/design/socratic-trade/socratic-trade.module.css · app/design/socratic-trade/page.tsx`

**[P1] Account capability badges use a nine-color, non-semantic rainbow that ignores the token palette entirely**  
`Visual design & professional polish` · area: Color usage / professionalism · effort: S  
- **Problem:** The connected-accounts panel colors each capability badge with a different raw Tailwind hue picked for variety not meaning (blue IRA, yellow Margin, orange Short, purple Options, cyan Crypto, pink Futures), none mapping to the app's semantic tones (up/down/warn/info/accent) and none defined in globals.css so they can't be retuned for contrast/theme centrally.
- **Fix:** Collapse to the existing 5-tone system: one neutral/info chip style (--info) for the informational capability tags (IRA/margin/options/crypto/futures), --warn only for OAuth-needed, --up/--down reserved for gain/loss. If capability types need visual distinction, vary the icon under one shared Chip style, not seven hues.
- **Files:** `app/dashboard-client.tsx`


### P2 — Polish

**[P2] ConfirmationModal's typed-phrase live-trade gate gives no non-visual (aria-live) signal that the phrase matched and Confirm is enabled**  
`Accessibility (WCAG)` · area: Form validation announcement (WCAG 4.1.3 Status Messages) · effort: S  
- **Problem:** On a phrase match, the only feedback is a color-dependent green Check icon inside the input (ConfirmationModal.tsx:218-222) and the Confirm button silently un-disabling. There is no aria-live/role=status announcing the match, and the Check icon lacks aria-hidden and any accessible text, so a screen-reader user gets no non-visual signal that the highest-stakes control (placing a real live trade) is now actionable — they must repeatedly poll the Confirm button's disabled state. The static `aria-describedby="confirmation-hint"` (line 215/224) only says 'Press Enter to confirm', not whether the phrase currently matches. Context: this modal renders on the legacy /old dashboard (app/dashboard-client.tsx:2202), not the primary console, which modestly limits reach but not stakes.
- **Fix:** Add a visually-hidden `aria-live="polite"` status element that announces e.g. 'Phrase matches — Confirm Trade is now enabled' when phraseMatches flips true, and mark the decorative Check icon `aria-hidden="true"`.
- **Files:** `app/components/ConfirmationModal.tsx`

**[P2] Console Sheet dialog has no accessible name (missing aria-label/aria-labelledby), unlike the 'ui' Modal**  
`Accessibility (WCAG)` · area: Focus management / accessible name in dialogs (WCAG 4.1.2) · effort: S  
- **Problem:** Sheet (used by every /console/* dialog — ScopeSelector, ControlSheet, UserMenu, control sheets) sets `role="dialog" aria-modal="true" tabIndex={-1}` (sheet.tsx:122-127) but never sets `aria-label` or `aria-labelledby`, despite rendering its `title` prop as `<h2>` two lines later (sheet.tsx:130). The dialog naming algorithm does not auto-derive a name from an adjacent heading, so the dialog opens with no reliable accessible name. The 'ui' Modal sets `aria-label={title}` (overlays.tsx:107) and SlideOver `aria-label={ariaLabel ?? title}` (overlays.tsx:197).
- **Fix:** Give the header `<h2>` a `useId()`-derived `id` and add `aria-labelledby={headingId}` to the dialog div in Sheet, matching app/ui/overlays.tsx's Modal/SlideOver.
- **Files:** `app/console/ui/sheet.tsx`

**[P2] Framer Motion overlays (Modal, SlideOver, CommandPalette) in app/ui/ bypass prefers-reduced-motion entirely; visual-system.md overstates coverage** _(severity adjusted on verification)_  
`Accessibility (WCAG)` · area: Motion (WCAG 2.3.3 Animation from Interactions) · effort: M  
- **Problem:** Modal (overlays.tsx:114-117: scale/opacity/y, 0.18s), SlideOver (overlays.tsx:199-202: `x:'100%'`→0 slide, 0.26s), and CommandPalette animate via Framer Motion inline transforms driven by JS, not CSS animation/transition — so neither reduced-motion CSS rule reaches them. globals.css:272-284 only zeroes `body::before/::after`, `.skeleton::after`, `.boot-strip-glow`, `.animate-pulse-fast`. A user with prefers-reduced-motion:reduce still gets full slide/scale/fade on every ui modal, sheet, and command palette. visual-system.md:153 overstates the coverage. NOTE (scope correction): the *console* Sheet is CSS-animated and IS covered by console.css:1027-1032 (`.console-root * { transition-duration:0.01ms }`), so this gap is limited to the app/ui/ Framer overlays; the finder correctly scoped to those.
- **Fix:** Gate the Framer `transition` objects behind `useReducedMotion()` (from motion/react) to collapse duration and drop transform deltas, shared across Modal/SlideOver/CommandPalette. Also correct docs/design/visual-system.md:153, which overstates reduced-motion coverage. Severity lowered to P2: the motion is brief, non-looping, interaction-triggered (not the continuous/auto-playing motion 2.3.3 most targets), and the parallel console system is already covered — a real gap, but polish-tier rather than a core-task blocker.
- **Files:** `app/ui/overlays.tsx · app/ui/command-palette.tsx · app/globals.css · app/console/console.css · docs/design/visual-system.md`

**[P2] Console styling is 1032 lines of bespoke CSS with zero Tailwind utility integration, doubling the styling toolchain surface the team must maintain**  
`Design-system architecture & tokens` · area: architecture · effort: L  
- **Problem:** globals.css uses Tailwind v4 @theme inline to generate utilities (bg-surface, text-fg) from semantic tokens, so ui components style with ordinary utilities. console.css hand-writes every component class (.con-card, .con-btn-primary, etc.) with no @theme integration; console components reference these bespoke classes plus raw var(--con-*) in arbitrary-value utilities. The project maintains two styling methodologies, raising the cost of e.g. adding a semantic color.
- **Fix:** Biggest lever if unification is prioritized: migrate console.css component classes onto @theme inline + con-* custom properties (keep the con- prefix and values, just let Tailwind generate utilities) so console components can move to utility classes without a visual change. Given the ~49-file con-* adoption this is an L-effort dedicated epic, not an incidental fix.
- **Files:** `app/console/console.css · app/globals.css`

**[P2] Primitive parity gaps run both directions — each system is richer in different, uncoordinated places**  
`Design-system architecture & tokens` · area: primitives · effort: M  
- **Problem:** Neither primitives.tsx is a superset of the other. ui has IconButton, PanelHeader, Segmented, Tabs, EmptyState.icon absent from console; console has Meter, LiveTag, RawNumInput, Ago, SignedText, Dash absent from ui. An icon-only button doesn't exist console-side; a numeric input doesn't exist ui-side.
- **Fix:** Build a parity matrix (one row per concept, one column per system); treat each 'only-one-side' cell as a backlog item to port or explicitly mark system-specific with a reason (Meter/LiveTag are legitimately console broker/risk concepts; IconButton and RawNumInput's input-collapse fix are not domain-specific and should exist in both).
- **Files:** `app/ui/primitives.tsx · app/console/ui/primitives.tsx`

**[P2] Same-named primitives (Card, Chip, Dot, Field, Stat) have incompatible prop shapes across the two systems, so muscle memory misfires**  
`Design-system architecture & tokens` · area: primitives · effort: S  
- **Problem:** Five shared component names have divergent APIs: Field.label is string in ui vs ReactNode in console; Chip.tone is a 6-value union (neutral|up|down|warn|info|accent) in ui vs an 8-value differently-named union (muted|accent|pos|neg|warn|none|paper|live) in console (up/down -> pos/neg); ui StatTile takes icon and wraps in Card, console Stat takes neither and renders a bare div.
- **Fix:** Standardize on one tone vocabulary as the first unification seam. pos/neg reads better than up/down for a trading app (up/down collides with price-direction language) — adopt it in both systems even before any larger merge so the semantic naming is at least consistent.
- **Files:** `app/ui/primitives.tsx · app/console/ui/primitives.tsx`

**[P2] Two of the three duplicated files have drifted logic, not just theming — symbol-drilldown.tsx and ticker-logo.tsx are different implementations, not ports**  
`Design-system architecture & tokens` · area: duplication · effort: S  
- **Problem:** The console variants are documented forks, not shared code, and the theme-detection logic has diverged. app/ui/ticker-logo.tsx watches `.dark` via MutationObserver on documentElement; app/console/ui/ticker-logo.tsx watches the closest .console-root ancestor's data-theme AND a matchMedia listener. symbol-drilldown likewise: console pulls from useConsoleData()/drilldown-data/drilldown-sections vs ui's direct prop-based deriveMetrics. Fixes in one won't propagate.
- **Fix:** Rename one of each pair (e.g. console-symbol-drilldown.tsx) so identical filenames stop implying one-component-two-skins and stop misdirecting filename searches to the wrong file. Cheaper than unifying the logic and removes the most common cross-file trap.
- **Files:** `app/ui/symbol-drilldown.tsx · app/console/ui/symbol-drilldown.tsx · app/ui/ticker-logo.tsx · app/console/ui/ticker-logo.tsx`

**[P2] Type-scale and radius scales are independently defined with different step counts and no mapping between them**  
`Design-system architecture & tokens` · area: tokens · effort: M  
- **Problem:** ui defines only two radius tokens (--radius-xl:16px, --radius-2xl:20px) and otherwise uses Tailwind's default radius scale directly (rounded-lg/rounded-2xl) with no semantic card-vs-control radius token; console defines two semantic radius tokens (--con-radius:12px, --con-radius-sm:8px) used by role. ui has no named type-scale (uses text-* utilities); console defines a 7-step scale (--con-fs-xs..--con-fs-xxl). Values don't line up (ui card via rounded-2xl=16px vs con-card 12px), so moving a component between systems silently changes corner radius and type scale.
- **Fix:** If unification is pursued, start with radius (only 2 values each side): agree on one card-corner and one control-corner value referenced by both systems. Type scale is a bigger lift since ui has no named scale to migrate into.
- **Files:** `app/globals.css · app/console/console.css`

**[P2] Every console page re-derives a !snapshot guard the shell already resolved, forcing repeated dead defensive code** _(severity adjusted on verification)_  
`Frontend engineering quality` · area: reuse / component API design · effort: S  
- **Problem:** ShellFrame (shell.tsx:77) returns an error card before children ever mount when !snapshot, so every page rendered as children is guaranteed a non-null snapshot. But useConsoleData() types snapshot as DashboardSnapshot | null (useConsoleData.tsx:36), forcing every page to re-prove the invariant. Confirmed 11 literal 'if (!snapshot) return null' sites: page.tsx:36, activity:31, scan:51, macro:33, orders:131, guardrails:318, settings:257/362/533/601, brokers:119.
- **Fix:** Add a narrower hook/context (e.g. useConsoleSnapshot(): DashboardSnapshot) that ShellFrame seeds with the committed non-null value, so TypeScript proves the invariant for top-level pages. Scope caveat: several guards live in NESTED sub-components (settings.tsx has 4, guardrails:69 also checks !reality, settings:643 checks !snapshot?.currentUser) that render conditionally or read sub-fields, so not all 11 collapse trivially — a shell-seeded context cleanly removes the ~7 top-of-page ones; nested ones need per-component judgment.
- **Files:** `app/console/components/shell.tsx · app/console/page.tsx · app/console/activity/page.tsx · app/console/scan/page.tsx · app/console/macro/page.tsx · app/console/orders/page.tsx · app/console/guardrails/page.tsx · app/console/settings/page.tsx · app/console/settings/brokers.tsx · app/console/lib/useConsoleData.tsx`

**[P2] app/ui and app/console/ui are fully disjoint primitive sets with near-identical concepts and divergent APIs**  
`Frontend engineering quality` · area: component API design & reuse · effort: L  
- **Problem:** Both implement Card, Chip, Dot, Field, Switch/Toggle, Stat as separate components with incompatible props: app/ui Field takes label: string (primitives.tsx:277) vs console Field label: ReactNode (primitives.tsx:152); app/ui Switch has {checked,onChange,label} with NO disabled (152-160) vs console Toggle which adds disabled (230-236); app/ui Chip tones neutral|up|down|warn|info|accent (109) vs console Chip tones muted|accent|pos|neg|warn|none|paper|live (67) — same semantic-status concept, incompatible vocabularies (up/down vs pos/neg).
- **Fix:** Full merge is out of scope (console header explicitly says 'Own design system — no imports from app/ui/*'). At minimum extract a shared headless Tone vocabulary that both token layers map to, and track as a design-system-unification backlog item. Note this maps directly onto the Kit-adoption angle: the exported Kit mirrors BOTH systems, so a unified tone vocabulary would also de-duplicate the Kit's two Chip/Card/Field families.
- **Files:** `app/ui/primitives.tsx · app/console/ui/primitives.tsx`

**[P2] console/page.tsx and console/strategy/page.tsx are 865/794-line monoliths mixing data derivation, sub-components, and page composition** _(severity adjusted on verification)_  
`Frontend engineering quality` · area: maintainability · effort: M  
- **Problem:** page.tsx (865 lines, confirmed) defines ~20 inline private helpers/components under one 'use client': MarkToMarketCard(307), RiskUtilizationCard(360), deriveThesisHeadline(427), deriveThesisBody(438), deriveActionRows(460), deriveEvidenceRows(511), deriveDissentRows(586), deriveFrameworkRows(619), DecisionRow(662), EvidenceCard(686), CoachNoteForm(724), FrameworkProposalList(772), etc. lib/derive.ts already exists and is imported (page.tsx:25) for the shared derive helpers, so the extraction pattern is established but these page-specific ones weren't moved. strategy/page.tsx (794 lines) is similar.
- **Fix:** Move pure page-specific derive* functions into lib/derive.ts (already the home for deriveReality/deriveSpend/etc.) so they are unit-testable, and extract presentational sub-components (DecisionRow, EvidenceCard, MarkToMarketCard, RiskUtilizationCard) into components/. Drop the RSC/server-component angle: the console is a live SSE/poll cockpit with interactive state throughout, so 'get no RSC benefit' is not a real defect here — the maintainability/testability split is the valid core.
- **Files:** `app/console/page.tsx · app/console/strategy/page.tsx · app/console/lib/derive.ts`

**[P2] FreshnessStrip renders behind the fixed mobile tab bar — partially covered on phones** _(severity adjusted on verification)_  
`Responsive, mobile & PWA` · area: Console layout / mobile chrome · effort: S  
- **Problem:** ShellFrame renders <FreshnessStrip/> (shell.tsx:119) as a normal-flow div (chrome.tsx:753 — no fixed/sticky) immediately before <MobileTabBar/> (shell.tsx:120), whose <nav> is fixed inset-x-0 bottom-0 z-50 (nav.tsx:145) with ~58-64px height. The <main> above has pb-24 but the FreshnessStrip sits OUTSIDE <main>, so nothing reserves space for the fixed bar. On a phone the strip lands at the very end of scrollable content directly under the fixed tab bar and is visually clipped by it. The strip carries the daily notional-cap meter and "Data as of…" freshness (chrome.tsx:756-768), which live nowhere else, so that context is hard to read on mobile.
- **Fix:** Severity lowered P1->P2: the info is reachable by scrolling to the very bottom and only its lower portion is occluded, not lost. On mobile, surface the daily-spend meter and data-as-of in the sticky top chrome (or the run-state sheet) and give the strip lg-only visibility, so the key trading context is not clipped by the fixed tab bar.
- **Files:** `app/console/components/shell.tsx · app/console/components/nav.tsx · app/console/components/chrome.tsx`

**[P2] Mobile bottom-tab "More" sheet is a positional slice, burying risk-critical destinations (Mandates, Orders) two taps deep** _(severity adjusted on verification)_  
`Responsive, mobile & PWA` · area: Mobile navigation · effort: S  
- **Problem:** MOBILE_PRIMARY = DESTINATIONS.slice(0, 3) and MOBILE_MORE = DESTINATIONS.slice(3) (nav.tsx:131-132) — a positional slice of the 13-item desktop list, not a mobile-priority ordering. The three primary tabs are Thesis, Decisions, Journal; Guardrails/Mandates and Orders fall into the More sheet (tab bar -> More -> item = 2 taps) vs 1 tap on the desktop rail. Note the finding's sub-claim about "no unread/urgent indication beyond Approvals" is not a defect: Decisions (Approvals) IS index 1, so it sits in the primary bar and its red badge renders there (nav.tsx:163-167) — the urgent queue is already surfaced.
- **Fix:** Corrected the urgent-badge sub-claim (Decisions is already a primary tab with its badge). Remaining valid point: choose the first three deliberately rather than by array index so a from-anywhere single tap covers what a phone user most needs (e.g. keep Thesis + Decisions, swap Journal for Orders or Mandates). This is a design-judgment refinement, so P2 (polish) is correct.
- **Files:** `app/console/components/nav.tsx`

**[P2] Wide data tables (Scan, Orders, Positions) have no mobile-optimized layout — only raw horizontal scroll**  
`Responsive, mobile & PWA` · area: Responsive tables · effort: M  
- **Problem:** All three tables rely purely on <div className="overflow-x-auto"><table className="con-table ..."> (scan-table.tsx:227-228 with min-w-max; positions.tsx:21-22; orders/page.tsx). grep -nE 'sm:hidden|hidden sm:|md:hidden|lg:hidden|hidden lg:' across all three files returns zero matches — no card/condensed variant for phones. Scan's only mobile concession is a sticky first column (STICKY_CELL, scan-table.tsx:39). On a 375px phone the dense desktop table is served verbatim with a bare horizontal swipe and no scroll affordance. The Activity feed already demonstrates a working card-based pattern (con-card rows, activity/page.tsx:404) to mirror.
- **Fix:** Add an lg:hidden card-list rendering (one card per row, label:value pairs) alongside the existing table for Scan, Orders, and Positions, following the Activity feed's card pattern.
- **Files:** `app/console/scan/scan-table.tsx · app/console/orders/page.tsx · app/console/components/positions.tsx`

**[P2] apple-touch-icon and manifest icon are SVG-only, which iOS home-screen install does not reliably render**  
`Responsive, mobile & PWA` · area: PWA / iOS install · effort: S  
- **Problem:** app/layout.tsx:22-25 sets icons: { icon: "/icon.svg", apple: "/icon.svg" } and app/manifest.ts:14-21 declares a single icon entry, /icon.svg (type image/svg+xml). The filesystem confirms only public/icon.svg exists — no PNG anywhere in public/ or app/. iOS Safari "Add to Home Screen" does not render an SVG apple-touch-icon, so the installed home-screen icon falls back to a screenshot/generic mark instead of the Socratic Trade logo, undercutting the PWA/mobile-control pitch.
- **Fix:** Add a 180x180 PNG apple-touch-icon in metadata.icons.apple and 192x192/512x512 PNG entries in the manifest icons array (keep the SVG as an additional entry for browsers that support it).
- **Files:** `app/layout.tsx · app/manifest.ts`

**[P2] Equity chart Y-axis auto-scales to visible min/max with no minimum span, exaggerating tiny moves**  
`Trading-domain data display UX` · area: Equity chart · effort: S  
- **Problem:** vMin/vMax come straight from the visible data (equity-chart.tsx:35-37) with vSpan = vMax-vMin || 1 and no floor relative to vMin, so a near-flat account (e.g. $100,000-$100,050) fills the full chart height and reads as a violent swing. The real % move is in the figcaption (line 69) but the dominant line shape can mislead about volatility.
- **Fix:** Add a minimum vertical span (e.g. never scale tighter than +/-0.5% of vMin) so near-flat curves render visibly flat, or label the actual dollar span of the Y-axis so the reader isn't inferring scale from shape alone.
- **Files:** `app/console/components/equity-chart.tsx`

**[P2] Guardrails page edits caps with no live utilization shown, though the utilization derivation is already built and rendered elsewhere** _(severity adjusted on verification)_  
`Trading-domain data display UX` · area: Risk & guardrail legibility · effort: M  
- **Problem:** The Guardrails page (guardrails/page.tsx) renders each cap (maxOrderNotional/maxDailyNotional/maxDailyOrders at field-defs.ts:16-19, exposure caps at 55-61) as a bare editable value with no 'currently using X%' context — grep confirms zero Meter/utilization references in guardrails/page.tsx. An owner tightening a cap can't see whether the new value already violates a live position/spend.
- **Fix:** Surface a small inline utilization sub-label or Meter next to the relevant Essentials/Exposure rows while editing. deriveRiskUtilization already exists and is trivially reusable.
- **Files:** `app/console/guardrails/page.tsx · app/console/guardrails/field-defs.ts · app/console/lib/derive.ts`

**[P2] Meter bar visually caps at 100% width, hiding a real overage/breach** _(severity adjusted on verification)_  
`Trading-domain data display UX` · area: Risk & guardrail legibility · effort: S  
- **Problem:** Meter (app/console/ui/primitives.tsx:112-121) clamps ratio = Math.min(1, Math.max(0, value/max)) at line 114 and only applies the 'con-meter-neg' tone at ratio>=0.95 (line 115), so an exact at-cap value and an over-cap overage render as an identical full, near-full-red bar. Used for the daily-notional cap in the topbar (chrome.tsx:768) and dashboard capital-posture hero (page.tsx:101). The bar — the fast-scan affordance — cannot distinguish 'at cap' from 'over cap'.
- **Fix:** When value > max, keep the bar at 100% but push it into a distinct breach treatment (striped/hatched fill or an overflow marker) and surface the overage magnitude (e.g. '+$420 over') rather than only the adjacent text. Confirmed: con-meter-neg (console.css:637) is just a solid --con-neg fill, so at-cap and over-cap are pixel-identical today.
- **Files:** `app/console/ui/primitives.tsx · app/console/components/chrome.tsx · app/console/page.tsx`

**[P2] Orders 'Last price' column shows possibly-stale scan price with staleness only in a hover tooltip** _(severity adjusted on verification)_  
`Trading-domain data display UX` · area: Order-ticket clarity / staleness · effort: S  
- **Problem:** The Last-price cell (orders/page.tsx:431-448) renders fmtMoney(scan.price) in plain con-num; the 'from the most recent market scan, can be minutes old, not a live broker quote' caveat lives only in the cell/header title tooltips (lines 222, 435). No persistent age/stale badge on the value itself, on a page whose job is judging whether to replace a resting order at market.
- **Fix:** Add a persistent small age suffix under the Last-price value (mirroring how the limit-gap % is already shown underneath at lines 440-447), e.g. 'scan 6m ago', reusing the Ago/timeAgo already used for order age in this same file.
- **Files:** `app/console/orders/page.tsx`

**[P2] Scan 'Vol' column blends intraday volume and 10-day-average semantics with only a blanket header caveat** _(severity adjusted on verification)_  
`Trading-domain data display UX` · area: Scan columns / provenance · effort: M  
- **Problem:** The volume column header admits 'some providers report the 10-day average after hours' (columns.tsx:164), but the cell renders compactNum.format(q.volume) identically for both meanings and the cell title (fieldTitle('Share volume', q.sources?.volume, q.asOf), line 168) names only the provider, not which semantic applies. A trader scanning for a volume spike can compare today's actual against another row's 10-day average with no way to tell them apart.
- **Fix:** If — and only if — the enrichment layer actually carries a per-row flag for which semantic a value is (this is NOT verified in the finding), thread it into the cell tooltip. Otherwise the honest fix is to tighten the header caveat's wording; do not assume the distinguishing data exists.
- **Files:** `app/console/scan/columns.tsx`

**[P2] Bulk-reject fires immediately with no confirmation, unlike the app's asymmetric-friction pattern for other state changes**  
`UX, information architecture & flows` · area: task flow / consistency · effort: S  
- **Problem:** runBulkReject() (lines 133-158) is invoked directly from the Btn onClick (line 258) and immediately loops `rejectProposal` over every selected proposal with no intermediate confirm. Bulk-approve is at least stakes-gated (runBulkApprove line 104 filters out live proposals via `!approvalIsLive`), but bulk-reject has no gate at all — 'Select visible' followed by 'Reject selected (N)' silently discards every visible idea on one misclick. This is inconsistent with the app's own asymmetric-friction rituals elsewhere (guardrails AutonomyCard's TypedConfirm; live approvals' typed phrase).
- **Fix:** Consistent with product philosophy (no paternalism), do NOT add a typed phrase. Add a lightweight one-click inline confirm ('Reject N proposals? [Confirm]') so a single misclick can't wipe the whole visible queue — matching the app's own light-friction pattern, not adding a scolding gate.
- **Files:** `app/console/approvals/page.tsx`

**[P2] Mobile 'More' overflow buries 10 of 13 destinations in a flat, ungrouped list** _(severity adjusted on verification)_  
`UX, information architecture & flows` · area: IA / mobile navigation · effort: S  
- **Problem:** MOBILE_PRIMARY = DESTINATIONS.slice(0,3) and MOBILE_MORE = DESTINATIONS.slice(3) (lines 131-132); the sheet renders MOBILE_MORE as a single flat `flex flex-col gap-1` list with no section headers or dividers (lines 187-206). Ten destinations — Watchlist, Regime/Macro, Orders, Coach, Framework/Strategy, Mandates/Guardrails, Outcomes/Results, Usage, Settings — sit in one undifferentiated scroll under a generic 'More' label, so finding Guardrails or Settings takes the same linear scan as finding Usage.
- **Fix:** Group MOBILE_MORE into a few labeled clusters in the Sheet (e.g. Monitor / Configure / Review) with small section headers so the list is scannable rather than a linear read. Note: only ~10 items, so this is a scannability polish, not a blocking IA failure.
- **Files:** `app/console/components/nav.tsx`

**[P2] Nav noun collision: 'Decisions' (approvals), 'Journal' (activity), and the /console/decisions/[id] route all name overlapping concepts** _(severity adjusted on verification)_  
`UX, information architecture & flows` · area: microcopy / IA · effort: S  
- **Problem:** The Socratic vocabulary itself (Thesis/Decisions/Journal/Evidence/Regime/Framework/Mandates/Outcomes) is a deliberate, coherent brand system and every destination carries a `desc` tooltip (nav.tsx lines 79-93) — that is an intentional product choice, not a defect. The real, narrower issue is an internal naming collision: the nav labels /console/approvals as 'Decisions' (line 81) while the actual decision-trace detail route is /console/decisions/[id] (a different surface), and /console/activity is labeled 'Journal' (line 82) even though it houses the decision cases those traces belong to. Three overlapping nouns ('Decisions', 'decisions/[id]', 'Journal') map to related-but-distinct concepts, which is genuinely confusing when navigating between the approvals queue and a trace.
- **Fix:** Do NOT rename the branded labels to generic industry terms — the Socratic naming is intentional. Instead resolve only the collision: rename the approvals nav label so it doesn't clash with the /console/decisions/[id] trace route (e.g. keep 'Decisions' for the trace concept and label the approvals queue distinctly, or vice-versa), so 'Decisions' consistently refers to one thing across nav and routes.
- **Files:** `app/console/components/nav.tsx · app/console/decisions/[id]/page.tsx`

**[P2] No manual/discretionary order-entry path anywhere in the console; its absence is undocumented so it reads as a missing feature**  
`UX, information architecture & flows` · area: task flow / completeness · effort: S  
- **Problem:** The Orders page (nav desc: 'Order history and open orders at the broker') offers only Refresh, Replace-at-market, and Cancel per row (OpenOrderTr actions, lines 469-482) plus a read-only finished-orders table. A grep for order-placement affordances ('new order'/'place order'/'placeOrder'/'manual order') in orders/page.tsx returns nothing but a Replace tooltip. Every order originates from an approved strategy proposal; an owner wanting to act on their own idea (open a position the scan missed, or immediately close one) has no console UI path short of the broker's own app. The total absence, with no on-page note, reads as an unfinished feature rather than an intentional agent-only-origination constraint.
- **Fix:** If agent-only origination is intentional, add a discoverable Orders-page note stating orders originate from approved proposals only and there is no manual entry. If manual discretionary trading is in scope, add a minimal order form gated the same way live approvals are (typed phrase for live). Per product philosophy, do not add extra 'are-you-sure-real-money' ceremony beyond the existing live-confirm pattern.
- **Files:** `app/console/orders/page.tsx`

**[P2] Public marketing pages (welcome, how-it-works) are text-only Card grids with no imagery, diagram, or product screenshot**  
`Visual design & professional polish` · area: Marketing / first-impression quality · effort: M  
- **Problem:** Both public pages are pure typography: headline + paragraph + 3-6 text-only Cards per section. For a product whose entire differentiator is a rich, inspectable decision UI, the introductory pages show no screenshot of the console, no diagram of the observe->argue->decide->act->learn loop, and no data visual -- so they read as a generic SaaS template rather than a preview of what is inside.
- **Fix:** Add at least one real visual per page: a static mock of the console's decision-trace card (thesis/evidence/dissent/action) on welcome, and a labeled diagram of the loop on how-it-works, reusing app/ui primitives so it stays on-brand.
- **Files:** `app/welcome/page.tsx · app/how-it-works/page.tsx`

**[P2] Type scale in dashboard-client.tsx has drifted to arbitrary pixel bracket sizes wedged between the Tailwind steps** _(severity adjusted on verification)_  
`Visual design & professional polish` · area: Typography / hierarchy · effort: M  
- **Problem:** Alongside named steps (text-xs/sm), the file uses one-off bracket sizes heavily: text-[10px], text-[11px], text-[12px], text-[13px] all appear many times, including text-[12px] which is byte-identical to text-xs (pure noise) and text-[13px] which sits one step off text-sm. There is no named home for these micro-sizes so they read as sized-by-eye rather than from a scale.
- **Fix:** Define 2-3 named micro-type utilities in globals.css (e.g. .text-2xs for 11px, keep text-xs=12px, text-sm=14px) and sweep the bracket values onto them; delete text-[12px] outright in favor of text-xs. Pair this with the backdrop-blur/elev-* sweep as one 'ad-hoc scale drift' pass in this file.
- **Files:** `app/dashboard-client.tsx`

**[P2] backdrop-blur intensity across the dashboard is per-instance (md/lg/xl) instead of the 3-tier elev-* scale that was built to replace it**  
`Visual design & professional polish` · area: Elevation / glassmorphism consistency · effort: M  
- **Problem:** globals.css defines a disciplined 3-tier elevation scale (.elev-surface=4px, .elev-raised=12px, .elev-overlay=40px) to stop ad-hoc blur choices, but dashboard-client.tsx uses raw backdrop-blur-md/-lg/-xl in 34 places and the elev-* utilities in zero -- the prior audit's remediation was built but never adopted in the file it targeted, leaving glass depth inconsistent across structurally similar surfaces.
- **Fix:** Sweep dashboard-client.tsx's backdrop-blur-* + shadow-[var(--shadow*)] combinations onto .elev-surface/.elev-raised/.elev-overlay so the designed 3-tier system is the one actually in force. Combine with the type-scale sweep as one pass.
- **Files:** `app/dashboard-client.tsx · app/globals.css`


### P3 — Nice-to-have

**[P3] Two Toggle/Switch implementations with different disabled-state and prop support**  
`Design-system architecture & tokens` · area: primitives · effort: S  
- **Problem:** ui's Switch has no disabled prop; console's Toggle supports disabled. Both implement role="switch" but ui positions the thumb via conditional Tailwind classes (translate-x-6/translate-x-1, bg-accent/bg-surface-3) while console uses a single con-toggle class with attribute-selector state styling — the console approach is more maintainable.
- **Fix:** Add disabled support to ui's Switch (cheap, low-risk) and consider migrating it to an attribute-selector CSS pattern like console's con-toggle — less error-prone than inline ternary classes.
- **Files:** `app/ui/primitives.tsx · app/console/ui/primitives.tsx`

**[P3] Zero React.memo across the SSE/poll-driven console; page.tsx re-runs all derive* helpers on every refresh with no useMemo** _(severity adjusted on verification)_  
`Frontend engineering quality` · area: render/perf · effort: M  
- **Problem:** useConsoleData refreshes the shared snapshot every 15s, on visibility change, and on a 200ms-debounced SSE event across 7 types (useConsoleData.tsx:159). Every consuming page re-renders each refresh. page.tsx recomputes deriveEvidenceRows/deriveActionRows/deriveFrameworkRows/deriveThesisHeadline/deriveThesisBody (lines 56-58) with NO useMemo (confirmed 0 useMemo/useCallback in page.tsx), and React.memo is used 0 times anywhere under app/console (confirmed).
- **Fix:** Low priority given small data volumes. Wrap derive* calls in useMemo keyed on relevant snapshot slices and consider React.memo on pure row components (DecisionRow:662, EvidenceCard:686). Correction to the finding: strategy/page.tsx is NOT memo-free — it has 3 useMemo calls, and the console overall has 94 useMemo/useCallback usages — so 'zero memoization across the console' overstates; the accurate claim is React.memo is used nowhere and page.tsx specifically has no memoization.
- **Files:** `app/console/page.tsx · app/console/lib/useConsoleData.tsx · app/console/strategy/page.tsx`

**[P3] app/console/ui/ticker-logo.tsx duplicates app/ui/ticker-logo.tsx's monogram + theme-detection logic as an unenforced fork**  
`Frontend engineering quality` · area: reuse / duplication · effort: S  
- **Problem:** Console version header states it is 'ported from app/ui/ticker-logo.tsx but themed with console tokens' (console:3-8). Both reimplement the same monogram() extraction (app/ui:41-43 vs console:57-59, identical base.slice(0,2)), separate size/font class maps (monogramFontClass vs MONOGRAM_FONT_CLASS), and separate theme hooks (useDarkMode app/ui:8-21 vs useConsoleResolvedTheme console). Any fix to monogram/size logic must be applied twice by hand with nothing enforcing sync.
- **Fix:** Extract the theme-agnostic pieces (monogram() and the size-class shape) into a shared headless module both import, leaving only the genuinely-different theme-source detection (.dark class vs .console-root[data-theme]) forked. Minor accuracy note: normalizeTickerLogoSymbol (the share-class normalization) is ALREADY shared via @/lib/ticker-logos, so the finder's 'BRK.B truncation must be fixed twice' example is off — the still-duplicated piece is monogram()'s slice(0,2) + the size maps + the theme hook.
- **Files:** `app/ui/ticker-logo.tsx · app/console/ui/ticker-logo.tsx`

**[P3] app/old/page.tsx is a second full dashboard kept as legacy, with an unusual force-dynamic + initialSnapshot=null combination** _(severity adjusted on verification)_  
`Frontend engineering quality` · area: maintainability / legacy · effort: S  
- **Problem:** app/old/page.tsx renders <DashboardClient initialSnapshot={null} /> and its metadata frames it as 'Legacy Socratic Trade dashboard retained while the new autonomy desk becomes the primary app' (lines 6-9). It is a full second dashboard implementation kept alive. It sets export const dynamic = 'force-dynamic' (line 4) yet passes initialSnapshot={null} (line 12), so it never receives server data despite being force-dynamic — an odd, likely-unrevisited combination.
- **Fix:** Decide explicitly: keep for rollback (add a comment with a removal target) or delete. The finder's 'unreachable/dead code, no discoverable in-app link' premise is FALSE — chrome.tsx:694 renders href="/old" in the user menu with title 'Open the legacy dashboard at /old. The new Socratic console is the primary app.' So it is intentionally linked, not dead. Downgraded to P3 accordingly: it is a maintained-but-redundant legacy surface, not orphaned code.
- **Files:** `app/old/page.tsx · app/dashboard-client.tsx · app/console/components/chrome.tsx`

**[P3] console Chip/Dot/Stat/SignedText hardcode three separate tone-to-token maps instead of one source of truth**  
`Frontend engineering quality` · area: component API design · effort: S  
- **Problem:** Tone-to-color mapping is duplicated three ways in the same file: CHIP_CLASS maps ChipTone to class names (69-78); DOT_COLOR is an untyped Record<string,string> keyed by a different, smaller set (pos/neg/warn/accent/muted) mapping to var(--con-*) (98-104); and Stat (138) plus SignedText (280) inline their own tone === 'pos' ? 'var(--con-pos)' : ... ternaries. Dot's prop type is keyof typeof DOT_COLOR rather than the exported ChipTone, so Chip and Dot can silently drift (Chip has paper/live tones Dot lacks, with no compile-time link).
- **Fix:** Define one exported TONE_VAR: Record<Tone, string> map and derive DOT_COLOR, the Stat/SignedText ternaries, and Chip's class lookup from it so adding a tone is one edit. Accurate as written.
- **Files:** `app/console/ui/primitives.tsx`

**[P3] useConsoleData aborts any in-flight refresh unconditionally, so rapid SSE bursts can chain abort-then-refetch cycles**  
`Frontend engineering quality` · area: render/perf · effort: S  
- **Problem:** refresh() aborts inFlight.current unconditionally at the start of every call (useConsoleData.tsx:68-71) rather than joining/ignoring overlapping calls. Combined with the 15s poll and 7 SSE event types all funneling into a single 200ms queueRefresh debounce (:85-93, :159), a burst of order+proposal+dirty events after a Run-once cycle can cause abort-then-refetch churn, though the flat debounce mitigates the common case.
- **Fix:** Low priority given the debounce handles the common burst. If refresh-storm symptoms appear (FreshnessStrip flicker), consider a trailing-edge-only debounce or a minimum in-flight lifetime before allowing abort-and-retry. Accurate and appropriately hedged.
- **Files:** `app/console/lib/useConsoleData.tsx`

**[P3] Mobile /mobile control surface has no offline/connectivity handling despite depending on a live EventSource stream**  
`Responsive, mobile & PWA` · area: PWA resilience · effort: S  
- **Problem:** mobile-pwa-client.tsx:136-150 opens new EventSource("/api/mobile/events") and registers only message listeners — no onerror handler and no reconnect/stream-health state. grep confirms no navigator.onLine reference and no online/offline listeners anywhere in the file. With manifest display: "standalone", a user who loses signal mid-approval only gets the generic error state set on explicit fetch rejection (submitCommand catch, lines 168-171); there is no distinction between "command failed" and "you were offline and it never sent."
- **Fix:** Add a lightweight offline banner driven by navigator.onLine plus online/offline listeners so a phone user approving a live trade proposal in a dead zone is not left guessing whether the tap reached the backend. P3 is appropriate — resilience polish, not a broken core path.
- **Files:** `app/mobile/mobile-pwa-client.tsx`

**[P3] Allocation bars use one accent color for every non-cash segment, giving no concentration-risk cue** _(severity adjusted on verification)_  
`Trading-domain data display UX` · area: Positions/allocation display · effort: M  
- **Problem:** Each non-cash segment (allocation.tsx:151-159) is var(--con-accent) regardless of size; the only branch is cash-vs-not (line 156). A 3%-of-account name and a 45% concentration look the same hue, and the app has a maxSymbolExposurePct guardrail (field-defs.ts:55) this card could passively check against.
- **Fix:** When lens is 'By position' and an exposure cap is configured, color or outline any segment whose pct exceeds maxSymbolExposurePct in warn/neg tone. Purely additive enhancement.
- **Files:** `app/console/components/allocation.tsx`

**[P3] No unit test covers a SHORT position's unrealized-P&L sign in the Positions table** _(severity adjusted on verification)_  
`Trading-domain data display UX` · area: Numeric correctness / signed coloring · effort: S  
- **Problem:** positions.tsx:37-41 computes costBasis = averageCost*quantity, unrealized = marketValue - costBasis, unrealizedPct = unrealized/Math.abs(costBasis)*100, feeding a color-coded SignedText (lines 66-69). The finding itself traces the short case and concludes the arithmetic 'likely produces the right sign' — it identifies no actual defect, only missing test coverage.
- **Fix:** Add a unit test asserting a short's unrealized P&L sign/color (e.g. short 10 @ $50, now $40 -> +$100, green) to lock the formula. This is test-coverage hardening, not a UI-display fix.
- **Files:** `app/console/components/positions.tsx`

**[P3] Partial-fill, stale, and status signals for one order are spread across three separate columns**  
`Trading-domain data display UX` · area: Order-ticket clarity · effort: S  
- **Problem:** For an order that is both partially filled and stale, the fill progress (Size cell, lines 400-404), the stale chip (Age cell, lines 452-460), and the status chip (lines 462-466) sit in three separate <td>s with independent tone logic, requiring the reader to mentally reconcile them for a single 'this partial has sat a long time' read.
- **Fix:** Minor: optionally add a combined 'partial, stale' micro-label near Status. Low priority — the finding itself notes, and I confirmed, the row already gets a bg-[color:var(--con-warn-soft)] highlight when row.stale (line 382), which does most of the consolidation work.
- **Files:** `app/console/orders/page.tsx`

**[P3] Approvals page header count and nav badge count can visibly disagree because they measure different queues** _(severity adjusted on verification)_  
`UX, information architecture & flows` · area: IA / discoverability · effort: S  
- **Problem:** The nav badge is decisionCount = pendingCount + learnedCount (nav.tsx lines 103, 139) — trade proposals PLUS learned-context confirmations, one merged number. But the Approvals page header shows only `(filtered.length/pending.length)` (approvals/page.tsx lines 167-171), i.e. trade proposals alone; the LearnedContextInbox renders as a separate section far below (line 307) with no count in the header and no anchor/jump link. So a user who clicks a badge reading e.g. 12 lands on a header reading e.g. (9/9), the two numbers disagree, and the 3 learned-context items are only discoverable by scrolling past the whole proposal list. The nav's honest breakdown tooltip (badgeTitle, lines 64-69) is title-attribute only, unreachable by tap on mobile.
- **Fix:** Show the learned-context count in the Approvals header when learnedCount > 0 (e.g. 'Approvals (9) · 3 learned-context items below') so the number the user clicked matches what they immediately see, and add a jump-link/anchor to LearnedContextInbox. Keep P3 (cosmetic count mismatch, no data-integrity impact). Note the finder's stronger sub-claims about mobile badge tooltips are secondary; the core defensible issue is the header/badge number mismatch.
- **Files:** `app/console/components/nav.tsx · app/console/approvals/page.tsx`

**[P3] Guardrails page applies 'preferences with narrative + off-switch' framing inconsistently across equally consequential settings** _(severity adjusted on verification)_  
`UX, information architecture & flows` · area: consistency / IA · effort: M  
- **Problem:** AutonomyCard (rendered at line 111, above the Essentials card at line 113) gets top billing, a full prose explanation, and a TypedConfirm('AUTOPILOT') ritual (lines 343-382). But 'Sell to Fund Buys → Automated' — which also lets the strategy sell positions autonomously — is a bare `<Select>` inside the collapsed 'Universe' AdvancedGroup with only a one-line hint (lines 276-292), and enabling short selling (a different risk profile) is just another AdvancedGroup ('Short selling', line 168). The app signals 'this is the big scary one' purely via UI weight, sending mixed messages about which settings are consequential.
- **Fix:** Not a call for new blocking gates (against product philosophy). For consistency, give 'Sell to Fund Buys: Automated' and enabling shorts the same one-sentence plain-language note about what changes as Autonomy gets — or simplify Autonomy's treatment to match the plainer pattern. Downgraded from P2: this is a consistency/polish gap on a config surface, not a broken or blocking flow, and the underlying 'which is scariest' judgment is subjective.
- **Files:** `app/console/guardrails/page.tsx`

**[P3] Scan page tab switcher (Market scan / Smart money) lacks ARIA tablist semantics**  
`UX, information architecture & flows` · area: consistency / accessibility · effort: S  
- **Problem:** ScanPage hand-rolls its tab UI (lines 110-140): a wrapping div plus plain `<button>` elements that set only onClick/title/className. None of `role="tablist"`, `role="tab"`, `aria-selected`, or `aria-controls` appear in the block, so screen-reader users get no indication the two buttons form a tab group or which is active, and the buttons aren't associated with the panel rendered below (lines 142-152). A shared Tabs primitive exists in app/ui/primitives.tsx but this console page doesn't use it.
- **Fix:** Add `role="tablist"` to the wrapper, `role="tab"` + `aria-selected={tab === t.id}` + `aria-controls` to each button, and a matching `id`/`role="tabpanel"` on the rendered panel. P3 (single localized surface, non-blocking).
- **Files:** `app/console/scan/page.tsx`

**[P3] Login page uses the undefined utility class 'border-border' (no matching token) and a manual Apple dark-mode color pair instead of theme tokens** _(severity adjusted on verification)_  
`Visual design & professional polish` · area: Cross-page consistency · effort: S  
- **Problem:** Login references `border-border`, which resolves to no color: there is no --color-border in globals.css's @theme block (the defined border token is --color-line / border-line), so the class is a no-op and the intended hairline border silently does not render. Separately, the Apple button manually re-implements light/dark switching (bg-neutral-900 ... dark:bg-white dark:text-neutral-900) instead of using token-based colors that flip automatically under .dark.
- **Fix:** Replace border-border with border-line (the real defined token) at both sites, and swap the Apple button's manual neutral-900/white dark pair for token-based colors (e.g. bg-fg text-bg) so it participates in the .dark flip like the rest of the app.
- **Files:** `app/login/page.tsx`

**[P3] The console thesis-hero card carries a decorative diagonal accent gradient wash on the surface holding the live decision text** _(severity adjusted on verification)_  
`Visual design & professional polish` · area: Visual hierarchy / density-appropriate motion · effort: S  
- **Problem:** The console home's most important element -- the live-thesis hero card -- bakes a linear-gradient(135deg, accent 10%, transparent 46%) wash into its background. For a cockpit whose value proposition is trustworthy, inspectable reasoning, a decorative tint on the card holding the actual thesis text is mild decoration competing with content.
- **Fix:** Optionally drop the diagonal gradient on .con-thesis-hero (or reduce to a 1-2px accent-colored top border / left rule) so the hero reads as a flat legible surface. Low priority -- the wash is a 10% accent mix fading to transparent by 46%, so it is barely perceptible.
- **Files:** `app/console/console.css`

