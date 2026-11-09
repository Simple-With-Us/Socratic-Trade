# 2026-06-20 — UI/UX + iPad/iPhone audit and quick-win implementation (`agent/claude`)

## Summary
Ran two multi-agent audits of the cockpit (a real-Chrome desktop walkthrough → 64-agent
review/verify/synthesis, and a source-grounded iPad/iPhone review → 27-agent
review/verify/synthesis), then implemented the quick wins + high-severity fixes. Full audit
reports + the complete implemented/deferred list are in
`docs/reviews/2026-06-20-ui-ux-and-mobile-audit.md`. The complete, itemized, status-tagged
backlog of **every** issue (fixed / partial / deferred / noted) is the issue register at
`docs/reviews/2026-06-21-ui-ux-issue-register.md`.

## Why
User asked for a thorough team-of-agents UI inspection (desktop + iPad/iPhone) and to
implement the quick wins and high-severity fixes. The biggest confirmed issues: the Market
Scan sort key (Score) was clipped off-screen; zero P&L/tax values were colored as gains/losses;
white-glyph ticker logos were invisible in light mode; no reduced-motion support; iOS form
inputs auto-zoomed; macro sparklines colored rising VIX/credit-spreads as "good"; and a
setup-state run failure rendered as an alarming red error.

## Files (touched, active render path unless noted)
- `app/globals.css` — reduced-motion media block; iOS 16px input rule (<=640px); calmer
  light-mode mesh orbs (+ `.dark` restore); neutral second orb; darker light `--faint`.
- `app/dashboard-widgets.tsx` — zero-neutral `signedMoney`/`formatPct`; new `pnlTone()`.
- `app/ui/ticker-logo.tsx` — dark logo tile in light mode (white-glyph visibility).
- `app/ui/primitives.tsx` — Tabs `id`/`aria-controls` + touch targets; `touch-manipulation`
  on button base + IconButton; IconButton ≥44px on mobile; StatTile `warn` tone.
- `app/ui/overlays.tsx` — modal/slide-over close ≥44px + touch; slide-over touch-dismiss +
  mobile width strip.
- `app/ui/macro-panel.tsx` — polarity-aware sparkline colors (VIX/HY inverse; yields/USD/oil
  neutral); "Broad USD" relabel + DXY-clarifying tooltip.
- `app/ui/symbol-drilldown.tsx` — header truncation; "Technology · Technology" dedup.
- `app/ui/price-chart.tsx` — `handleScroll.vertTouchDrag:false`; larger timeframe tap targets.
- `app/global-error.tsx` — `100vh` → `100dvh`.
- `app/dashboard-client.tsx` — Score → scan column 2; scan `overflow-x-auto` + table
  `min-w-max`; loading-vs-idle hint; local Sentiment/Rating chip "·"; zero-neutral tones on
  Portfolio rail / Mobile summary / Performance / Tax tiles + Est-tax neutral-at-$0; `aria-label`
  on Mode + Account selects; workspace panel `role="tabpanel"`; Settings subtitle + tab
  `overflow-x-auto` + body `min-h` (stops modal jump); shell tier `xl:`→`lg:` (iPad landscape);
  Decision setup-failures render amber + clarified empty-state copy.
- `app/ui/dashboard/components.tsx`, `app/ui/dashboard/utils.tsx` — same fixes applied to the
  **dead/unimported** parallel copies (inert; kept consistent).

## Verification
- `npx tsc --noEmit` — clean (exit 0).
- `npm test` — 386 passing, 49 files (exit 0).
- `npm run build` — green (exit 0).
- Live visual on PM2 `trading-claude` :4100 after `pm2 restart`: confirmed neutral `$0.00`
  P&L; amber "needs setup" Decision banner; Score as scan column 2 (sort arrow); AAPL logo
  visible in light mode; "Positive · 61" chips; macro VIX/HY green-when-falling + "Broad USD".

## Follow-ups (deferred; see the review doc's "Deferred" section)
- **F1 root cause:** `src/lib/strategy.ts:87,478` throw "No account selected." when
  `policy.accountNumber` is empty for an active Test account — investigate the
  connectedAccountId→accountNumber wiring before changing run semantics (UI softened only).
- **Delete the dead `app/ui/dashboard/{views,components,utils,settings}.tsx`** parallel
  implementation (no importers; `dashboard-client.tsx` has local copies) after a final check —
  this is the source of the "two divergent SettingsContent" / duplicate-SCAN_COLUMNS findings.
- Header overflow menu (<sm); full safe-area / `viewport-fit=cover`; Strategy tab vs Studio
  consolidation; Settings Risk tab; ⌘K palette re-wire.

## Notes
- All work is on `agent/claude`; not pushed and not merged to `main`. `origin/main` is 4
  commits ahead (Assistant tab + money-path guards) — merge during integration.
