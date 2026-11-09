# UI/UX Issue Register — Agentic Trading Cockpit

Canonical, itemized list of every distinct issue surfaced by the 2026-06-20 multi-agent audits
(desktop real-Chrome walkthrough + source-grounded iPad/iPhone review). Prose reports with full
evidence are in [`2026-06-20-ui-ux-and-mobile-audit.md`](./2026-06-20-ui-ux-and-mobile-audit.md);
this file is the trackable backlog.

**Status legend:** ✅ Fixed (2026-06-20 pass, `agent/claude`, verified tsc + 386 tests + build,
live-confirmed where visible) · 🟡 Partial (some of the fix shipped) · ⏳ Deferred (not started) ·
📝 Noted (works as-is / nice-to-have / N-A on the active path).

**Active render path:** `app/page.tsx → app/dashboard-client.tsx` + the imported `app/ui/*`
(charts, macro-panel, symbol-drilldown, price-chart, ticker-logo, primitives, overlays, theme,
strategy-flow, assistant-console). **`app/ui/dashboard/{views,components,utils,settings}.tsx` are a
dead, unimported parallel implementation** — issues there don't affect runtime (see DUP-1).

Totals: ~45 ✅ · ~6 🟡 · ~22 ⏳ · ~5 📝 (updated 2026-06-21 deferred-fix pass — see `docs/rollouts/2026-06-21-ui-ux-deferred-fixes.md`).

---

## Reliability & correctness

| ID | Issue | Sev | Status | Files | Fix / note |
|----|-------|-----|--------|-------|-----------|
| REL-1 | Zero P&L/return/tax values colored as gains/losses (`+$0.00` green, `$0.00` tax red) | Med | ✅ | `app/dashboard-widgets.tsx`; `app/dashboard-client.tsx` | Added `pnlTone()` + zero-aware `signedMoney`/`formatPct`; applied to rail, mobile summary, Performance, Tax; Est-tax neutral at $0. |
| REL-2 | `PerformanceView` has no empty/no-data state (zero tiles instead of "no data yet") | Med | 🟡 | `app/dashboard-client.tsx:~1511` | Zero-neutral coloring shipped; an explicit `EmptyState` guard for the no-fills case is still TODO. |
| REL-3 | Settings policy-write race — full-snapshot PUT can revert a concurrent edit | Med | ⏳ | `app/dashboard-client.tsx:~307`; `app/api/policy/route.ts:25-33` | Send only the `patch` (server merges per-field) + `disabled={busy}` on index toggles / ticker inputs. |
| REL-4 | Dual concurrent `/api/scan` fetches on every load | Low | ⏳ | `app/dashboard-client.tsx` (`tickerScan` mount + `MarketScanView.refreshScan`) | Lift scan fetch into `DashboardApp`, pass `initialScan`/`onRefresh` down. |
| REL-5 | ⌘K command palette is built but unmounted; a live hint still points users to it | Med | ⏳ | `app/ui/command-palette.tsx`; `app/dashboard-client.tsx:~285` | Re-wire (state + meta/ctrl+K listener + mount + ⌘K pill) or delete the stale hint. |
| REL-6 | Strategy Flow edges render unthemed/low-contrast; nodes overlap; minimap unstyled; React-Flow watermark shown | Med | ✅ | `app/ui/strategy-flow.tsx` | Themed animated edges + arrowheads (`defaultEdgeOptions`), respaced nodes, `proOptions:{hideAttribution:true}`, removed the unstyled minimap, `colorMode` follows the app theme. |
| REL-7 | Macro default values impersonate live data (no `isDefault` flag, `asOf = now`) when no FRED key | Med | 🟡 | `src/lib/macro.ts:40,46,63`; `app/ui/macro-panel.tsx` | "Broad USD (DTWEXBGS, not DXY)" relabel + tooltip shipped; backend `isDefault` flag + a "showing defaults" chip still TODO. |

## Information architecture & navigation

| ID | Issue | Sev | Status | Files | Fix / note |
|----|-------|-----|--------|-------|-----------|
| IA-1 | Market Scan **Score column (sort key + ▼) clipped off-screen**; no horizontal scroll | High | ✅ | `app/dashboard-client.tsx` | Score moved to column 2; scan wrapper `overflow-x-auto` + table `min-w-max`. |
| IA-2 | Autonomy/run-state split across 3+ uncoordinated surfaces (header Mode, Start/Stop, Settings authority + Enable autonomy) | Med | ⏳ | `app/dashboard-client.tsx:~548,617,2353` | Make Settings authority read-only ("change in toolbar"); route the Settings autonomy toggle through the same confirm modal; surface a read-only mode chip on narrow viewports. |
| IA-3 | "Strategy" duplicated: prompt + LLM-review live in both the Strategy tab and the Studio modal | Med | ⏳ | `app/dashboard-client.tsx` (StrategyView + StrategyStudio) | Pick one canonical home for the prompt + review; the other links to it. |
| IA-4 | Header status cluster renders critical state (Halted/Active) as tiny equal-weight dots | Med | ⏳ | `app/dashboard-client.tsx:~518-533` | Collapse to one prominent system-state pill + a small market badge; drop the redundant execution-mode dot (already in the banner). |
| IA-5 | Header groups nav-openers and execution triggers in one row with no divider | Low | ⏳ | `app/dashboard-client.tsx:~576-631` | Wrap Run once / Start-Stop in a bordered sub-group. |

## Market Scan & data tables

| ID | Issue | Sev | Status | Files | Fix / note |
|----|-------|-----|--------|-------|-----------|
| SCN-1 | Idle vs loading copy contradicts itself ("Scanning…" + "choose a base index") | Low | ✅ | `app/dashboard-client.tsx:~1303` | Hint branches on `scanLoading` ("Fetching quotes…"). |
| SCN-2 | `TableVirtuoso` blank-row flash on mount (no `overscan`/`initialItemCount`) | Low | ✅ | `app/dashboard-client.tsx` | `overscan={600}` + `initialItemCount` added. |
| SCN-3 | Compound chips show an unlabeled 0–100 score ("Positive 64") | Low | 🟡 | `app/dashboard-client.tsx` (local chips); `app/ui/dashboard/components.tsx` (dead) | Added "·" separator ("Positive · 64"); the number's scale is in the cell tooltip. Splitting into 2 columns deferred. |
| SCN-4 | Congress/Insider feed is all-red SELL chips with no base-rate framing | Low | ⏳ | `app/dashboard-client.tsx:~1444` | Add a one-line "SELLs are routine — watch BUYs" footnote and/or sort BUYs first. |

## Visual design, theming & motion

| ID | Issue | Sev | Status | Files | Fix / note |
|----|-------|-----|--------|-------|-----------|
| VIS-1 | Light-mode logo tile hides white-glyph logos (AAPL invisible) | Med | ✅ | `app/ui/ticker-logo.tsx` | Dark slate tile in light mode; surface tile in dark. Live-confirmed AAPL renders. |
| VIS-2 | `backdrop-blur` on table `<tr>`s (dead/no-op CSS + GPU cost) | Low | ✅ | `app/ui/dashboard/views.tsx` (deleted) | Resolved by deleting the dead `views.tsx` (DUP-1). |
| VIS-3 | Animated mesh orbs over-saturate light mode (washes out cards; red orb behind content) | Low | ✅ | `app/globals.css` | Lower light-mode opacities (+ `.dark` restore); swapped the red `--down` orb to neutral `--info`. |
| VIS-4 | Settings/Flow modal jumps vertically on tab switch | Med | ✅ | `app/dashboard-client.tsx` (Settings body `min-h`) | Settings content min-height stops the reflow; Flow is full-size (N/A). |
| VIS-5 | Score cell visually under-weighted vs Sentiment/Rating chips | Low | 📝 | `app/dashboard-client.tsx` | Score is now col 2 + bold; an optional score-tier dot/bar is a nice-to-have. |

## Copy, terminology & accuracy

| ID | Issue | Sev | Status | Files | Fix / note |
|----|-------|-----|--------|-------|-----------|
| CPY-1 | No product-level "not investment advice" disclaimer on order-proposing surfaces | Med | ⏳ | `app/dashboard-client.tsx` (Decision PanelHeader) | Add one persistent informational line on Decision + a Brokerage-mode notice in Settings. |
| CPY-2 | Macro sparklines color rising VIX / credit spread green ("up = good") | Med | ✅ | `app/ui/macro-panel.tsx` | Polarity-aware: VIX/HY green when falling, red when rising; yields/USD/oil neutral gray. Live-confirmed. |
| CPY-3 | "USD index" label invites DXY confusion (broad index ~120 vs DXY ~100) | Med | ✅ | `app/ui/macro-panel.tsx` | Relabeled "Broad USD" + tooltip clarifying DTWEXBGS, not DXY. |
| CPY-4 | Settings subtitle ("Risk, tax & notifications") names only 2 of 6 tabs | Low | ✅ | `app/dashboard-client.tsx:766` | "Universe, risk, keys, tax & notifications". |
| CPY-5 | Two divergent `SettingsContent`s; Risk tab unreachable from the gear | Med | 🟡 | `app/dashboard-client.tsx:~2165` | Dead copy deleted (DUP-1); adding a Risk tab to the live Settings still TODO (risk params currently only on the Strategy tab). |
| CPY-6 | Decision empty-state says "Choose an account" though Test is always active | Low | ✅ | `app/dashboard-client.tsx:~1090` | Reworded to "Set your tradable universe in Settings → Operate, then Run…". |
| CPY-7 | Tuning tab exposes source-file paths to end users | Low | ✅ | `app/ui/dashboard/settings.tsx` (deleted) | Resolved by deleting the dead `settings.tsx` (DUP-1) where the paths lived. |
| CPY-8 | "No account selected." run failure rendered as an alarming **red** error for an active Test account | High | 🟡 | `app/dashboard-client.tsx` (UI); `src/lib/strategy.ts:87,478` (root) | UI: setup-type failures now render **amber "needs setup"** (live-confirmed). Root cause (why `policy.accountNumber` is empty when `connectedAccountId` is set) deferred — needs backend investigation + tests. |
| CPY-9 | Safety banner is all-caps (swallows the explanatory sentence) | Low | ✅ | `app/dashboard-client.tsx` | Removed CSS `uppercase`; the mode prefix is already caps in the string, so the clarification now reads sentence-case. |
| CPY-10 | Leaked internal identifiers ("test/local"; stale `Mock\/Local` regex missing `Test`) | Low | ⏳ | `src/lib/execution-mode.ts`; `app/dashboard-client.tsx` (action-title regex) | Map internal mode strings to user labels; update the action-title regex. |
| CPY-11 | Mode-label copy mismatch (header "Propose → you approve" vs Settings "LLM proposes — you approve") | Low | ⏳ | `app/dashboard-client.tsx` | Standardize one phrasing. |
| CPY-12 | "· live" overstates freshness when the market is closed / quotes are delayed | Low | ⏳ | `app/dashboard-client.tsx:~1322` | "· refreshed" + "· prices delayed" when closed. |

## Accessibility & responsive (desktop)

| ID | Issue | Sev | Status | Files | Fix / note |
|----|-------|-----|--------|-------|-----------|
| A11Y-1 | No `prefers-reduced-motion` support (4 perpetual animations + Motion transitions) | High | ✅ | `app/globals.css` | Reduced-motion media block stops orbs/shimmer/pulse. (Motion-component opt-out via `useReducedMotion()` still a nice add.) |
| A11Y-2 | Tabs missing `aria-controls`/`tabpanel` wiring | High | ✅ | `app/ui/primitives.tsx`; `app/dashboard-client.tsx` | Tab buttons get `id`/`aria-controls`; workspace panel is `role="tabpanel"` + `aria-labelledby` + `tabIndex=0`. |
| A11Y-3 | Command palette has no dialog role / focus trap | High | ⏳ | `app/ui/command-palette.tsx` | Apply `useDismissable` + dialog ARIA (resolve with REL-5). |
| A11Y-4 | Two header `<select>`s have no accessible name | Med | ✅ | `app/dashboard-client.tsx:548,558` | `aria-label="Approval mode"` / `"Active account"`. |
| A11Y-5 | Activity button doesn't announce its pending-count badge | Med | ✅ | `app/dashboard-client.tsx` | Dynamic `aria-label` with the pending count; badge is `aria-live="polite"`. |
| A11Y-6 | Column-picker dropdown lacks `aria-expanded`/role/Escape | Med | ⏳ | `app/dashboard-client.tsx:~1336` | `aria-haspopup`/`aria-expanded`, `role="listbox"`, Escape-to-close + focus restore. |
| A11Y-7 | Danger-button text fails AA contrast in dark mode (`text-white` on `--down`) | Low | ✅ | `app/globals.css`; `app/ui/primitives.tsx`; `app/ui/overlays.tsx` | Added `--down-fg` token (light `#fff`, dark `#2b0a10`); danger buttons use `text-down-fg`. |
| A11Y-8 | `--faint` helper text fails AA against the page background | Med | ✅ | `app/globals.css`; `app/dashboard-client.tsx` | Light `--faint` darkened to `#55657a`; 9px StatusPill/DailyRiskPill labels raised to 11px. |
| A11Y-9 | Input focus relies on cascade-layer order (works, but inconsistent with buttons) | Low | 📝 | `app/ui/primitives.tsx:260` | Align inputs to `focus-visible:outline` for consistency. |

## Mobile — iPhone (≤430px)

| ID | Issue | Sev | Status | Files | Fix / note |
|----|-------|-----|--------|-------|-----------|
| IPH-1 | Every input/select/textarea <16px → iOS auto-zoom on focus | High | ✅ | `app/globals.css` | `@media (max-width:640px){input,textarea,select{font-size:16px}}`. |
| IPH-2 | Market Scan silently clipped; SCORE off-screen, no scroll affordance | High | ✅ | `app/dashboard-client.tsx` | Same fix as IA-1 (score col 2 + `overflow-x-auto` + `min-w-max`). |
| IPH-3 | Settings 6-tab bar overflows/clips at 390px (Tuning/Notifications unreachable) | High | ✅ | `app/dashboard-client.tsx` | Tab bar wrapped in `overflow-x-auto`. |
| IPH-4 | Tap targets below 44pt (close ×, icon buttons, tab pills, ticker-remove chips) | High | 🟡 | `app/ui/primitives.tsx`; `app/ui/overlays.tsx`; `app/ui/price-chart.tsx` | IconButton / Tabs / modal-close / chart timeframe now ≥44px on mobile + `touch-manipulation`. Ticker-remove chips live in the dead settings copy; a full sweep is TODO. |
| IPH-5 | Header control cluster wraps to 3–4 rows, eating ~120–200px | High | ⏳ | `app/dashboard-client.tsx:~513` | Collapse secondary controls (Flow/Strategy/Settings/Theme) into a `…` popover below `sm`. |
| IPH-6 | Symbol drilldown header: name vs price block collide, no truncation | Med | ✅ | `app/ui/symbol-drilldown.tsx` | `min-w-0` + `truncate`; price block `shrink-0`. |
| IPH-7 | Price chart touch-pan steals page scroll; timeframe buttons ~18px tall | Med | ✅ | `app/ui/price-chart.tsx` | `handleScroll: { vertTouchDrag: false }`; timeframe buttons `min-h-[40px]` on mobile. |
| IPH-8 | Workspace tab bar scrolls but with no visual cue of hidden tabs | Med | 📝 | `app/dashboard-client.tsx:~645` | Already `overflow-x-auto` (not clipped); shorten labels / auto-scroll active tab — nice-to-have. |
| IPH-9 | No safe-area insets (landscape notch; home-indicator clearance) | Med | ✅ | `app/layout.tsx`; `app/globals.css` | `viewport-fit=cover` + `env(safe-area-inset-*)` body padding under an `@supports` guard (0 on non-notched devices). |

## Mobile — iPad

| ID | Issue | Sev | Status | Files | Fix / note |
|----|-------|-----|--------|-------|-----------|
| IPD-1 | Fixed cockpit shell was `xl`(1280)-only → every iPad got the phone shell (no rail/donut/positions) | Med | ✅ | `app/dashboard-client.tsx` | Lowered shell + grid + rail + content `xl:`→`lg:` (1024px); iPad landscape now gets the full cockpit. |
| IPD-2 | Market Scan table clipped at iPad widths | High | ✅ | `app/dashboard-client.tsx` | Same fix as IA-1. |
| IPD-3 | Settings tabs clip in Split View (~507px) / Slide Over (~320px) | Med | ✅ | `app/dashboard-client.tsx` | Same fix as IPH-3. |
| IPD-4 | Mesh-gradient / 59× `backdrop-blur` perf on older iPads, no reduced-motion guard | Med | ✅ | `app/globals.css` | Reduced-motion guard added. (Optional: disable orbs below `sm` for extra battery savings.) |

## Mobile — iOS Safari correctness

| ID | Issue | Sev | Status | Files | Fix / note |
|----|-------|-----|--------|-------|-----------|
| IOS-1 | Safe-area insets entirely absent | Med | ✅ | `app/layout.tsx`; `app/globals.css` | See IPH-9 — shipped. |
| IOS-2 | `100vh` on the error page (URL-bar jump) | Low | ✅ | `app/global-error.tsx` | `100vh` → `100dvh`. (Shell already uses `dvh`.) |
| IOS-3 | Input zoom (<16px) — the most pervasive mobile defect | High | ✅ | `app/globals.css` | See IPH-1. |
| IOS-4 | Tap targets <44pt | High | 🟡 | shared primitives | See IPH-4. |
| IOS-5 | Hover-only affordances unreachable by touch (row hover, SymbolButton chip, `title` tooltips, palette `onMouseEnter`) | Med | ⏳ | `app/dashboard-client.tsx`; `app/ui/command-palette.tsx` | Add `active:`/`focus:` equivalents; palette `onTouchStart`; don't rely on `title` for truncated content. |
| IOS-6 | `backdrop-blur` + animated gradient perf/battery, no reduced-motion guard | Med | ✅ | `app/globals.css` | Reduced-motion guard. |
| IOS-7 | Native `<select>` pickers (Mode/Account) at <16px | Low | ✅ | `app/globals.css` | Covered by the 16px rule; no custom shim needed. |

## Cross-cutting / structural

| ID | Issue | Sev | Status | Files | Fix / note |
|----|-------|-----|--------|-------|-----------|
| DUP-1 | **Dead parallel UI implementation** — `app/ui/dashboard/{views,components,utils,settings}.tsx` have no importers; `dashboard-client.tsx` carries local copies of all of it | Med | ✅ | `app/ui/dashboard/*` (deleted) | Deleted the directory after confirming no importers (`grep` across app/src/test). Closes CPY-7, VIS-2; removes the dead half of CPY-5/SCN-3. |
| MISC-1 | SVG gradient ids (`equity-fill`) are global — latent collision if rendered twice | Low | ✅ | `app/ui/charts.tsx` | Scoped with `useId()`. |
| MISC-2 | Glassmorphism blur tiers inverted (inner cards blur more than outer) | Low | ⏳ | various `app/ui/*` | Standardize: panels `-sm`, floating `-md`, overlays `-xl`. |
| MISC-3 | Win-rate StatTile has no tone; Congress column shows "0" for mixed activity; no persistent sort affordance on inactive headers | Low | ⏳ | `app/dashboard-client.tsx` | Minor polish batch. |
| MISC-4 | SSE staleness not surfaced (120s fallback poll, no "last updated"); empty-universe scan returns 200 indistinguishable from "no data" | Low | ⏳ | `app/dashboard-client.tsx`; `app/api/scan/route.ts` | "Updated Xm ago" badge; short-circuit empty universe to the configure state. |

## Verified false positives / corrections (from the adversarial pass)
- "Input `outline-none` kills the focus ring" — **false**; the global `:focus-visible` wins via
  cascade-layer order (downgraded to A11Y-9, a consistency nit).
- "Modal max-width exceeds viewport / padding disappears" — **false**; `max-w-*` are caps, `w-full`
  inside `p-4` keeps the dialog inset. The real bug was the in-modal **tab-row** overflow (IPH-3).
- Light-mode danger button / Activity badge contrast — **pass** AA; only dark-mode danger fails (A11Y-7).

## Coverage boundary (not runtime-verified)
- Mobile/responsive findings are **source-grounded** — the test harness pinned the render viewport at
  1438px, so nothing below was observed on a physical iPhone/iPad. Tailwind/CSS conclusions are
  deterministic; runtime specifics (exact header wrap count, TableVirtuoso scroller behavior,
  chart/page touch arbitration, on-device GPU cost) need a real device.
- ⌘K palette, the Accounts modal, the full Strategy Studio flow, and a live LLM-generated Decision
  could not be exercised at runtime (palette unmounted; Decision/LLM needs `OPENAI_API_KEY`).
