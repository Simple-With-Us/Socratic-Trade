# UI Expert Guidance

Consolidated guidance from the UI/design, accessibility/responsive, and
financial-products UX reviews. Use this as the entry point before changing the
dashboard, Settings, onboarding, symbol surfaces, or trading-action controls.

## Source Notes

- `docs/reviews/2026-06-18-ux-review.md` - platform-deep-review UX track.
- `docs/rollouts/2026-06-19-ui-expert-audit-polish.md` - implemented UI expert
  audit fixes and remaining follow-ups.
- `docs/phase-8-cockpit-ui.md` - durable cockpit semantics and accessibility
  expectations.
- `docs/rollouts/2026-06-16-ui-redesign-tailwind.md` - current cockpit shell and
  visual direction.
- `docs/rollouts/2026-06-16-ui-optimization-pass.md` - earlier multi-agent UI
  optimization and accessibility findings.
- `docs/rollouts/2026-06-18-glassmorphism-ui.md` - visual polish direction.
- `docs/rollouts/2026-06-19-operate-universe-watchlist-ignore.md` - Operate
  universe control refinements.
- `docs/rollouts/2026-06-19-ticker-logo-display.md` - symbol/logo display
  preference and fallback behavior.

## Durable Standards

1. **Safety state must be impossible to misread.** Always keep Mock/Local vs
   Live, setup readiness, selected account, market session, daily risk, and
   universe state visible near trading controls. Do not show `Autonomy On` when
   account or universe setup is incomplete.
2. **Live trading actions need explicit friction.** Entering Live mode, running
   autonomy, approving orders, or placing/canceling broker orders should make
   side, symbol, account, mode, order type, estimated notional/shares, and risk
   impact clear before execution.
3. **Mock/Local is not Alpaca Paper.** User-facing text and LLM-facing context
   must call the local simulator `Mock/Local`; Alpaca Paper is a separate
   broker-hosted account environment.
4. **Financial-service UX should feel dense, calm, and accountable.** Avoid
   marketing hero patterns inside the app. Prefer compact tables, clear status
   chips, reliable source/freshness labels, and progressive disclosure around
   complex evidence.
5. **Every empty/error state needs a next action.** Empty Market Scan, missing
   account, missing universe, missing API key, and failed scan states should
   route to the relevant setup surface instead of looking like a broken grid.
6. **Mobile/tablet must use normal page scrolling.** The fixed-height cockpit is
   for desktop only. Smaller viewports need wrapping command actions, readable
   summaries, and no clipped controls.
7. **Accessibility is part of the trading safety model.** Tabs need tab roles,
   overlays need dialog semantics/focus management/Escape close, tables need
   keyboard-operable sort and row/detail controls, icon buttons need labels, and
   helper/table text must meet readable contrast.
8. **Ticker behavior must be consistent.** Bold or linked ticker text across
   Market Scan, Portfolio, Smart Money, Tax, and drawer headers should open the
   same symbol intelligence path when possible. If logo art is unavailable,
   fall back to text rather than blocking navigation.
9. **Do not overstate signal quality.** Use `Signal Summary`, not AI conviction
   language, unless the UI shows a real model-confidence metric. Keep 0-100
   factor scores distinct from signed contribution/waterfall views.
10. **Settings should group by user intent.** Operate owns mode, universe,
    watchlist, ignore list, authority, and cadence. Risk owns hard limits. Tax,
    tuning, notifications, display, keys, and accounts should stay separate
    enough that a financial user can find them without scanning every field.

## Implemented From The Reviews

- Persistent Mock/Local/Live cue and Live-mode confirmation copy.
- Setup Needed state and setup routing for missing account/universe.
- Mobile/tablet page scrolling restored with compact portfolio summary.
- Actionable Market Scan empty/error states.
- Activity-feed payloads summarized instead of raw JSON dumps.
- Helper-text contrast raised.
- Symbol drawer language and thresholds corrected to app scale.
- Operate universe grouped into Base indexes, Additional Watchlist, and Ignore
  List; S&P 500 starts selected by default.
- Ticker logo display preference with text fallback.

## Open Follow-Ups

- Add one uniform live-order confirmation ticket for Run/Approve/Place actions.
- Add a first-run checklist: connect account, confirm Mock/Local, pick universe,
  run once, review proposal.
- Add risk/loss disclosure and "estimates, not advice" language in the right
  surfaces without turning the app into a marketing page.
- Finish keyboard/assistive-tech coverage for Market Scan sorting, clickable
  rows, command palette, and async update announcements.
- Consider making connected-account environment the single source of
  Mock/Local/Live truth so the UI cannot drift from broker state.
