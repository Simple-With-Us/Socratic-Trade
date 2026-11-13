# Accessibility, Responsive & Theming Specification — Navigation & Settings Redesign (v2)

**Scope of this document.** This is the a11y / responsive / theming build spec for the frame defined in [`docs/settings-navigation-redesign.md`](../../settings-navigation-redesign.md) (v2). It does not restate the IA; it specifies keyboard model, screen-reader treatment, non-color safety cues, the Live-red viewport treatment, responsive collapse of the three-zone chrome, and the four Appearance settings (`theme`, `density`, `executionBannerMode`, `tickerLogoDisplay`) — each with concrete field names, control types, defaults, states, file paths, and pass/fail acceptance criteria.

**North star (owner-locked priority):** the three safety-critical cues — **which account**, **practice vs real money**, and **halted/running** — are the top a11y priority. Every one must be conveyed **redundantly** (text + shape/icon + ARIA live announcement), never by color alone, and must survive every breakpoint down to phone and every Appearance setting including `executionBannerMode: "hidden"`. Where a general a11y rule and a safety cue conflict, the safety cue wins.

**Grounding facts this spec is built on (verified against `HEAD 0f6bf0a`):**
- Theme is `"light" | "dark"` only (`app/ui/theme.tsx:6`), stored in `localStorage['theme']`, applied pre-paint by `themeInitScript` (`theme.tsx:14`) via `documentElement.classList.toggle('dark')` + `dataset.theme`. **No `"system"` option, no density token exist today** — both are net-new here.
- Design tokens live in `app/globals.css:10` (`:root`) / `:35` (`.dark`): `--bg --fg --accent --ring --line-strong --muted` etc. `:focus-visible` is globally styled `outline: 2px solid var(--accent); outline-offset: 2px` (`globals.css:141`).
- `@media (prefers-reduced-motion: reduce)` is already honored (`globals.css:230`) — it kills `body::before/::after` orbs, `.skeleton::after`, `.boot-strip-glow`, `.animate-pulse-fast`. **`prefers-contrast` / `forced-colors` are NOT handled** — net-new.
- `Modal` (`app/ui/overlays.tsx:62`) sets `role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}` and uses `useDismissable` (Escape + backdrop click) but has **no focus trap and no initial-focus move** — a defect this spec requires fixing before the switcher/STOP land in overlays.
- Existing ARIA anchors in `app/dashboard-client.tsx`: profile menu `aria-label` (`:603`), error region `aria-live` (`:735`), consent `role="dialog"` (`:808`), approval-mode `aria-label` (`:1658`), active-account `aria-label` (`:1676`), run-once `aria-label` (`:1725`), STOP `aria-label` (`:1741`), tabpanel `aria-labelledby` (`:1794`).
- `Segmented` / `Tabs` primitives (`app/ui/primitives.tsx:227`) already do `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, and roving arrow-key `onKeyDown` (`:239`). Reuse these — do not reinvent.
- Mobile PWA client (`app/mobile/mobile-pwa-client.tsx`) has a `CircleStop` "Stop" control (`:300`) and calls `setActiveConnectedAccount` via the command API (`src/lib/mobile-api.ts:648`) — the singleton hazard from Part III gap #3.

---

## 1. Keyboard navigation & focus order

### 1.1 Global shell landmark & tab order

The three-zone chrome (canonical wireframe, doc §"Global frame") is a persistent `<header>` landmark rendered by the new `app/(shell)/layout.tsx` (doc P0). Wrap each zone in a semantic landmark so screen-reader users can jump between them with rotor/landmark navigation:

| Zone | Element | `aria-label` | Tab-order rank |
|---|---|---|---|
| LEFT (scope) | `<nav aria-label="Account scope">` | "Account scope" | 2 |
| CENTER (spine) | `<nav aria-label="Primary">` | "Primary navigation" | 3 |
| RIGHT (verbs + risk) | `<div role="toolbar" aria-label="Account controls">` | "Account controls" | 4 |
| Main content | `<main id="main">` | (destination name) | 5 |

**Rank 1 is a skip link.** First focusable element in DOM order is a visually-hidden-until-focused `<a href="#main" class="skip-link">Skip to main content</a>` (net-new; add `.skip-link` to `globals.css` with `:focus` un-hiding it). Acceptance: Tab from page load lands on the skip link; Enter moves focus into `<main>`.

**DOM order vs visual order must match** for the three zones (left → center → right → main) so the tab sequence is predictable. On narrow viewports where the layout reflows (see §5), DOM order stays fixed; only CSS position changes.

**Load focus.** On first paint focus rests on `document.body` (no autofocus grab). On client-side destination change focus moves to the `<h1>` of the newly-rendered destination (which has `tabIndex={-1}`), and an `aria-live` region announces the destination + scope (§3.2). Acceptance: switching destinations via keyboard never leaves focus orphaned on a now-unmounted node.

### 1.2 The three safety controls are always keyboard-reachable

**Requirement (locked):** the **account switcher** and **STOP** must be reachable by keyboard on *every* screen and at *every* breakpoint, including `/admin`, `/mobile`, and any open overlay. Concretely:

- A global keydown handler (registered in `layout.tsx`) binds:
  - **`Alt+S`** → focus the account switcher trigger (`aria-keyshortcuts="Alt+S"` on the trigger).
  - **`Alt+H`** → focus the STOP button (`H` = halt; `aria-keyshortcuts="Alt+H"`). This only *focuses* it; activation still requires Enter/Space so it can never fire accidentally.
  - **`⌘K` / `Ctrl+K`** → open command palette (existing).
- These shortcuts are **suppressed while a text input/textarea/contenteditable has focus** (check `event.target`), except `⌘K` which is global. Document all three in Help → Overview and in a "Keyboard shortcuts" list reachable from the palette (`?` or type "shortcuts").

Acceptance: with a modal open, `Alt+H` still focuses STOP (STOP renders above modal content in the z-stack via a portal at `z-[1400]`, one above `Modal`'s `z-[1300]`). No keyboard trap prevents reaching it.

### 1.3 Account switcher (combobox pattern)

The switcher is a **disclosure button + listbox popover**, implemented to the ARIA "combobox/listbox" contract (not a native `<select>` — it needs rich rows).

- Trigger: `<button role="combobox" aria-haspopup="listbox" aria-expanded aria-controls="acct-listbox" aria-label="Active account: Roth IRA · Alpaca, paper practice money, propose only">`. The `aria-label` is the full four-questions string (§3.1), recomputed on scope change.
- Popover: `<ul role="listbox" id="acct-listbox" aria-label="Accounts">` with group headers as `role="group"` + `aria-labelledby` pointing at a `role="presentation"` heading ("Live — real money", "Paper — practice money", "Sandbox — Test / local sim", per wireframe Screen 5).
- Each row: `<li role="option" aria-selected>` whose accessible name concatenates alias, broker, money-reality **word-class**, authority, health, day-P&L, pending count, preset — e.g. `"Robinhood Individual, live, real money, decide, healthy, up 0.8 percent, 2 pending approvals, preset Momentum-v3"`.
- **Keyboard:** ↑/↓ move active option, Home/End jump, typeahead by alias, Enter/Space select, Esc close + return focus to trigger, Tab closes and moves on. This is a **no-trap** popover (focus is not forced to cycle; Tab escapes).
- **Selecting a Live row** triggers the money-reality acknowledgment (§4.3) *before* the re-scope commits; focus moves into that confirm dialog.
- **Single-account user (P11):** the trigger renders as a **static, non-interactive chip** (`role` removed, `aria-haspopup` absent, not in the tab order beyond being a labeled status region `role="status"` — wait: it must still be *readable* but not *actionable*). Render it as `<div role="img" aria-label="Account: <alias>, <mode>, <authority>">` so SR users still hear the scope but there is no misleading disclosure affordance. `Alt+S` becomes a no-op announced as "single account — nothing to switch."

### 1.4 Command palette a11y

The palette (`⌘K`) is a modal combobox — the single most important keyboard surface, so it gets the strictest contract:

- Container `role="dialog" aria-modal="true" aria-label="Command palette"`, **focus-trapped** (see §1.6), Esc closes and restores focus to the previously-focused element (store `document.activeElement` on open).
- Input `role="combobox" aria-expanded="true" aria-controls="cmd-results" aria-activedescendant="<active-option-id>" aria-autocomplete="list"`.
- Results `role="listbox" id="cmd-results"`; each `role="option"` with a stable id; the input keeps DOM focus while ↑/↓ move `aria-activedescendant` (the standard "focus stays in input" pattern — never move real focus into the list).
- **Category grouping** ("Go to…", "Run…", "Open settings…", "Deep-link…") uses `role="group"` + `aria-label`; announce result count on every filter via a visually-hidden `aria-live="polite"` node ("7 results").
- **Money-reality gating (coherence E2, locked):** a palette "Run once" entry whose target account is Live must NOT execute on Enter. It routes into the same arm ritual as the chrome button — activating it opens the arm-Live confirm dialog. The palette option's accessible name states the target and mode: `"Run once on Roth IRA, paper"` or `"Run once on Robinhood, live — requires confirmation"`. Acceptance test: selecting a Live "run once" palette entry never dispatches an order without the typed-confirm dialog appearing and being satisfied.

### 1.6 Focus management for overlays (fixes the current Modal defect)

`Modal` (`overlays.tsx:62`) today has **no focus trap and does not move initial focus** — it only wires Escape + backdrop dismissal via `useDismissable`. Before any safety-relevant control (switcher confirm, arm-Live, STOP-confirm, Flatten) is rendered inside an overlay, `Modal`, `SlideOver`, and the palette must gain:

1. **Initial focus** on open → the first interactive element, or the dialog container (`tabIndex={-1}`) if none; for **destructive confirms, focus the *safe* default** (Cancel), never the destructive button.
2. **Focus trap** — Tab/Shift+Tab cycle within the dialog; implement with a `focus-trap` utility (query focusable descendants, wrap at edges). No keyboard trap *out* — Escape always exits.
3. **Focus restore** — on close, return focus to the trigger element that opened it (store on open).
4. **`aria-labelledby`** pointing at the visible `<h3>` title (currently only `aria-label={title}` — acceptable, but for dialogs with a subtitle add `aria-describedby` → subtitle id).
5. **Backdrop siblings inert** — set `inert` (or `aria-hidden="true"`) on the app root while a modal is open so SR/keyboard users can't reach background content. Exception: the STOP portal at `z-[1400]` stays reachable (§1.2).

The Assistant slide-over is a **non-modal** overlay (doc: "without losing place"): it does **not** trap focus and does **not** inert the background — it uses `role="complementary" aria-label="Assistant"` and is reachable via `⌘K`/rail button; Escape closes it and restores focus. This is the deliberate exception to trapping.

Acceptance (all overlays): axe-core "dialog" checks pass; manual test — open, Tab to last element, Tab again returns to first; Esc closes and focus returns to opener; screen reader announces dialog name on open.

### 1.7 Destination spine & no-trap invariant

The center spine reuses the `Tabs` primitive (`primitives.tsx:227`) which already implements roving `tabindex` + arrow keys + `aria-selected` + `aria-controls`. Extend it so: the active tab is the only one with `tabIndex={0}` (roving), Left/Right arrows move, Home/End jump to first/last, and Enter/Space activate. Scan (secondary, read-only) lives behind a "more ›" `aria-haspopup="menu"` disclosure, not in the primary roving group.

**Global acceptance (WCAG 2.1.2):** no keyboard trap anywhere. Automated smoke test: script-tab through the entire shell + each destination + each overlay; assert focus never gets stuck and every interactive element is reachable and has a non-empty accessible name.

---

## 2. ARIA roles & labels — switcher, MODE badges, STOP, approval cards

### 2.1 MODE badge (the money-reality cue)

A single reusable component `<ModeBadge mode account />` (net-new, `app/ui/mode-badge.tsx`) renders everywhere money-reality appears: switcher chip, switcher rows, destination headers, the Approve button, run-once button, Fleet cards. It is the canonical non-color implementation.

- **Visible content:** word-class first + specific mode + optional icon, e.g. `● PAPER · practice money`, `▲ LIVE · real money`, `▨ TEST · practice money`. Icon glyph is redundant with color (§4).
- **Money-reality mapping (locked):** `practice = Test + Paper` (grey / blue), `real = Live` (red). Test displays "TEST · practice money"; Paper displays "PAPER · practice money"; Live displays "LIVE · real money".
- **ARIA:** the badge is `<span role="img" aria-label="paper, practice money">` when standalone, so the color/glyph is never the sole carrier. When the badge is *inside* an interactive control (Approve button, run-once), the badge is `aria-hidden="true"` and its meaning is folded into the parent control's accessible name (§2.3, §2.4) — avoids double-announcement.
- Acceptance: turning off CSS (or forced-colors mode) still shows the word "practice money" / "real money"; a screen reader on any MODE badge announces the money-reality in words.

### 2.2 Account switcher

Covered in §1.3. Additional label rules: the trigger's `aria-label` is a full sentence answering the four questions in fixed order — **account → money-reality → authority → run-state** — so a blind supervisor gets the safety-critical facts first and consistently: `"Active account: Roth IRA Alpaca. Paper, practice money. Propose only. Running."` When halted, run-state becomes `"Halted."` and this is *also* announced via the live region (§3.3).

### 2.3 STOP (the kill switch)

- Element: `<button aria-label="STOP — halt new activity on Roth IRA" aria-keyshortcuts="Alt+H">`. The label names the target account so it can't be mistaken for a global halt in multi-account. In **Fleet** mode the label is `"STOP all accounts — halt new activity on all live and paper accounts"`.
- **STOP ≠ Flatten (locked).** STOP is one click, `type=button`, no confirm on Test/Paper, no confirm to *halt* on Live either (halting is always safe). It never sells. The separate **"Flatten / sell positions"** control is a distinct button with `aria-label="Flatten — sell all positions on Roth IRA"` that opens a confirm dialog (type-to-confirm on Live, §4.3). These two must not share a handler or a DOM node.
- **After STOP fires**, focus stays on the button (now relabeled to offer the inverse, e.g. `aria-label="Resume — account halted"`), and an `aria-live="assertive"` announcement fires: `"Halted. New activity stopped on Roth IRA."` In Fleet, the per-account confirmed-halted echo (doc novice #6) is announced as a list: `"Halted. Robinhood live: stopped. Alpaca paper: stopped."`
- Visible state uses the run-state icon set (§4.4): `■ STOP` (armed to halt) vs `‖ HALTED` (already halted) — shape differs, not just color.

### 2.4 Approval cards (doc Screen 2)

Each proposal card is an `<article aria-labelledby="prop-<id>-title">` in a `role="list"` / `role="listitem"` queue. Structure:

- **Title** (`<h3 id="prop-<id>-title">`): `"Buy NVDA, 120 shares, about $14,400, Roth IRA, paper"` — side, symbol, size, money-value, account, mode in words.
- **Policy gate**: a `<ul>` where each check is `<li>`; pass = `✓` with `aria-label="pass: size within 15% NAV"`, block = `⛔` with `aria-label="blocked: wash-sale lockout"`. Pass/block is icon + word, never green/red alone.
- **Wash-sale lockout row** (cross-account coupling, doc §Multi-account): `<li role="alert">` inside the card, text `"Wash-sale lockout — locked by a loss in Robinhood, live. Clears July 24. Cross-account tax coupling."` If the provenance return-type change (Part III gap #8) hasn't shipped, it degrades to `"locked by a wash-sale in another account."` Either way it is a full sentence, not a red pill.
- **Approve button carries the MODE badge in its accessible name (locked):** `<button aria-label="Approve — commits on Roth IRA, paper">`. For Live: `aria-label="Approve — commits real money on Robinhood, live"`. The visible badge on the button is `aria-hidden` (its words are in the label). This binds money-reality to the exact commit action.
- **Adjust-and-approve**: `aria-label="Adjust and approve — re-runs all policy checks on the edited size"` (novice #12). After an adjust, the re-run result is announced via the card's `aria-live="polite"` region.
- **Reject / Snooze**: labeled plainly; Reject opens a reason field (`aria-label="Rejection reason (feeds learning)"`).
- **Queue view toggle** (This account / All accounts) is a `role="radiogroup"`; in All-accounts each card title prepends the account+mode tag.
- **Live queue emphasis:** Live-account cards get `aria-roledescription="real-money proposal"` and are visually flagged with the red edge treatment (§4), but their ordering and semantics are otherwise identical.

Acceptance: a screen-reader walkthrough of one Live approval card conveys, in order, side/size/account/**real money**, every gate result in words, any wash-sale culprit, and an Approve control whose name says "real money" — with zero reliance on color.

---

## 3. Screen-reader treatment of scope & money-reality (no color reliance)

### 3.1 The four-questions accessible name contract

Every surface that shows scope composes its accessible name from four ordered slots, safety-first: **`<account alias>` → `<money-reality word-class>` → `<authority>` → `<run-state>`**. A shared helper `scopeAccessibleName(account)` in `src/lib/` (net-new; consumed by switcher, headers, badges) returns e.g. `"Roth IRA Alpaca, paper, practice money, propose only, running"`. This is the single source of truth so wording never drifts between surfaces (the same anti-drift discipline CLAUDE.md mandates for enrichment fields).

### 3.2 Destination + scope announcement on navigation/switch

A single polite live region `<div aria-live="polite" aria-atomic="true" class="sr-only" id="scope-announcer">` in `layout.tsx` announces:

- On **destination change**: `"Approvals. Roth IRA, paper."`
- On **account switch**: `"Now viewing Alpaca Taxable, paper, practice money, propose only."`
- On **switch into Live**: escalate to `aria-live="assertive"` for one message: `"Now acting on real money. Robinhood, live."` (paired with the visible acknowledgment, §4.3).

Debounce to one announcement per user action (avoid double-fire from both nav + scope effects).

### 3.3 Run-state & halt announcements

Run-state transitions (running → halted → close-only → tripped-breaker → running) announce via an **assertive** region because they are safety-critical: `"Halted. New activity stopped on Roth IRA."`, `"Circuit breaker tripped: max drawdown. Trading paused on Robinhood, live."` The Guardrails circuit-breaker cards each expose `aria-live="polite"` on their armed/tripped status so a user parked on Guardrails hears a trip without navigating.

### 3.4 Money-reality is never color-only — enforced

Locked requirement, restated as an acceptance gate: **no state that distinguishes practice vs real money may be conveyed by color alone.** Concretely, the following must each carry the word "practice money" or "real money" (or "Test"/"Paper"/"Live" which map to them) in either visible text or an `aria-label`:

- switcher chip and every switcher row,
- every destination header,
- the Approve/run-once buttons,
- Fleet cards,
- the viewport-edge Live treatment (§4).

**CI acceptance:** an automated test renders each surface with a Live account and asserts the accessible tree contains the substring "real money"; renders with Paper and asserts "practice money"; and a lint/test asserts no MODE indicator's only distinguishing attribute is a color class. This is the single most important a11y test in the suite.

---

## 4. The Live-red-viewport treatment, done accessibly

Doc requires: "A Live active account paints a persistent red viewport hairline" and "Switching into a Live account … paints the viewport red." This must be **accessible, not color-alone, motion-safe, and contrast-safe.**

### 4.1 Redundant encoding (word + icon + shape, not color)

The Live viewport treatment is a `<div role="presentation">` hairline **plus** a persistent, always-visible **corner tag** that reads `⬤ REAL MONEY · LIVE` (word + filled-circle glyph). The tag is `role="status" aria-label="This view is a live account. Real money."` and is rendered for Live only. So:

- **Color:** red hairline (`--danger`, see §6 token).
- **Word:** "REAL MONEY · LIVE" always present in the tag.
- **Shape/icon:** filled circle `⬤` distinct from the hollow `○`/`●` used for practice health dots; the hairline itself is a **solid 3px inset border**, whereas practice mode has **no border** (border-presence, not just hue, encodes reality).

Practice mode shows **no** red border and no corner tag (absence is the cue, plus the always-on switcher chip words). Acceptance: a user with full color-blindness (test with grayscale + a deuteranopia simulator) can still tell Live from Practice by the border presence + corner word tag.

### 4.2 `prefers-reduced-motion`

The switch-into-Live transition (viewport painting red) must **not** flash or animate under reduced motion. Implementation: the red border/tag appears **instantly** (no fade/pulse) when `@media (prefers-reduced-motion: reduce)`. Under normal motion, a single 150ms ease-in fade is permitted — **never a pulse or blink** (a blinking red edge is both a seizure risk and WCAG 2.3.1 territory). Extend the existing reduced-motion block (`globals.css:230`) to include any Live-edge animation class. Acceptance: with reduced motion on, entering a Live account shows the red edge with zero animation; nothing on screen blinks.

### 4.3 The "you are now acting on REAL MONEY" acknowledgment

- Rendered as a `Modal` (`role="dialog" aria-modal="true"`) with **focus trapped** and **initial focus on the safe/dismiss button**, titled "You are now acting on real money" (`aria-labelledby`).
- Its live announcement is assertive (§3.2). Dismissing returns focus to the switcher trigger.
- **Arm-Live and Arm-Auto-on-Live** (the two one-way doors) use type-to-confirm; the text input has `aria-label="Type APPROVE LIVE to confirm"` and the confirm button is disabled (`aria-disabled="true"`) until the typed string matches — matching the existing `typedText: "APPROVE LIVE ..."` pattern (`dashboard-client.tsx:1284`). Announce mismatch politely, not on every keystroke.

### 4.4 Run-state icon set (shape-encoded)

Run/halt states use distinct glyphs so state is never hue-only: `▶` running · `‖` halted · `●` close-only · `⚠` brake/tripped · `■` STOP (actuator). Each is paired with a word in its `aria-label` and, where space allows, a visible text label. Circuit-breaker tripped cards additionally show the breaker name in text.

### 4.5 `prefers-contrast` / `forced-colors`

Net-new (not handled today). Add:

- `@media (prefers-contrast: more)` → thicken the Live border to 4px, darken `--danger` to a AAA-contrast red, and strengthen `--line` tokens.
- `@media (forced-colors: active)` (Windows High Contrast) → the Live edge uses `border-color: Mark` / the corner tag uses system `Highlight`/`HighlightText`; the word tags and glyphs survive because they are real text, not background images. Ensure focus outlines use `outline-color: Highlight` under forced-colors so `:focus-visible` remains visible when `--accent` is overridden.

Acceptance: in Windows High Contrast mode, Live vs Practice is still distinguishable (border + word tag), and focus is still visible on every control.

---

## 5. Responsive breakpoints — collapsing the three-zone chrome

Tailwind breakpoints in use: `sm 640` · `md 768` · `lg 1024` · `xl 1280`. The shell must degrade from wide desktop to phone while **guaranteeing the switcher + STOP stay visible and reachable** (locked). Note the existing `max-width: 640px` rule forcing 16px inputs (`globals.css`, prevents iOS zoom) and the safe-area-inset handling — both stay.

### 5.1 Breakpoint ladder

| Range | Layout | Switcher | Spine | STOP | Ambient risk strip |
|---|---|---|---|---|---|
| **≥1280 (xl)** | Full three zones on one row | Full chip (alias · broker · mode word · authority · equity · day P&L) | All 6 primary verbs inline + "more ›" | `■ STOP` labeled with target | Full inline (`used 2k/10k · net 0.4x · Neutral`) |
| **1024–1279 (lg)** | Three zones, condensed | Chip drops day-P&L to a tooltip; keeps alias + mode word + authority | 6 verbs inline, tighter | Full STOP | Condensed (icons + numbers) |
| **768–1023 (md)** | Two rows: chrome row + spine row | Chip keeps alias + mode word + authority (equity moves into dropdown) | Spine wraps to its own row, still `role="tablist"` roving | Full STOP, stays on chrome row | Collapses to a single "risk" pill that expands on click (`aria-expanded`) |
| **640–767 (sm)** | Chrome row only; spine becomes a bottom bar | Chip shows alias + mode **glyph+word abbreviated** (`▲ LIVE·real`); tap opens full switcher sheet | Spine → **bottom navigation bar** (fixed, `role="navigation" aria-label="Primary"`), 4 most-used verbs + "More" sheet | STOP stays top-right of chrome row, **always visible** | Risk strip → single tap-to-expand pill |
| **<640 (phone)** | Single-column app; PWA parity | **Compact scope bar** pinned top: mode glyph + word + account alias, tap → full-screen switcher sheet | Bottom nav (Dashboard, Approvals, Strategy, Guardrails) + "More" (Results, Scan, Settings) | **STOP pinned to the top scope bar, never scrolls away** (`position: sticky; top: 0`) | Hidden by default; one line in the switcher sheet |

### 5.2 Non-negotiable collapse rules

1. **Switcher + STOP are the last things to collapse and never disappear.** At every breakpoint both are in the DOM, visible, and keyboard-reachable (`Alt+S` / `Alt+H` work at all widths). If horizontal space is exhausted, *other* chrome (ambient risk, equity, verb labels→icons) collapses first; STOP and the switcher chip are pinned.
2. **STOP never moves into an overflow menu.** It may shrink to an icon-only button but must keep its `aria-label` and a min 44×44px hit target (`max-sm:h-11 max-sm:w-11`, matching the existing `IconButton` pattern in `primitives.tsx:53`).
3. **The Live red-edge + corner tag survive all breakpoints.** On phone the corner tag may abbreviate to `⬤ REAL` but keeps `aria-label="live account, real money"`.
4. **Touch targets ≥ 44×44px** below `sm` for all interactive chrome (already the codebase convention — reuse `max-sm:min-h-[44px]` / `max-sm:h-11`).
5. **Bottom nav** on phone uses `role="navigation"`, roving tab semantics, and each item has a text label (not icon-only) so it passes name/role/value.

### 5.3 Mobile PWA account-scope parity (locked spec now, build later)

Full account-scope parity is specified now (doc Open Q6 / Part III gap #3/#11). The mobile client (`app/mobile/mobile-pwa-client.tsx`) must:

- Render the **compact scope bar** (mode word + account + STOP) at top, sticky.
- Its account picker must go through the **same view-scope-vs-arming split** as desktop. **Critical hazard (Part III gap #3):** `mobile-api.ts:648` currently calls `setActiveConnectedAccount` (the execution singleton). After P2 decouples view from execution, this call must be re-pointed at the *ephemeral view-scope* setter, **not** the arming/singleton path, or mobile becomes the surviving side-door that re-introduces the not-active→halted coercion. A11y consequence: the mobile switcher's `aria-label` and the "now acting on real money" announcement (§3.2, §4.3) must fire on mobile identically.
- STOP on mobile keeps the same `aria-label` + assertive halt announcement.

Acceptance: on a 375px-wide viewport, switcher and STOP are both visible without scrolling, both operable by keyboard (external keyboard) and by touch with ≥44px targets, and switching into a Live account announces "real money" and paints the red edge.

---

## 6. Appearance settings — theme, density, executionBannerMode, tickerLogoDisplay

These four live in **Settings → Appearance** (doc §Settings taxonomy, `[USER]` scope). All four are user-global (all accounts). Section rendered in `app/dashboard-client.tsx` (existing Appearance/Display section) via the `Segmented` primitive.

### 6.1 `theme` — control, states, defaults

- **Current state:** `"light" | "dark"` only (`theme.tsx:6`), stored `localStorage['theme']`, no explicit "System".
- **Required change (net-new):** add a third value **`"system"`** and make it the **default** for new users. Type becomes `Theme = "light" | "dark" | "system"`.
- **Control:** `Segmented<Theme>` with three options — "Light", "Dark", "System". `role="radiogroup" aria-label="Theme"`; each option a labeled radio (the `Segmented` primitive already supplies `focus-visible:ring`).
- **`"system"` behavior:** follow `window.matchMedia('(prefers-color-scheme: dark)')` live via a listener; update `.dark` class + `dataset.theme` on OS change. Update `themeInitScript` (`theme.tsx:14`) so that when stored value is `"system"` (or absent) it resolves from the media query pre-paint — the current script already does this when no value is stored, so the change is: persist the literal `"system"` and re-resolve on `change` events.
- **Acceptance (WCAG 1.4.3 AA):** in *both* resolved themes, body text vs `--bg` ≥ 4.5:1, large text/UI components ≥ 3:1. Verify `--fg`/`--bg` and `--muted`/`--bg` pairs in `globals.css:10/35` meet AA; **`--muted` on `--bg` is the known risk** — measure and darken if <4.5:1 for body-sized text (allowed to stay ≥3:1 only where used at large sizes). The `--danger` red used for Live must hit ≥4.5:1 against both themes' `--bg` for the "REAL MONEY" text and ≥3:1 for the border.

### 6.2 `density` — control, states, defaults (net-new token)

- **Current state:** no density token exists. Net-new.
- **Type / field:** `Density = "comfortable" | "compact"`, default **`"comfortable"`**, stored `localStorage['density']`, applied via `document.documentElement.dataset.density` (mirror the theme pattern). Add a `densityInitScript` sibling to `themeInitScript` so it applies pre-paint (no reflow flash).
- **Control:** `Segmented<Density>`, `aria-label="Density"`, options "Comfortable", "Compact".
- **Implementation:** density scales spacing/row-height via CSS custom props gated on `[data-density="compact"]` in `globals.css` (e.g. `--space-row`, table `py`, list gaps). **Density MUST NOT reduce interactive hit targets below 24×24 CSS px (WCAG 2.5.8 AA); below `sm` the 44px floor still applies regardless of density.** Font-size floor: compact may reduce to 13px min for body but never below 16px for inputs on mobile (keeps the iOS anti-zoom rule intact).
- **Acceptance:** switching to Compact never clips text, never drops a tap target below the 24px (desktop) / 44px (mobile) floor, and does not change any accessible name. Focus outlines remain fully visible (not clipped by tighter padding).

### 6.3 `executionBannerMode` — control, states, and the safety caveat

- **Current state:** `ExecutionBannerMode = "full" | "compact" | "hidden"` (`dashboard-client.tsx:195`), controlled by `Segmented` (`:5190`), persisted via `updateExecutionBannerMode` (`:1000`).
- **Control:** `Segmented<ExecutionBannerMode>`, `aria-label="Account-mode banner size"`, options "Full", "Compact", "Hidden". Default **`"full"`**.
- **SAFETY CAVEAT (locked, top-priority):** `executionBannerMode` governs the **banner's visual size only** — it must **never** suppress the money-reality cue itself. Even at `"hidden"`, the **switcher chip's mode word** and, for Live, the **red viewport edge + corner "REAL MONEY" tag** remain rendered. The setting hides the *big banner*, not the *cue*. Concretely: the Live red-edge treatment (§4) is independent of `executionBannerMode` and is not toggled by it. Acceptance: with `executionBannerMode: "hidden"` and a Live account active, the accessible tree still contains "real money" and the red edge is still present.
- **A11y:** when `"full"`/`"compact"`, the banner is `role="status" aria-label="<mode word-class>"` (e.g. "live, real money") — not `aria-live` (it's ambient, not an event). When `"hidden"`, no empty node is left announcing.

### 6.4 `tickerLogoDisplay` — control, states, and image a11y

- **Current state:** `TickerLogoDisplay = "tile" | "transparent" | "off"` (`dashboard-client.tsx:928`), controlled by `Segmented` (`:5202`) with a live preview (`:5211`, `TickerLogo` at `:5215`), threaded to every symbol view.
- **Control:** `Segmented<TickerLogoDisplay>`, `aria-label="Ticker logo display"`, options "Tile", "Transparent", "Off". Default **`"tile"`** (current default `DEFAULT_TICKER_LOGO_DISPLAY`).
- **Image a11y (applies to all three modes):** logos are **decorative** — the ticker symbol text is always the accessible name of the symbol button (`SymbolButton`, `app/ui/symbol-button.tsx`). Therefore `<TickerLogo>` must render its `<img>` with `alt=""` (or `role="presentation"`) so a screen reader never announces "NVDA logo image" redundantly before the "NVDA" text. In `"off"` mode no image renders. Acceptance: SR announces each symbol exactly once (the symbol/company text), never the logo, in all three modes.
- **Contrast:** in `"transparent"` mode a logo laid over the surface must not reduce the adjacent symbol text's contrast below AA; keep the text on its own opaque background, not over the logo.

### 6.5 Appearance section a11y (all four controls)

- Each control is a `Segmented` radiogroup with a visible `<label>` associated via `id`/`aria-labelledby`, plus a `FieldHelp` tooltip (existing `primitives.tsx` help pattern, `role="tooltip"`, Esc-dismiss).
- Changes apply **immediately** (no Save button) and announce politely: `"Theme set to dark."` via a section-level `aria-live="polite"`.
- All four persist to `localStorage` and (being `[USER]` scope) are labeled "Applies to all your accounts" per the scope-tag rule.
- **Acceptance:** keyboard-only user can reach and change all four via Tab + arrow keys; each has a non-empty accessible name; no change traps focus or loses it.

---

## 7. Global acceptance criteria (the merge gate for this workstream)

Every PR touching the shell, Appearance, or a safety cue must pass:

1. **WCAG 2.1 AA contrast** — text ≥4.5:1, large text / UI components / focus indicators ≥3:1, in **both** resolved themes and both densities. The Live "REAL MONEY" text ≥4.5:1 on its background. Automated with a token-contrast test over `globals.css` pairs.
2. **`:focus-visible` on every interactive element** — reuse the global `outline: 2px solid var(--accent)` (`globals.css:141`) and per-component `focus-visible:ring-[var(--ring)]`. No `outline:none` without a replacement ring. Under `forced-colors`, focus uses `Highlight`.
3. **No keyboard trap (WCAG 2.1.2)** — the tab-through smoke test (§1.7) passes for shell + every destination + every overlay; Esc exits every dialog and restores focus.
4. **Switcher + STOP reachable at every breakpoint** — automated viewport test at 1280/1024/768/640/375px asserts both are in the accessible tree, visible (not `display:none`/off-screen), and have ≥44px targets below `sm`.
5. **Money-reality is never color-alone (§3.4)** — the substring test for "real money"/"practice money" across all scope surfaces, plus a Live-account render that asserts the corner word tag + border presence independent of hue.
6. **Reduced-motion honored** — the Live-edge and all new animations respect `prefers-reduced-motion` (extend `globals.css:230`); nothing blinks.
7. **Dialog contract** — `Modal`/`SlideOver`/palette pass axe "dialog" rules: `role`, `aria-modal`, labelled, focus-trapped (except the non-modal Assistant), initial focus set, focus restored on close. This requires fixing the current `overlays.tsx:62` no-trap defect before safety controls render in overlays.
8. **Accessible names on all controls** — automated axe scan on each destination reports zero "button/link/input has no accessible name" violations; MODE badges, STOP, switcher, and Approve buttons carry the money-reality/scope words in their names.
9. **Screen-reader script pass (manual, per major surface)** — VoiceOver/NVDA walkthrough of: shell scope announcement, switching into Live, one Live approval card, STOP activation, and the Appearance section — each conveys the safety-critical facts in words with no color dependency.

**Files this workstream touches (absolute):** `/home/user/agentic-trading/app/(shell)/layout.tsx` (new), `/home/user/agentic-trading/app/globals.css`, `/home/user/agentic-trading/app/ui/theme.tsx`, `/home/user/agentic-trading/app/ui/overlays.tsx` (focus-trap fix), `/home/user/agentic-trading/app/ui/primitives.tsx` (Segmented/Tabs reuse), `/home/user/agentic-trading/app/ui/mode-badge.tsx` (new), `/home/user/agentic-trading/app/dashboard-client.tsx` (switcher, STOP, approval cards, Appearance section), `/home/user/agentic-trading/app/mobile/mobile-pwa-client.tsx`, `/home/user/agentic-trading/src/lib/mobile-api.ts` (view-scope re-point), and a new `scopeAccessibleName` helper in `/home/user/agentic-trading/src/lib/`.
