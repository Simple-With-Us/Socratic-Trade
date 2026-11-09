# UI/UX + iPad/iPhone Audit and Quick-Win Implementation — 2026-06-20

Two multi-agent audits (a real-Chrome desktop walkthrough + a source-grounded iPad/iPhone
review) of the Agentic Trading cockpit, followed by an implementation pass of the quick wins
and high-severity fixes. Method, full findings, and what shipped are below.

- **Audit method (desktop):** real Chrome walkthrough of the live app (every tab, modal,
  drawer; populated Market Scan) → grounded dossier → 64 agents (Haiku census + Sonnet
  per-dimension reviews + adversarial source-verification + Opus synthesis). 82 raw → 51
  confirmed findings.
- **Audit method (mobile):** source-grounded (the test harness pinned the render viewport at
  1438px, so true device emulation was impossible; Tailwind breakpoints are deterministic) →
  27 agents (Haiku census + Sonnet iPhone/iPad/iOS-Safari reviews + verify + Opus synthesis).
- **Implemented on `agent/claude`. Verified: `npx tsc --noEmit` clean, `npm test` 386 passing
  (49 files), `npm run build` green.** Key fixes visually confirmed live on :4100.

## Implemented this pass (active render path = app/dashboard-client.tsx + imported app/ui/*)

Quick wins:
- **Zero is neutral.** New `pnlTone()` + zero-aware `signedMoney`/`formatPct`
  (`app/dashboard-widgets.tsx`); applied to the Portfolio rail P&L tile + position rows,
  Mobile summary, Performance tiles, and Tax realized tiles; **Est. tax liability** is neutral
  at $0 instead of red (`app/dashboard-client.tsx`).
- **Light-mode ticker logos fixed** — white/transparent-glyph logos (AAPL) sat invisible on a
  near-white tile; tile is now a dark slate in light mode (`app/ui/ticker-logo.tsx`). Verified
  AAPL renders.
- **Reduced-motion guard** (stops the perpetual orbs / shimmer / pulse), **iOS 16px form-input
  rule** (kills focus auto-zoom), **calmer light-mode mesh orbs** (lower opacity + neutral
  second orb; dark mode unchanged), and **darker `--faint`** for contrast (`app/globals.css`).
- **Market Scan: Score is now column 2** (the default sort key is always on-screen);
  **`overflow-x-auto` + `min-w-max`** give the wide table a real horizontal scroll; the
  loading state now says "Fetching quotes…" vs the idle "Choose a base index…"
  (`app/dashboard-client.tsx`).
- **Sentiment/Rating chips** read "Positive · 61" / "Buy · 84" (separator) — fixed in the
  active local chips and the (dead) components copy.
- **Macro sparklines are polarity-aware** — VIX & HY spread are green when *falling* (good),
  red when rising; yields/USD/oil are neutral gray (direction-only). "USD index" relabeled
  **"Broad USD"** with a tooltip clarifying it is DTWEXBGS (~120), not DXY (~100)
  (`app/ui/macro-panel.tsx`). Verified.
- **Settings modal** subtitle corrected ("Universe, risk, keys, tax & notifications"); the
  6-tab bar is wrapped in `overflow-x-auto`; the body has a min-height so switching tabs no
  longer makes the dialog jump (`app/dashboard-client.tsx`).
- **Symbol drilldown** header truncates long names and de-dupes "Technology · Technology"
  (only shows industry when it differs from sector) (`app/ui/symbol-drilldown.tsx`).

Accessibility & mobile:
- `aria-label` on the Mode and Account `<select>`s; Tabs now emit `id`/`aria-controls` and the
  workspace panel is `role="tabpanel"` + `aria-labelledby` + `tabIndex=0`
  (`app/ui/primitives.tsx`, `app/dashboard-client.tsx`).
- `touch-manipulation` on the button base + ≥44px touch targets on IconButton / Tabs / modal
  close buttons / chart timeframe buttons below `sm` (`app/ui/primitives.tsx`,
  `app/ui/overlays.tsx`, `app/ui/price-chart.tsx`).
- Price chart: vertical touch drags scroll the page instead of panning the chart
  (`handleScroll: { vertTouchDrag: false }`); bigger timeframe tap targets.
- SlideOver: backdrop dismiss works on touch (`onClick`) and leaves a backdrop strip on
  phones (`max-[400px]:max-w-[calc(100vw-2rem)]`) (`app/ui/overlays.tsx`).
- `global-error` uses `100dvh` (`app/global-error.tsx`).
- **iPad:** the fixed "cockpit" shell now engages at `lg` (1024px) instead of `xl` (1280px),
  so iPad landscape gets the portfolio rail + two-column layout instead of the phone shell
  (`app/dashboard-client.tsx`).

## Decision-panel safety copy
- A failed strategy run whose summary is a *setup* issue ("No account selected", empty
  universe) now renders as an **amber "needs setup"** banner instead of an alarming red error;
  the no-decision empty state copy was clarified (`app/dashboard-client.tsx`). Verified amber.

## Deferred (documented; higher-risk or larger — not done this pass)
- **F1 backend root cause.** `src/lib/strategy.ts:87,478` throw `"No account selected."` when
  `policy.accountNumber` is empty even though a Test account is active (the UI selects
  `connectedAccountId`, the run needs `accountNumber`). The UI was softened; the
  account-number wiring needs investigation + tests before changing run semantics.
- **Dead parallel implementation.** `app/ui/dashboard/{views,components,utils,settings}.tsx`
  have **no importers** — `app/dashboard-client.tsx` defines its own local copies. (Edits made
  to `components.tsx`/`utils.tsx` during this pass are inert.) Recommend deleting the directory
  after a final usage check. This is the root of the audit's "two divergent SettingsContent" /
  "duplicate SCAN_COLUMNS" findings.
- **Header overflow menu** (collapse secondary controls into a `…`/hamburger below `sm`) —
  larger refactor, deferred.
- **Full safe-area-inset / `viewport-fit=cover`** — deferred to avoid a landscape-notch
  regression without on-device testing (portrait is already auto-constrained by iOS).
- **Strategy tab vs Strategy Studio** prompt/LLM-review consolidation; a **Risk tab** in
  Settings; **⌘K palette** re-wire (it is built but unmounted); per-finding tap-target sweep —
  structural, deferred.

---

# Appendix A — Desktop UI/UX audit (full report)


## Executive summary

The cockpit's foundation is genuinely strong — a coherent dark-mode design language, a glassmorphic card system, accessible primitives (Tabs, IconButton, Modal/SlideOver focus traps), per-cell tooltips with real provenance, and honest "real-data-or-dash" enrichment. The problems cluster in five themes. **First, the Market Scan table is structurally broken on standard displays:** Score is both the default sort key and the rightmost column, the wrapper has no `overflow-x-auto`, and the shell uses `overflow-x-hidden`/`xl:overflow-hidden`, so the active sort indicator and the table's organizing principle are clipped off-screen with no scroll affordance. **Second, financial accuracy and tone bugs erode trust:** zero P&L renders green with a `+` prefix, `$0.00` tax liability renders red, macro sparklines color rising VIX/credit-spreads green, the USD-index default impersonates live data with today's date, and there's no product-level "not investment advice" disclaimer on the order-proposing surfaces. **Third, the information architecture has duplicated authorities** — autonomy/run-state is split across three header controls plus a Settings duplicate, the Strategy concept lives in both a tab and a modal, and two divergent `SettingsContent` implementations exist (one is dead code with a different tab list than the live one). **Fourth, accessibility has real gaps:** no `prefers-reduced-motion` guard on four perpetual animations, unlabeled header selects, a tab/tabpanel ARIA wiring gap, and a dead-but-inaccessible command palette. **Fifth, light mode is under-polished** (invisible white logos, over-saturated orbs, a red orb behind content). The single highest-leverage fixes: make the scan table horizontally scrollable + move/sticky the Score column; add the reduced-motion media block; fix zero-value tone across P&L/tax/macro; and collapse the duplicated Settings/Strategy/autonomy surfaces.

## Top priorities (do these first)

| # | Issue | Severity | Effort | Files |
|---|-------|----------|--------|-------|
| 1 | Scan table clips Score column + sort indicator off-screen; no horizontal scroll | High | S | `app/dashboard-client.tsx:504, 1372, 1219-1220, 1238` |
| 2 | No `prefers-reduced-motion` support — 4 perpetual animations + all Motion transitions | High | S | `app/globals.css:118,126,177,190`; `app/ui/overlays.tsx`; `app/ui/command-palette.tsx` |
| 3 | Zero P&L/tax/return values colored green/red instead of neutral (`+$0.00` green, `$0.00` tax red) | Medium | S | `app/dashboard-widgets.tsx:14`; `app/dashboard-client.tsx:861,1540-1543,1601`; `app/ui/dashboard/views.tsx:365-368,424` |
| 4 | `backdrop-blur-lg`/`-xl` on table rows — dead/no-op CSS, GPU compositing cost, blank-row flash | High | S | `app/ui/dashboard/views.tsx:245`; `app/dashboard-client.tsx:928,1381` |
| 5 | Macro sparklines color rising VIX / credit-spread green ("up = good") | Medium | S | `app/ui/macro-panel.tsx:86-98` |
| 6 | Two divergent `SettingsContent`s; dead `settings.tsx` version; subtitle misnames tabs; Risk tab unreachable from gear | Medium | M | `app/ui/dashboard/settings.tsx:43-362`; `app/dashboard-client.tsx:766,2190,2248-2255` |
| 7 | No product-level financial disclaimer on order-proposing surfaces | Medium | S | `app/dashboard-client.tsx:~1084`; `app/ui/dashboard/views.tsx` |
| 8 | Settings/Strategy-Flow modal vertically re-centers (jumps) on tab switch | Medium | S | `app/ui/overlays.tsx:82,103` |
| 9 | Strategy LLM-review + prompt duplicated between Strategy tab and Strategy Studio modal | Medium | S | `app/ui/dashboard/views.tsx:589,628`; `app/dashboard-client.tsx:2114-2146` |
| 10 | USD-index default 121.00 shown with today's date, indistinguishable from live | Medium | S | `src/lib/macro.ts:40,46,63`; `app/ui/macro-panel.tsx:228,241,244` |
| 11 | Light-mode logo tile is near-white — white-glyph logos (AAPL) invisible | Medium | S | `app/ui/ticker-logo.tsx:43`; `app/globals.css:13` |
| 12 | Settings policy-write race: full-snapshot PUT can revert concurrent edits | Medium | M | `app/dashboard-client.tsx:307`; `app/api/policy/route.ts:25-33` |

## Findings by theme

### Reliability & correctness

**Zero values get directional (green/red) color instead of neutral** — `[Medium][S]`
`signedMoney(0)` returns `+$0.00` (`app/dashboard-widgets.tsx:14`); Performance tiles use `realized >= 0 ? "up" : "down"` (`dashboard-client.tsx:1540-1543`), the portfolio/mobile rails use `pnl >= 0` (`861`, `909`), scorecard bars use `row.pnl >= 0` (`charts.tsx:101`), and Est. tax liability is hard-coded `tone="down"` (`1601`) so `$0.00` owed shows red. A fresh zero-balance account therefore reads as "winning" and "owing tax" simultaneously. Fix: special-case `=== 0` in `signedMoney`; introduce `pnlTone(v) = v>0?'up':v<0?'down':'neutral'` and apply it everywhere; gate the tax tile on `> 0`. `"neutral"` already maps to `text-fg` in `primitives.tsx:277`, so no token work is needed. The adjacent "Disallowed (wash sale)" tile (`1602`) already uses the correct `> 0 ? "warn" : "neutral"` pattern — copy it.

**`PerformanceView` has no empty/no-data state** — `[Medium][S]`
`dashboard-client.tsx:1522-1543` reads `snapshot.performance` and defaults every metric to `0` via `?? 0` with no `if (!perf)` guard, so a no-fills account shows green `$0.00` / `0%` tiles instead of an empty state. Fix: add an `EmptyState` guard before the return ("No performance data yet — outcomes appear once positions close"), plus the zero-neutral tone fix above.

**Settings policy-write race can silently revert edits** — `[Medium][M]`
`updatePolicy` sends `{ ...snapshot.policy, ...patch }` (`dashboard-client.tsx:307`) where `snapshot` is the render-time closure; the server prefers any client-supplied array over the DB value (`api/policy/route.ts:25-33`). Two edits racing within one `load()` round-trip (e.g. watchlist `onBlur`→`addAllowlist` while clicking an index toggle) make the second PUT overwrite the first field with stale data. The toggle buttons and inputs carry no `disabled={busy}`. Fix: send only `patch` (the server already merges per-field), and add `disabled={busy}` to the index toggles and watchlist/blocklist inputs (the `disabled:opacity-50` styling is already wired).

**Dual concurrent `/api/scan` fetches on every load** — `[Low][M]`
`DashboardApp` fetches `/api/scan` at mount for `tickerScan` (`216-229`) and `MarketScanView.refreshScan` fetches the identical endpoint (`1263-1280`); both fire in the same render cycle with no shared promise. The screener/enrichment layers are cached, but broker quotes/positions + the VWAP merge run twice. Fix: lift scan fetching into `DashboardApp` and pass `initialScan`/`scanLoading`/`onRefresh` down to `MarketScanView`.

**⌘K command palette is dead code** — `[Medium][S]`
`app/ui/command-palette.tsx` is fully built but imported nowhere; `dashboard-client.tsx:285` comments "Command K is temporarily disabled… Shortcut logic was removed." Worse, a live hint in `views.tsx:105` still tells users to "open the command palette → Run strategy once." Fix: either re-wire it (state + `metaKey/ctrlKey + 'k'` listener + mount + a `⌘K` header pill, wiring at minimum "Run strategy once" and "Refresh") or, if deferred, delete the stale hint so it stops pointing at an unreachable interaction.

**Strategy Flow edges render unthemed / low-contrast** — `[Medium][S]`
Seven edges are defined (`strategy-flow.tsx:80-88`) but `<ReactFlow>` (line 95) sets no `colorMode`, so the app's class-based dark theme never reaches the `--xy-*` variables — edges render in default light-gray (#b1b1b7), invisible on the near-white light canvas and unthemed on dark. Nodes 1/2/3 at y=50/150/250 (only 100px gap) overlap their ~110px height, the watermark is shown (no `proOptions`), and MiniMap colors are hardcoded light hex. Fix: pass `colorMode` (theme-aware) + `proOptions={{ hideAttribution: true }}`; add `.react-flow__edge-path { stroke: var(--line-strong); }` in `globals.css`; respread node y to 0/160/320; theme/remove the MiniMap.

**Macro default values impersonate live data** — `[Medium][S]`
`src/lib/macro.ts:63` returns `DEFAULT_MACRO` with no flag when no FRED key is set, and `asOf` is `new Date()…` (line 46) — so the panel shows "as of 2026-06-20" over stale 2024-era values, and the footnote (`macro-panel.tsx:244`) claims values are "computed… from free sources (FRED…)". The same silent fallback fires on FRED errors (line 124). Fix: add `isDefault: boolean` to `MacroData` (true in default/catch paths), change `asOf` to a non-date sentinel, and in the panel render a `Chip tone="warn">No FRED key — showing defaults` plus a conditional footnote.

### Information architecture & navigation

**Scan table clips the Score column and the sort indicator** — `[High][S]`
Score is the last of 18 default-visible columns (`SCAN_COLUMNS` ends with `sector`,`score`, ~1219-1220) and the default sort key (`{col:"score",dir:"desc"}`, 1238). The wrapper (`1372`) has no `overflow-x` and the shell is `overflow-x-hidden xl:overflow-hidden` (`504`), so on a 1440px display the ranking column and its `▼` are hard-clipped with no scrollbar — the table's organizing principle is invisible. Fix (do both): add `overflow-x-auto` to the wrapper; make Score a sticky-right column (or move it to position 2 after Symbol). Optionally trim a few low-signal columns to `defaultHidden`.

**Autonomy/run-state split across 3+ uncoordinated surfaces** — `[Medium][M]`
The header Mode dropdown (`548-555`), Run once (`601`), Start/Stop with a confirm modal (`617-631`), plus a *second* `strategyAuthority` select and an "Enable/Pause autonomy" button **without** the confirm guard inside Settings → Operate (`2353-2380`) all drive the same `policy` fields with no cross-reference. Two controls edit the same authority field with no hint they're linked, and the Settings autonomy toggle skips the safety dialog the header enforces. Fix: remove the duplicate authority select from Settings (replace with a read-only "change in toolbar" row), route the Settings autonomy button through the same `killConfirm` modal, rename header "Mode" → "Approval mode," and surface a read-only mode chip on narrow viewports where the dropdown is hidden.

**Strategy duplicated: tab vs Studio modal** — `[Medium][S/M]`
The Strategy tab shows a read-only prompt `<pre>` + "Edit in Studio" button + an editable Key-Parameters card + a full LLM-review card (`views.tsx:558,589,628`); Strategy Studio (`dashboard-client.tsx:2114-2146`) independently provides an editable prompt textarea + scoring weights + the *same* LLM-review card. Split authority over what's editable where. Minimal fix: delete the duplicate LLM-review card from the tab (`views.tsx:628-634`) so the Studio owns review; the tab keeps the read-only preview, risk params, and the single "Edit in Studio" entry point. Larger option: consolidate all editing into one surface.

**Header status cluster renders critical state as tiny unlabeled dots** — `[Medium][M]`
Autonomy ("Halted"/"Active"), Market session, and Execution mode are three equal-weight `text-[11px] text-muted` dot rows under the logo (`518-533`). "Halted" — the most safety-critical state — has the same visual weight as "Market Closed," and the execution mode is already shown in the full-width safety banner (`506-511`), making the third dot redundant. Fix: collapse to one prominent system-state pill (color-coded Active/Halted) + a small secondary market badge; drop the redundant execution-mode dot.

**Header groups navigation-openers with execution triggers** — `[Low][S]`
Refresh / Activity / Flow / Strategy / Settings / Theme / Run once / Start-Stop sit in one `flex gap-2` with no divider (`576-631`). The color-coded `primary`/`danger` variants do signal consequence in the ready state, but when `enableBlockedReason` is truthy "Run once" degrades to `ghost` and looks identical to the Flow/Strategy modal-openers. Fix: wrap the two execution buttons in a `border-l border-line pl-2 ml-1` sub-group.

### Market Scan & data tables

**Idle vs loading copy contradicts itself** — `[Low][S]`
The empty-state title branches on `scanLoading` correctly, but the `hint` is hard-coded to "Choose a base index… then refresh the scan" regardless (`dashboard-client.tsx:1304`), so during an active fetch the user sees "Scanning the market…" *and* an instruction to start the scan. Fix: branch the hint on `scanLoading` ("Fetching quotes and enrichment data…") and hide the "Configure universe" button while loading.

**TableVirtuoso blank-row flash on mount** — `[Low][S]`
No `overscan`/`initialItemCount` on the `TableVirtuoso` (`1373`); it measures the `h-[min(600px,65vh)]` container before first paint and briefly renders zero rows. (Note: the per-row `backdrop-blur-lg` perf attribution was *refuted* for the dashboard-client path — that class isn't on `TableRow` there; it *is* present in `views.tsx:245`.) Fix: add `overscan={600}` (and optionally `initialItemCount={Math.min(sorted.length,20)}`).

**Compound metric chips show an unlabeled 0–100 score** — `[Low][S]`
`SentimentChip`/`RatingChip` render `{label} {value}` → "Positive 64" / "Buy 84" (`components.tsx:100-109`), where the trailing number reads like part of the label. Per-cell tooltips already disclose the scale (`sentimentTitle`/`ratingTitle`), so this is purely chip-text ambiguity. Fix: insert a middle dot — "Positive · 64", "Buy · 84".

**Congress feed lacks base-rate context** — `[Low][S]`
SmartMoney panels show all-red SELL chips with no framing (`dashboard-client.tsx:1444-1476`); routine insider/congressional selling reads as universal alarm. The data is correct. Fix: add a one-line footnote ("SELL disclosures are routine — watch BUYs as the actionable signal") and/or sort BUYs first in `dashboard.ts:183`.

### Visual design, theming & motion

**Light-mode logo tile hides white-glyph logos** — `[Medium][S]`
`ticker-logo.tsx:43` uses `bg-surface-2/80`; in light mode `--surface-2` resolves to ~near-white, so transparent white-glyph PNGs (AAPL) vanish. Tile is the default display mode. Fix: `bg-gray-800 dark:bg-surface-2/80` on the tile branch (dark slate tile in light mode, existing surface in dark).

**`backdrop-blur` misapplied to table rows** — `[High→Low][S]`
`views.tsx:245` puts `backdrop-blur-lg` on every `<tr>` (no rest background → invisible effect, O(rows) compositing over the animated orbs); `dashboard-client.tsx:928` and `1381` put blur on `<tr>` elements where it's a CSS no-op (rows can't form a stacking context). Fix: remove blur from all `<tr>`s; keep panel-level blur on `Card` and sticky `<thead>` only.

**Animated orbs over-saturate light mode** — `[Low][S]`
`body::before`/`::after` (`globals.css:114-128`) run at 0.9/0.7 opacity with 30%/15% color-mix in *both* themes; against light `--bg` the accent-green + blue (and a red `--down` orb at `circle 85% 85%`, behind the content area) cast a visible tint that washes out cards. Fix: lower light-mode opacities (e.g. 0.4/0.25) with a `.dark` override to restore current dark intensity; swap the `--down` orb for a neutral indigo or drop the second orb.

**Settings/Flow modal jumps vertically on tab switch** — `[Medium][S]`
`overlays.tsx:82` centers with `items-center justify-center`; the dialog (`103`) has only `max-h-[92dvh]`, no `min-h`, so switching between tall (Operate) and short (Notifications/Display) tabs reflows the center and shifts the whole frame. Fix (single line, benefits all modals): either anchor with `items-start pt-[10vh]`, or add `min-h-[min(520px,80dvh)]` to the inner dialog.

**Score cell is visually under-weighted vs Sentiment/Rating chips** — `[Low][S]` (nice-to-have)
Score renders as plain bold text while Sentiment/Rating render as colored chips, so the primary signal is the quietest cell. Fix: add a small score-tier dot/inline bar (≥70 green / 55-70 amber / <55 red).

### Copy, terminology & accuracy

**No product-level financial disclaimer** — `[Medium][S]`
The only "not advice" strings are Tax-scoped (`1589/1594`, `2420`, `views.tsx:417`); the Decision tab proposes/auto-executes orders with Approve/Reject and no informational disclaimer. Fix: add one persistent line on the Decision PanelHeader ("For informational use only — not investment advice. Past signals and simulated results do not guarantee future performance") and a Brokerage-mode notice in Settings.

**Macro sparkline coloring is financially misleading** — `[Medium][S]`
`TrendsSection` applies `up = last >= first` → green to *all six* series including VIX and HY spread (`macro-panel.tsx:86-98`), even though the static risk tiles in the same file already encode correct polarity (lines 207/210). Fix: add a `polarity` field per series (VIX/HY = `-1`, yields/USD/WTI = neutral gray) and invert/neutralize the display color accordingly.

**USD-index label invites DXY confusion** — `[Medium][S]`
The tile is labeled just "USD index" (`macro-panel.tsx:228`) for the `DTWEXBGS` broad index (~119), which users will misread as DXY (~100). Fix: relabel "Broad USD (DTWEXBGS)" and clarify the tooltip ("NOT the DXY"). Pair with the default-data flag above.

**Settings subtitle misnames its tabs** — `[Low][S]`
`subtitle="Risk, tax & notifications"` (`766`) names only 2 of 6 tabs (Operate/Display/API Keys/Tax/Tuning/Notifications). Fix: relabel to reflect the real set or drop the subtitle; reconcile the two divergent tab definitions (see IA finding below).

**Two `SettingsContent` implementations diverge; Risk tab unreachable** — `[Medium][M]`
`settings.tsx:43-362` exports a `SettingsContent` (tabs include "Risk & Limits") that is never imported — dead code — while the live inline `SettingsContent` (`dashboard-client.tsx:2190`) has "Display" but no Risk tab, so risk limits are reachable only from the Strategy tab, not the gear icon. Fix: delete the dead `settings.tsx` `SettingsContent`, add a Risk tab to the live one (reusing the `EditableParam` controls from `views.tsx:599-614`), and correct the subtitle.

**Decision empty-state says "Choose an account" when Test is always active** — `[Low][S]`
`dashboard-client.tsx:1090` hint says "Choose an account and tradable universe…" but `ensureTestAccount` always sets `accountNumber="TEST"`. The cleaner `views.tsx:105` copy is never rendered (dead file). Fix: drop the "account" clause; mirror the Run-only wording.

**Tuning tab exposes source-file paths** — `[Low][S]`
`settings.tsx:324` shows literal `docs/phase-9-web-sources.md` and `src/lib/market.ts` in user-facing prose. Fix: replace with "see the project README."

**Misread debunked: "No account selected" red box** — `[Low][S]`
No such string exists; the real guard fires on *empty universe* and uses amber `border-warn`, not red (`450-454`, `2378-2379`). The only genuine bug is the divergent Decision empty-state copy (above) and the "before enabling autonomy" framing on the universe blocker — tighten both.

### Accessibility & responsive

**No `prefers-reduced-motion` support** — `[High][S]`
Four perpetual CSS animations (`orb1` 24s, `orb2` 28s, `shimmer` 1.4s, `pulse-fast` 1s) and all Motion transitions run unconditionally; zero `@media (prefers-reduced-motion)` blocks. The full-viewport orbs are a known vestibular trigger. Fix: add a reduced-motion media block setting `animation: none` on `body::before/::after`, `.skeleton::after`, `.animate-pulse-fast`; add `useReducedMotion()` to `overlays.tsx` and `command-palette.tsx` to zero out durations.

**Tabs missing `aria-controls`/`tabpanel` wiring** — `[High][S]`
`primitives.tsx:208-234` produces `role="tab"` buttons with no `id`/`aria-controls`; the seven workspace panels (`dashboard-client.tsx:666`) are plain `<div>`s with no `role="tabpanel"`/`aria-labelledby`. Fix: add `id`/`aria-controls` to the tab buttons and `role="tabpanel" id aria-labelledby tabIndex={0}` to the panel wrapper (additive attributes only).

**Command palette has no dialog role or focus trap** — `[High][S]`
`command-palette.tsx:82` renders a `motion.div` with no `role="dialog"`, `aria-modal`, `aria-label`, or `useDismissable` trap (unlike Modal/SlideOver). Fix: export `useDismissable` from `overlays.tsx`, apply it, and add the dialog ARIA attributes. (Resolve alongside the dead-code re-wiring.)

**Two header `<select>`s have no accessible name** — `[Medium][S]`
Mode (`548`) and Account (`558`) selects have only sibling-`<span>` text. Fix: add `aria-label="Approval mode"` / `aria-label="Active account"`.

**Activity button doesn't announce its pending-count badge** — `[Medium][S]`
Raw `<button>` (`580`) with a count `<span>` (`585`) that has no `aria-live`/`aria-label`, so screen readers never announce the live pending-approval count. Fix: dynamic `aria-label` on the button + `aria-live="polite"` on the badge.

**Column-picker dropdown lacks `aria-expanded`/role/Escape** — `[Medium][S]`
Trigger has no `aria-expanded`/`aria-haspopup`; the dropdown (`1342`) has no `role` and no Escape handler (native checkboxes are still Tab-operable). Fix: add `aria-expanded`/`aria-haspopup="listbox"`, `role="listbox"`, and an Escape handler that restores focus to the trigger.

**SlideOver is full-viewport on mobile with no touch-dismiss** — `[Medium][S]`
`overlays.tsx:168` uses `w-full` with a `max-w-*` that's never reached at 375px, so the panel covers the whole screen leaving no backdrop strip, and the backdrop only has `onMouseDown` (no touch). Fix: cap width with `max-w-[calc(100vw-48px)] sm:max-w-none` and add `onTouchEnd={onClose}` to the backdrop.

**Scan table has no horizontal scroll on mobile** — `[Medium][S]` (same root as priority #1)
`overflow-x-hidden` shell + no `overflow-x-auto` wrapper clips 18 `whitespace-nowrap` columns at phone widths. `RunHistory` already uses `overflow-x-auto` — apply the same here.

**Portfolio rail hidden below xl (1280px)** — `[Medium][S]`
`aside` is `hidden xl:block` (`637`); tablets (768–1279px) see only a 3-field summary — no donut, position list, or equity curve. The summary's P&L uses `pnl >= 0` (green-at-zero) too. Fix: lower the breakpoint to `lg`, and apply the zero-neutral P&L fix.

**Header wraps to 2–3 rows on small screens** — `[Medium][L]`
`flex-wrap` header with 9+ always-visible controls consumes ~120-160px before content at 375px. Fix: move low-priority controls into a mobile hamburger/popover below `lg`; keep logo, one status pill, account select, Start/Stop.

**Full-screen modals lack mobile fallback** — `[Medium][S]`
Strategy Flow (`size="full"`) renders a React Flow canvas with no touch config; non-responsive `p-4` on the backdrop. Fix: `p-2 sm:p-4`; hide/disable the Flow trigger below `md` or add touch props.

**Danger-button text fails AA contrast in dark mode** — `[Low][S]`
`text-white` on `bg-down` (`#fb5e74` dark) ≈ 4.07:1, below 4.5:1 (`primitives.tsx:14`, `overlays.tsx:230`). Light mode and the Activity badge pass. Fix: add `--down-fg` tokens (white light / near-black dark) and use `text-down-fg`.

**`--faint` helper text fails AA against the page background** — `[Medium][S]`
Light `--faint` `#637489` on `--bg` `#eef1f5` ≈ 4.22:1 (fails for the many 9–11px labels). Fix: darken `--faint` to ~`#546070`; raise the 9px StatusPill/DailyRiskPill labels (`811`,`822`) to ≥11px.

**Input focus relies on cascade-layer luck** — `[Low][S]`
`inputClass` uses `outline-none` + `focus:border-accent` (`primitives.tsx:260`); the global `:focus-visible` outline does win via unlayered cascade, so it's not broken, but it's inconsistent with the button primitive. Fix: align inputs to `focus-visible:outline-2 outline-accent outline-offset-2`.

## Quick wins (<1h, visible polish)

- Insert `· ` in Sentiment/Rating chips: "Positive · 64" (`components.tsx:100-109`).
- Branch the scan idle/loading hint on `scanLoading` (`dashboard-client.tsx:1304`).
- Add `aria-label` to the Mode and Account selects (`548`,`558`).
- Add `overflow-x-auto` to the scan-table wrapper (`1372`).
- Remove `backdrop-blur` from all `<tr>` elements (`views.tsx:245`, `dashboard-client.tsx:928,1381`).
- Add the `prefers-reduced-motion` media block to `globals.css`.
- Special-case `=== 0` in `signedMoney` (`dashboard-widgets.tsx:14`).
- Fix the light-mode logo tile background (`ticker-logo.tsx:43`).
- Relabel USD-index tile "Broad USD (DTWEXBGS)" (`macro-panel.tsx:228`).
- Remove `[CALCULATED]` tooltip prefixes from column titles (`dashboard-client.tsx:1173-1197`).
- Fix the Settings subtitle and the Decision "Choose an account" hint.
- Add `overscan={600}` to TableVirtuoso (`1373`).

## Lower-priority / nice-to-have

- **Scope SVG gradient ids with `useId()`** in `charts.tsx:30` — currently global `equity-fill`; latent collision if `EquityCurve` ever renders twice.
- **Unify glassmorphism blur tiers** — inner cards use `backdrop-blur-lg`/`surface-2/50` while outer `Card` uses `backdrop-blur-sm`/`surface/80`, inverting the depth hierarchy. Standardize: panels `-sm`, floating surfaces `-md` max, overlays `-xl`.
- **Add an `accent` active-state to Segmented controls** (`primitives.tsx:178`) — neutral selected vs unselected is near-invisible in light mode; add `shadow-sm ring-1`.
- **Win-rate StatTile has no tone** (`views.tsx:367`) — apply `winRate>=50?'up':winRate>0?'warn':'neutral'`.
- **Congress column shows "0" for mixed activity** (GS: 6 buy/5 sell) — render "±N" or "MIX" so the tooltip detail is discoverable.
- **Persistent sort affordance** — show a faint `↕` on inactive sortable headers (`1379-1388`).
- **"· live" overstates freshness** — quotes are stale/delayed; use "· refreshed" + "· prices delayed" when the market is closed (`1316`).
- **"Technology · Technology"** dedup in the drilldown (`symbol-drilldown.tsx:116`).
- **Mode-label copy mismatch** — header "Propose → you approve" vs Settings "LLM proposes — you approve"; standardize.
- **Safety banner all-caps** swallows the explanatory sentence — reserve caps for the mode prefix (`506`).
- **Leaked internal identifiers** — "test/local" (`execution-mode.ts:53,110`) and a stale `Mock\/Local` regex missing `Test` (`dashboard-client.tsx:2713`).
- **Decision subtitle is an imperative, not a description** (`1081`) — use "Agent reasoning and trade proposals" and keep the instruction in the EmptyState.
- **Modal `aria-label` double-announce** — switch to `aria-labelledby` pointing at the `<h3>` (`overlays.tsx:94-111`).
- **SSE staleness indicator** — 120s fallback poll with a no-op `onerror`; add a "last updated Xm ago" badge that ambers after ~3 min.
- **Empty-universe scan returns 200** indistinguishable from "no data" — short-circuit to the configure state or refine the subtitle to "No symbols configured."

## What's already strong (don't change)

- **Dark theme** is clean, consistent, and readable — the core visual identity is good; the issues are light-mode-specific.
- **Primitives are well-built:** `IconButton` sets `aria-label`; Tabs has roving tabIndex + arrow-key nav; `Modal`/`SlideOver` use `useDismissable` (Tab-trap + Escape + focus restore) with `role="dialog" aria-modal`.
- **Per-cell data provenance is excellent** — `cellTitle`/`sentimentTitle`/`ratingTitle` give real, row-specific tooltips with headline/source detail; don't undo this.
- **Honest enrichment cascade** — real-data-or-`-`/`n/a`, no synthetic mock tier; "n/a" vs "-" semantics are deliberate and correct.
- **Static macro risk tiles** already encode correct financial polarity (VIX backwardation, HY spread) — the Trends sparklines just need to match them.
- **The `neutral` tone already maps to `text-fg`** — the zero-value fix needs no new tokens.
- **`RunHistory` horizontal-scroll pattern** is the right model — reuse it for the scan table.
- **Server-side per-field policy guards** already support patch-only PUTs — the race fix is purely client-side.

## Notes & false positives

- **Refuted — per-row blur as the F3 perf cause (dashboard-client path):** `TableRow` in `dashboard-client.tsx:1378` does **not** carry `backdrop-blur-lg`; the blank-row flash there is virtualization measure-before-paint, not per-row compositing. The blur-on-`<tr>` issue is real but is dead/no-op CSS (rows can't form a stacking context) and lives at `views.tsx:245` + the header `<tr>`s. A cited "`app/ui/views.tsx:245`" path does not exist (correct path is `app/ui/dashboard/views.tsx`).
- **Refuted — "No account selected" red error box:** that exact string exists nowhere; the real guard is empty-universe and amber, not red. Treated as a dossier misread.
- **Refuted/overstated — input focus suppression:** `outline-none` does **not** kill the focus ring; the unlayered global `:focus-visible` wins via CSS cascade-layer order. Downgraded to a consistency nit.
- **Overstated — danger-button & badge contrast:** light-mode danger (`#e11d48`) and the Activity badge (`text-black` on `#c2740a`) both pass AA; only **dark-mode** `text-white` on `#fb5e74` fails. `--faint` passes on pure white but fails on the actual `--bg`.
- **Severity adjustments from the verifiers:** dead command palette and the `<tr>` blur were downgraded from High to Low/Medium (no user-facing breakage); the Score-clip and reduced-motion/ARIA findings were confirmed at High.
- **Coverage boundary (not inspectable live, source-only):** mobile/responsive behavior (375px header wrap, SlideOver width, portfolio-rail breakpoint) was assessed from CSS, not a real device; the ⌘K palette, the Accounts modal, the full Strategy Studio flow, and a live LLM-generated Decision could not be exercised at runtime (the palette is unmounted; the Decision/LLM loop requires `OPENAI_API_KEY`). Findings on those are code-grounded but unverified in a running session. Some scan values (all 30 quotes `stale: true`, the 7-vs-2 congress sell skew) are real after-hours/disclosure data, not seeded-test noise — confirmed against `scan.json`.
# Appendix B — iPad & iPhone (mobile) audit (full report)

# Agentic Trading — iPad & iPhone (mobile) audit

## Executive summary

**Is this app usable on an iPhone today? Marginally — with two outright broken surfaces.** A user can open the dashboard, read the mobile portfolio summary, and navigate most tab content. But the two surfaces a trader actually needs on a phone — the **Market Scan table** and the **Settings panel** — are both broken at iPhone widths, and *every single form field triggers an involuntary iOS zoom on focus*. The shell, header, and chrome were built for a desktop "cockpit" that only engages at `xl` (1280px); everything below that falls back to a scrolling shell that received far less responsive attention.

**The three highest-leverage mobile fixes** (all small, all high-confidence):
1. **Bump form inputs to 16px below `sm`** — one CSS block in `globals.css` kills the iOS auto-zoom that fires on *every* input/select/textarea in the app. This is the single most pervasive defect and the cheapest fix.
2. **Give the Market Scan table a real horizontal-scroll affordance** (and surface the `SCORE` column) — today the table's columns are silently clipped, not scrollable, on every sub-1280px viewport. The default sort key is off-screen with no hint it exists.
3. **Wrap the Settings tab bar in `overflow-x-auto`** — three of six tabs ("Tuning", "Notifications", and part of "API Keys") are unreachable at 390px.

**Confidence: high, with one explicit caveat.** Live device emulation was impossible (the test harness pinned the render viewport at 1438px), so **no finding below was observed on a physical iPhone or iPad.** Every finding is instead grounded in the source — Tailwind breakpoint classes, fixed pixel widths, `whitespace-nowrap`, missing `overflow-x`, and `font-size` values are *deterministic*: they resolve the same way in iOS Safari as anywhere else, so layout/overflow/zoom conclusions are reliable. The lower-confidence band is **runtime behavior** that CSS alone can't fully predict — exact wrap-row counts, TableVirtuoso's internal scroller behavior, touch-gesture arbitration between the chart and the page scroller, and real-device GPU/battery cost of the animated background. Those are flagged as such in Coverage.

---

## iPhone (priority)

Findings ranked for ~390px portrait (iPhone 14/15/16 baseline), with landscape noted where it changes the picture.

| # | Issue | Severity | Effort | Files |
|---|-------|----------|--------|-------|
| 1 | All inputs/selects/textareas <16px → iOS auto-zoom on every focus | High | S | `app/ui/primitives.tsx`, `app/dashboard-client.tsx`, `app/ui/dashboard/settings.tsx`, `app/ui/dashboard/components.tsx` |
| 2 | Market Scan table silently clipped; `SCORE` (sort key) off-screen, no scroll affordance | High | M | `app/dashboard-client.tsx`, `app/ui/dashboard/views.tsx`, `app/ui/dashboard/utils.tsx` |
| 3 | Settings 6-tab bar overflows/clips at 390px — tabs unreachable | High | S | `app/dashboard-client.tsx`, `app/ui/primitives.tsx`, `app/ui/dashboard/settings.tsx` |
| 4 | Tap targets below iOS 44pt (close ×, icon buttons, tab pills, ticker-remove chips) | High | M | `app/ui/overlays.tsx`, `app/ui/primitives.tsx`, `app/ui/theme.tsx`, `app/ui/dashboard/settings.tsx` |
| 5 | Header control cluster wraps to 3–4 rows, eating ~120–200px of viewport | High | M | `app/dashboard-client.tsx` |
| 6 | Symbol drilldown header: company name vs price block collide, no truncation | Medium | S | `app/ui/symbol-drilldown.tsx` |
| 7 | Price chart touch-pan steals page scroll; timeframe buttons ~18px tall | Medium | S | `app/ui/price-chart.tsx` |
| 8 | Workspace tab bar (7 tabs) scrolls but with no visual cue of hidden tabs | Medium | S | `app/dashboard-client.tsx`, `app/ui/primitives.tsx` |
| 9 | No safe-area insets (landscape notch encroachment; toaster/home-indicator clearance) | Medium | S | `app/layout.tsx`, `app/globals.css`, `app/ui/overlays.tsx`, `app/ui/symbol-drilldown.tsx` |

### 1. Form inputs trigger iOS auto-zoom (High / S)
iOS Safari zooms the viewport whenever a focused form control has `font-size < 16px`. The shared `inputClass` (`app/ui/primitives.tsx:260`) is `text-sm` = **14px**, and it propagates to 20+ `<input>`/`<select>`/`<textarea>` across `settings.tsx` and `dashboard-client.tsx`. Worse offenders: the strategy `<textarea>` overrides *down* to `text-[13px]` (`dashboard-client.tsx:2125`, `settings.tsx:838`); the header account `<select>` is `text-sm` (`dashboard-client.tsx:559`); the `NumberField` input is `text-sm` (`app/ui/dashboard/components.tsx:220`). The header Mode `<select>` is `text-xs`/12px (`dashboard-client.tsx:549`) but is hidden below `md` so it's exempt on iPhone. Result: every form interaction zooms the page in, and the user must manually pinch-out to recover — on *every field*.

**Fix (one CSS block, covers all surfaces):**
```css
/* app/globals.css */
@media (max-width: 640px) {
  input, textarea, select { font-size: 16px !important; }
}
```
This fires only below `sm`, so desktop/iPad keep 14px density. It also sweeps up the one-off `text-xs`/`text-[13px]` offenders without hunting each call site.

### 2. Market Scan table clipped, `SCORE` off-screen (High / M)
The table defaults to **18 visible columns** (12 of 30 `SCAN_COLUMNS` carry `defaultHidden: true` — `app/ui/dashboard/utils.tsx`). Every header is `whitespace-nowrap`, so the intrinsic table width exceeds 1000px. The overflow chain has **no horizontal scroll anywhere**: the Card is `overflow-hidden` (`dashboard-client.tsx:1324`; mirror at `views.tsx:206`), the inner wrapper `h-[min(600px,65vh)] p-2` has no `overflow-x` (`dashboard-client.tsx:1372`; `views.tsx:239`), and the shell root is `overflow-x-hidden` (`dashboard-client.tsx:504`). For a standard vertical `TableVirtuoso` the internal scroller applies `overflowY: auto` only — **not** `overflowX` — so columns past the first few are *silently clipped, not scrollable*. The default sort key `SCORE` is the **last** column (`useState({ col: "score", dir: "desc" })`, `dashboard-client.tsx:1238`) and is definitively off-screen, so the user sees an apparently-unsorted table with no hint more columns exist.

**Fix (priority order for iPhone):**
1. **Move `score` to column index 1** (after `symbol`) in `SCAN_COLUMNS` — costs nothing, guarantees the sort key is always visible.
2. **Enable horizontal scroll:** drop `overflow-hidden` from the Card and put `overflow-x-auto` on the scroll wrapper (move `p-2` to a non-scrolling parent so padding doesn't accumulate inside the scroll area). The root `overflow-x-hidden` does *not* block inner `overflow-x-auto`, so this works.
3. **Add a right-edge scroll-shadow** to signal hidden columns: wrap in `relative` + `after:absolute after:inset-y-0 after:right-0 after:w-8 after:bg-gradient-to-l after:from-surface after:to-transparent after:pointer-events-none`.
4. *(Optional, M)* a `< sm` compact column preset (symbol, score, price, chg, sentiment) so iPhone needs no scrolling at all.

### 3. Settings 6-tab bar clips at 390px (High / S)
Both `SettingsContent` definitions render a 6-tab `<Tabs>` (Operate, API Keys, Tax/Risk, Tuning, Notifications, …) — `dashboard-client.tsx:2245` and `app/ui/dashboard/settings.tsx:93`. The `Tabs` primitive is `inline-flex … p-1` with **no `flex-wrap`, no `overflow-x-auto`** (`primitives.tsx:208`). Six `px-3 py-1.5 text-[13px]` buttons total ~470–540px vs ~318–334px content width inside the modal (`p-4` wrapper + `p-5` body). The rightmost tabs ("Tuning", "Notifications") are clipped/scroll-trapped with no affordance. Note the **workspace** tabs already do this correctly (`overflow-x-auto` wrapper at `dashboard-client.tsx:645`) — the Settings tabs are the missing case.

**Fix:** wrap each Settings `<Tabs>` call site in `<div className="overflow-x-auto">`, matching the workspace pattern. Apply at both `dashboard-client.tsx:2245` and `settings.tsx:93`. Optionally shorten labels ("Notifications"→"Notify", "API Keys"→"Keys"). Keep the per-callsite wrapper rather than editing the primitive, so centered desktop usages aren't affected.

### 4. Tap targets below iOS 44pt (High / M)
None of these carry a responsive size bump, and since the cockpit only engages at `xl`, every iPhone session uses these exact undersized controls:
- Modal/SlideOver close `×`: `h-8 w-8` = **32px** (`overlays.tsx:118, 185`)
- `IconButton` (refresh/settings), `ThemeToggle`: `h-9 w-9` = **36px** (`primitives.tsx:44`, `theme.tsx`)
- `Tabs` buttons: `py-1.5` → ~**28–32px** tall (`primitives.tsx:226`)
- `Segmented` buttons: `py-1` → ~**24px** (`primitives.tsx:185`)
- **Ticker-remove chips: `py-0.5 text-xs` → ~20px** (`settings.tsx:145, 169`) — the worst offender, and a mis-tap edits the watchlist.

**Fix (centralize in primitives):** `IconButton`/`ThemeToggle` → `h-11 w-11`; close buttons → `h-11 w-11`; `Tabs` → add `min-h-[44px]`; `Segmented` → `min-h-[36px]`; ticker chips → `py-2 min-h-[44px]` (or split label/X so the X is its own 44px hit area). Add `touch-manipulation` to `buttonBase` (`primitives.tsx`) to kill the 300ms tap delay.

### 5. Header wraps to 3–4 rows (High / M)
The header is `flex … flex-wrap` with `xl:flex-nowrap` (`dashboard-client.tsx:513`) — wrapping is always on below 1280px. After the two controls correctly hidden on mobile (Mode `hidden md:flex`; Universe/DailyRisk pills `hidden lg:flex`), the remaining ~8 right-cluster controls (account select, Refresh, Activity, Flow, Strategy, Settings, Theme, Run once, Start/Stop — `dashboard-client.tsx:542–632`) total ~570px and wrap into 3–4 sub-rows, pushing the effective header to ~120–200px (a quarter to a third of the viewport) before any content shows.

**Fix:** collapse secondary controls (Flow, Strategy, Settings, ThemeToggle) behind a single overflow `…` IconButton/popover below `sm`; keep account select + Refresh + Activity + Run once + Start/Stop visible. Collapse "Run once" to icon-only at xs. This drops the header to ~2 rows / <100px. `xl:flex-nowrap` already protects desktop, so no regression risk.

### 6. Symbol drilldown header collision (Medium / S)
The drilldown header is `flex items-center gap-4` with no breakpoint variants (`symbol-drilldown.tsx:111`). The `flex-1` name div lacks `min-w-0`/`truncate` (`:113–114`) and the sector/industry line has no truncation (`:115`); the `text-right` price block has no min-width. At ~342px content width, a long name ("Berkshire Hathaway Inc.") fights the price block and overflows — silently clipped by the shell's `overflow-x-hidden`.

**Fix:** add `min-w-0` to the name div and `truncate` to the `<h2>` and sector line. For very narrow screens, stack: `flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4`, letting price sit below name below `sm`.

### 7. Price chart touch + tiny timeframe buttons (Medium / S)
`PriceChart` is a fixed `h-[300px]` inside the scrollable drilldown (`price-chart.tsx:248`). Lightweight Charts v5 enables touch-scroll-to-pan by default and **no `handleScroll` is set** (`price-chart.tsx:137–145`), so a vertical swipe starting inside the canvas pans the time axis instead of scrolling the page. The six timeframe buttons are `px-2 py-0.5 text-[11px]` → ~18px tall (`price-chart.tsx:222`), far below 44pt. (Note: `handleScale.axisPressedMouseMove: false` is *already* set — that part is handled.)

**Fix:** add `handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false }` so vertical drags return to the page scroller while horizontal time-pan stays. Bump timeframe buttons to `min-h-[44px] px-3` (and `gap-0.5` to avoid mis-taps). Crosshair-on-touch is cosmetic; defer.

### 8. Workspace tab bar — no hidden-tab cue (Medium / S)
The 7-tab workspace bar (`dashboard-client.tsx:645`) *is* wrapped in `overflow-x-auto`, so tabs ~560px wide are reachable by swipe at 366px — content is **not** clipped. The real gap is discoverability: no partial-tab peek, no scroll cue, no auto-scroll-active-into-view. A user on "Decision" may never learn Macro/Performance/Tax/Strategy exist.

**Fix:** shorten the longest labels (Market Scan→Scan, Performance→Perf, Assistant→Chat, Strategy→Strat) to fit ~7 tabs at 390px, and/or auto-scroll the active tab into view on mount. Low effort, low risk.

### 9. Safe-area insets (Medium / S)
No `viewport-fit=cover`, no `env(safe-area-inset-*)` anywhere (`app/layout.tsx` has no `viewport` export; grep finds zero `safe-area`/`env(safe`/`viewport-fit`). In **portrait**, iOS Safari constrains content to the safe rectangle, so nothing is literally hidden — this is why severity is Medium, not High. The real exposure is **landscape iPhone**, where left/right notch insets are non-zero and ignored, so the safety banner (`dashboard-client.tsx:507`) and SlideOver header (`overlays.tsx:172`, `top-0`) can encroach on the camera cutout. The toaster's 16px bottom offset (`layout.tsx:20`) gives less clearance than the 34px home indicator.

**Fix:** add `export const viewport = { viewportFit: 'cover' }` to `layout.tsx`, then `padding-top/bottom/left/right: env(safe-area-inset-*)` on `body` in `globals.css`; `pt-[max(1rem,env(safe-area-inset-top))]` on the SlideOver header; `pb-[max(6rem,env(safe-area-inset-bottom))]` replacing the hardcoded `pb-24` at `symbol-drilldown.tsx:109`.

---

## iPad

The defining iPad problem is the breakpoint choice: **the fixed cockpit shell only engages at `xl` = 1280px, which excludes every iPad in every orientation.**

**iPad gets the phone shell (Medium / S).** The shell elements are all `xl:`-gated with **no `lg:` tier**:
- root `xl:h-dvh xl:overflow-hidden` (`dashboard-client.tsx:504`)
- grid `xl:grid-cols-[320px_minmax(0,1fr)]` (`:636`)
- PortfolioRail aside `hidden xl:block` (`:637`)
- MobilePortfolioSummary `xl:hidden` (`:642`)
- content `xl:overflow-auto` (`:666`)

So iPad **landscape** (1024–1194px: iPad mini 6, Air 5, standard, Pro 11") falls between `lg` and `xl` and gets the single-column scrolling shell — the 320px PortfolioRail with `AllocationDonut` and the positions table is **invisible**, replaced by the 3-field `MobilePortfolioSummary`. No data is unreachable (it's a UX regression, not a breakage), hence Medium, but it wastes the entire landscape width.

**Recommendation — introduce an `lg` tablet tier.** Change the five shell classes from `xl:` → `lg:` (plus `main`'s `xl:min-h-0`→`lg:min-h-0` at `:641`). This activates the full cockpit at 1024px, giving iPad landscape the rail and two-column grid. iPad **portrait** (~820px) stays below `lg` and keeps the scrolling shell, which is appropriate for that width. Internal content grids (`lg:grid-cols-2` in tab views) are unaffected.

**Market Scan table also clipped on iPad (High / S).** Same root cause as iPhone finding 2: at 820px portrait the 18-column table overflows by ~185px and is clipped, not scrollable (`views.tsx:206, 239`; `dashboard-client.tsx:504`). The fix is identical (`overflow-x-auto` on the wrapper). Note `RunHistory` already uses `overflow-x-auto` (`views.tsx:706`) — the pattern is known, just not applied here.

**Settings tabs clip in Split View / Slide Over (Medium / S).** At iPad Split View ~507px the 6-tab bar overflows by ~35px ("Notifications" clipped); at Slide Over ~320px it's as bad as iPhone. Same fix as iPhone finding 3. At full-screen iPad portrait (820px) the tabs fit and there's no issue.

**Reduced-motion / older-iPad perf (Medium / S).** The animated mesh gradient (`globals.css:94–128`, two `position: fixed` 120%-viewport pseudo-elements at 24s/28s) has no `prefers-reduced-motion` guard, and there are 59 `backdrop-blur` usages. On A12/A13 iPads this is real frame-drop/battery pressure. See iOS Safari section for the fix.

---

## iOS Safari correctness

- **Safe-area insets:** entirely absent (no `viewport-fit=cover`, no `env()`). Portrait is auto-protected by Safari; landscape notch zones and home-indicator clearance are not. Fix per iPhone finding 9.
- **dvh vs vh:** **handled well.** The shell uses `min-h-dvh` / `xl:h-dvh` and the modal uses `max-h-[92dvh]` — correct for the iOS URL-bar resize. One stray: `app/global-error.tsx:9` uses inline `minHeight: '100vh'` → change to `100dvh` (one char; error page only, low priority).
- **Input zoom (<16px):** the most pervasive defect — every input/select/textarea is 12–14px. Fix per iPhone finding 1.
- **Tap targets:** multiple controls at 20–36px vs the 44pt minimum; ticker-remove chips (~20px) are the most dangerous. Fix per iPhone finding 4. Add `touch-manipulation` globally to drop the 300ms delay.
- **Hover-only affordances:** several states have no touch/at-rest equivalent — scan table rows rely on `hover:bg-surface-2/50` + `cursor-pointer` (`dashboard-client.tsx:1378`); command palette uses `onMouseEnter` to set the active row (`command-palette.tsx:108`); `SymbolButton` chip variant reveals interactivity only on `hover:` (`dashboard-client.tsx:1016`); and HTML `title` tooltips (e.g. congress member full name, `dashboard-client.tsx:1453`) are **inaccessible on iOS** entirely. Add `active:`/`focus:` equivalents, an `onTouchStart` for the palette, and a persistent (non-hover) underline for the chip; don't rely on `title` for truncated content.
- **backdrop-blur / mesh-gradient perf:** 59 `backdrop-blur` instances plus two always-on fixed animated gradient layers, no reduced-motion guard. Add to `globals.css`:
  ```css
  @media (prefers-reduced-motion: reduce) {
    body::before, body::after { animation: none; }
    .skeleton::after { animation: none; }
    .animate-pulse-fast { animation: none; }
  }
  ```
  Optionally also `animation: none` on the orbs below `640px` to cut continuous compositing on phones where the effect is barely visible.
- **Native `<select>`:** several `<select>` use `text-sm`/`text-xs` — covered by the input-zoom fix. No custom dropdown shim is needed; native iOS pickers are fine once font-size ≥16px.

---

## Recommended responsive plan

### Quick wins (S) — do these first; they retire most of the high-severity risk
1. **16px inputs below `sm`** — one `@media (max-width:640px)` block in `globals.css`. (Kills auto-zoom everywhere.)
2. **`overflow-x-auto` on the Market Scan wrapper** + remove the Card's `overflow-hidden`, in **both** `dashboard-client.tsx:1372/1324` and `views.tsx:239/206`. **Move `score` to column index 1.**
3. **Wrap Settings `<Tabs>` in `overflow-x-auto`** at `dashboard-client.tsx:2245` and `settings.tsx:93`.
4. **Lower the cockpit shell `xl:`→`lg:`** (6 classes around `dashboard-client.tsx:504–666`) — gives iPad landscape the full layout.
5. **Add `prefers-reduced-motion` guard** + optional phone-disable for the mesh gradient in `globals.css`.
6. **Safe-area:** add `viewport = { viewportFit: 'cover' }` to `layout.tsx`, `env()` padding on `body`, and on SlideOver header / drilldown bottom.
7. **`global-error.tsx`** `100vh`→`100dvh`.
8. **Shorten workspace + Settings tab labels** so they fit at 390px.

### Larger (M/L)
9. **Tap-target pass** in primitives — `IconButton`/`ThemeToggle`/close → `h-11 w-11`; `Tabs` `min-h-[44px]`; `Segmented` `min-h-[36px]`; ticker chips `py-2 min-h-[44px]`; add `touch-manipulation` to `buttonBase`. (M — touches shared primitives, needs a desktop density check.)
10. **Collapse the header into an overflow menu below `sm`** — move Flow/Strategy/Settings/Theme behind a `…` popover; icon-only "Run once". (M)
11. **Mobile column preset for Market Scan** (`< sm`: symbol, score, price, chg, sentiment) so the table needs no horizontal scroll at all; optional sticky `symbol` column. (M)
12. **Chart touch handling** — `handleScroll.vertTouchDrag: false` + 44px timeframe buttons. (S, but library-behavior dependent → verify on device.)
13. **Hover→touch affordance sweep** — `active:`/`focus:` states, palette `onTouchStart`, drop `title`-only tooltips. (M)
14. *(v2)* surface `AllocationDonut` + a collapsible positions list inside `MobilePortfolioSummary` so phone users get allocation/per-position P&L without the Performance tab. (L)

**Suggested breakpoint strategy going forward:** `< sm (640)` = phone (single column, 16px inputs, card/compact tables, overflow header menu, 44pt targets); `sm–lg` = large phone / iPad portrait (multi-column forms, scrollable tables with affordance); `lg (1024)+` = tablet-landscape/desktop cockpit (fixed shell + portfolio rail). The key move is retiring `xl`-only as the sole shell breakpoint in favor of an `lg` tier.

---

## What's already mobile-friendly

Credit where due — several things were done right:
- **Viewport meta is present** (Next.js default `width=device-width, initial-scale=1`), so there's no fixed-width-desktop catastrophe; the page reflows.
- **dvh used correctly** for the shell (`min-h-dvh`/`xl:h-dvh`) and modal (`max-h-[92dvh]`) — avoids the classic iOS `100vh` URL-bar jump. Only the error page regresses.
- **Root `overflow-x-hidden`** prevents whole-page horizontal jiggle (it does *not* block intentional inner `overflow-x-auto`, so it's compatible with the table fix).
- **`MobilePortfolioSummary` fallback exists** (`dashboard-client.tsx:642`) — phones get a real condensed portfolio card, not a broken rail.
- **Macro board is genuinely responsive** — tiles scale 2→3→4 columns (`macro-panel.tsx:33,84,142,157`); the best-handled surface in the app.
- **Workspace tab bar is wrapped in `overflow-x-auto`** (`dashboard-client.tsx:645`) — scrollable, just lacking a visual cue.
- **Form grids reflow** — Settings/Decision/Performance/symbol-drilldown grids use `sm:grid-cols-2` / `sm:grid-cols-3` and stack cleanly at phone width.
- **`RunHistory` table already has `overflow-x-auto`** (`views.tsx:706`) — proof the team knows the correct table pattern; it just wasn't applied to Market Scan.
- **StrategyStudio collapses correctly** — `grid lg:grid-cols-2` → single column below `lg`.

---

## Coverage & false positives

**Could not be verified live (CSS-deterministic findings are still high-confidence; these are the runtime-dependent residuals):**
- **No physical device run.** Harness viewport was pinned at 1438px; zero findings were observed on a real iPhone/iPad. Layout/overflow/font-size conclusions are deterministic from source; the items below are not.
- **Exact header wrap-row count** (estimated 3–4 rows / ~120–200px) depends on runtime font metrics and intrinsic button widths — direction is certain, the pixel total is an estimate.
- **TableVirtuoso internal scroller** — verified from `react-virtuoso` source that a vertical-only instance applies `overflowY:auto` (no `overflowX`), but the exact clipped-vs-scrollable behavior at the boundary should be confirmed on device.
- **Chart vs page touch-gesture arbitration** — the conflict is real per Lightweight Charts defaults, but the felt severity needs a device test.
- **Mesh-gradient/backdrop-blur GPU & battery cost** on A12/A13 hardware — the missing reduced-motion guard is certain; the perf magnitude is inferred, not measured.

**Corrected / downgraded during verification (avoid these as written):**
- **"TableVirtuoso sets `overflowX: auto`"** — *false*. A standard vertical instance does not; this makes the clip *worse*, not a non-issue.
- **"Modal max-width exceeds viewport, padding disappears"** — *false framing*. `max-w-*` are caps; `w-full` inside `p-4` keeps the dialog 16px off each edge. The real bug is the *tab-row* overflow inside the modal, not the modal geometry.
- **Safe-area severity downgraded High→Medium** — portrait content is **not** hidden (Safari auto-constrains to the safe rect without `viewport-fit=cover`); only landscape is materially affected.
- **Toaster bottom-overlap downgraded** — clears the home indicator under normal use; the genuine (narrow) risk is occlusion when a toast fires while the soft keyboard is open. "15px landscape safe area" figure is ungrounded.
- **Workspace-tab "no affordance" overstated** — the bar *is* `overflow-x-auto` and swipeable; the issue is discoverability, not clipping.
- **Congress/insider row truncation** — arithmetic shows most names fit at 390px; truncation is rare. The real (minor) issue there is `title`-tooltip inaccessibility on iOS, not the layout.

**No findings were rejected outright as fabricated** — all cited code was confirmed to exist at the referenced `path:line`.