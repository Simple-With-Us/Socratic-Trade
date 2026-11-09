# 2026-06-16 - ui-redesign-tailwind

## Summary

Full presentation-layer redesign of the cockpit into a themable, modern
"trading terminal", on branch `ui-redesign`. The entire data/logic layer
(`src/lib/*`, API routes, snapshot shape, agent engine) is unchanged except for
surfacing the learning-loop scorecards into the dashboard snapshot.

New stack (frontend only): **Tailwind CSS 4** (replacing the hand-written
`app/styles.css`), **Recharts** (real charts), **Motion** (transitions),
`clsx` + `tailwind-merge`. Dark **and** light themes via a semantic CSS-variable
token system with a persisted toggle (no-flash init script).

### Structure (single-screen cockpit, no bottom drawer)
- **Command bar:** brand + live status pills (portfolio, buying power, a daily-
  risk gauge, universe), a Paper/Live segmented control, ⌘K hint, Activity
  button (badge = pending count), Strategy, Settings, theme toggle, Run, Kill.
- **Body grid:** a persistent **Portfolio rail** (value/P&L tiles, Recharts
  allocation donut, positions table) + a **tabbed workspace**
  (Decision / Market Scan / Performance / Strategy).
- **Decision:** pending-approval cards (approve/reject) + the latest agent
  decision with thesis chips.
- **Performance:** Recharts gradient equity curve + KPIs + a **"What's working"**
  visualization — horizontal bars of realized P&L by `tradeThesisTag` and by
  `entryMarketRegime` (the learning loop, made visible; nothing in the reference
  app comes close).
- **Feeds (Activity / Runs / Notifications):** moved out of an always-on drawer
  into an on-demand **right slide-over** (Motion), so the main grid fills the
  screen vertically when feeds are closed.
- **Settings & Strategy Studio:** modals (tabbed Settings: Operate / Risk /
  Profiles / Notifications; Studio: prompt + sliders + scoring weights + LLM
  review). **Command palette** (⌘K) for quick actions.

### New UI files
- `app/globals.css` — Tailwind import, `@custom-variant dark`, semantic tokens
  (`--bg/--surface/--line/--fg/--up/--down/...`) for light + dark, base styles,
  themed scrollbars, skeleton shimmer.
- `app/ui/cn.ts`, `app/ui/theme.tsx` (provider + no-flash script + toggle),
  `app/ui/primitives.tsx` (Button, Card, Chip, Switch, Segmented, Tabs, Field,
  StatTile, …), `app/ui/overlays.tsx` (Modal, SlideOver, ConfirmModal — focus
  trap, Escape, scroll-lock), `app/ui/charts.tsx` (EquityCurve, AllocationDonut,
  ScorecardBars), `app/ui/command-palette.tsx`.
- `postcss.config.mjs` (the `@tailwindcss/postcss` plugin).

### Backend touch (data surfacing only)
- `src/lib/dashboard.ts` now includes `thesisScorecard` and `regimeScorecard`
  (from the active mode) in the snapshot; types added to
  `app/dashboard-types.ts`.

## Why / analysis of `RobinAgent-MCP`

The user asked to mine `jaywedgeworth22/RobinAgent-MCP` for ideas. It is a
Google AI-Studio-generated front-end mockup (~600 lines): the "backend" is a
single Gemini call against a hardcoded mock portfolio; the chart/stats/intel/tax
panels are static mock data. **There is no strategy depth to copy** — our
Bull/Bear/Red-Team debate, reflection learning loop, thesis+regime scorecards,
MAE/MFE timing, multi-provider real data, policy gating and paper/live
accounting have no equivalent there.

What we *did* borrow is its **UI polish**: dark trading-terminal theme, Recharts
charts, Motion transitions, StatCard/Chip patterns, segmented/switch controls,
animated status dots, monospace numerals. Two of its *feature* ideas are logged
as follow-ups (not yet built): a **Market Intel** surface (macro + technicals in
one readable view) and **tax/wash-sale awareness** (ST vs LT realized gains,
estimated liability, a 30-day wash-sale lockout for the agent).

## Files

- New: `app/globals.css`, `app/ui/*` (cn, theme, primitives, overlays, charts,
  command-palette), `postcss.config.mjs`.
- Rewritten: `app/dashboard-client.tsx` (full redesign, all handlers preserved),
  `app/dashboard-widgets.tsx` (trimmed to pure formatters), `app/layout.tsx`.
- Edited: `src/lib/dashboard.ts`, `app/dashboard-types.ts`.
- Deleted: `app/styles.css`.
- Deps added: `tailwindcss`, `@tailwindcss/postcss`, `postcss` (dev);
  `recharts`, `motion`, `clsx`, `tailwind-merge`.

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 86 passed
npm run build      # succeeds (Tailwind via PostCSS, Recharts/Motion bundled)
```

Browser (dev, 1440×900): verified dark + light render; command bar, Portfolio
rail + donut, Decision proposal cards, Performance equity curve + thesis/regime
learning bars, Activity right slide-over, and the Strategy Studio modal. No
console errors (Recharts emits benign dev-only "width(-1)" warnings while a chart
container measures before layout settles).

## Update — saved strategies moved to the Strategy tab

Profile selection + naming/saving was relocated from the Settings → Profiles
section onto the **Strategy tab** (next to the prompt and LLM review), since
naming/saving a strategy is more logical co-located with what it saves. The
Active-strategy card now has a "Saved strategy" dropdown and a "Save current as a
named strategy" input + Save button with a faint **Optional** label. The Settings
modal's Profiles tab was removed (now Operate / Risk & limits / Notifications).

## Follow-ups

- Silence the benign Recharts `ResponsiveContainer` width/height warnings (give
  chart wrappers explicit min dimensions or defer first render a frame).
- Build the two borrowed feature ideas: a **Market Intel** view and
  **tax/wash-sale** awareness.
- Wire the kill-switch/blocked alert paths through the new toast/modal once more
  with a live OPENAI key to confirm end-to-end.
- Consider per-section collapse + a denser "compact" density toggle.
