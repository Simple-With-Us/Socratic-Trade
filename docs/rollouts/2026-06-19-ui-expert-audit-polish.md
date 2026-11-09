# 2026-06-19 - UI Expert Audit Polish

## Summary

- Ran a parallel UI/design, accessibility/responsive, and financial-products UX audit of the active dashboard.
- Updated the first-run and blocked-operation UI so missing account/universe setup renders as `Setup Needed` instead of `Autonomy On`.
- Added a persistent Mock/Local/Live mode cue, blocked Run/Resume through setup routing, and added explicit Live-mode confirmation/copy.
- Renamed the app-local simulator from Paper mode to Mock/Local mode in UI text, feed titles, and LLM-facing backend payloads so Alpaca Paper remains distinct from local simulated fills.
- Made the cockpit shell desktop-only, restored mobile/tablet page scrolling, and added a compact mobile portfolio summary.
- Replaced blank Market Scan grids with actionable empty states and visible scan errors.
- Converted activity-feed JSON payloads into readable summaries and normalized notification-disabled/failed tags to `webhook off`.
- Renamed the symbol drawer's `AI Conviction Summary` to `Signal Summary` and corrected score/sentiment/factor thresholds to the app's 0-100 scale.
- Raised the low-contrast helper-text token used by table labels and small helper copy.
- Changed fresh defaults to start halted/propose instead of active/decide.
- Replaced the dashboard's Recharts-backed chart wrappers with SSR-safe SVG/CSS chart primitives and gated the full cockpit behind a hydration shell so the Codex preview serves `/` cleanly after `next build`.

## Why

- The live first-run dashboard could show `Autonomy On`, `LLM decides`, Run, and Kill while no account, no universe, and no connected accounts existed.
- Mobile/tablet widths were still trapped in the desktop fixed-height shell and clipped command-bar controls.
- Financial-service UX norms require mock/local vs live state, autonomous execution state, and live-order risk to be explicit and hard to misread.
- The Market Scan empty view and Activity feed were visually misleading: one looked like a broken blank grid, the other like a raw internal log.
- Symbol-drawer summary thresholds were materially overstating conviction by comparing 0-100 values to fractional cutoffs.

## Files

- `STATUS.md`
- `PLAN.md`
- `app/dashboard-client.tsx`
- `app/globals.css`
- `app/ui/charts.tsx`
- `app/ui/dashboard/components.tsx`
- `app/ui/dashboard/settings.tsx`
- `app/ui/dashboard/utils.tsx`
- `app/ui/dashboard/views.tsx`
- `app/ui/symbol-drilldown.tsx`
- `test/dashboard-feed.test.ts`
- `test/persistence-notification.test.ts`
- `test/strategy-tuning.test.ts`
- `src/lib/defaults.ts`
- `src/lib/execution-mode.ts`
- `src/lib/strategy.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/red-team.ts`
- `src/lib/post-mortem.ts`
- `src/lib/dashboard-feed.ts`
- `src/lib/dashboard-ui.ts`
- `docs/phase-8-cockpit-ui.md`
- `docs/phase-10-signals-learning-ui-v2.md`
- `docs/rollouts/2026-06-19-ui-expert-audit-polish.md`

## Verification

- `npx tsc --noEmit`
- `npm test` (240 passed)
- `npm run build`
- `rm -rf .next && pm2 restart trading-codex`
- `curl -sS -o /tmp/trading-codex-health-final.txt -w '%{http_code}\n' http://127.0.0.1:4101/api/health` -> `200`
- `curl -sS -o /tmp/trading-codex-root-final2.html -w '%{http_code}\n' http://127.0.0.1:4101/` -> `200`
- `node --input-type=module -e '<inline Playwright smoke: open 4101, screenshot desktop/settings/mobile, click Settings>'` -> desktop/mobile contained `Mock/Local`; screenshots written to `/tmp/trading-codex-desktop-final.png`, `/tmp/trading-codex-settings-final.png`, `/tmp/trading-codex-mobile-final.png`

## Follow-ups

- Add a full live-order confirmation ticket for Run/Approve in live mode, including side, symbol, order type, estimated notional/shares, quote source/time, account, and daily-risk impact.
- Consolidate the active monolithic dashboard with the split `app/ui/dashboard/*` modules or remove the unused split modules to avoid future UI drift.
- Make Market Scan row opening and column sorting fully keyboard-operable with `aria-sort` and row/detail controls.
- Add a proper symbol-only drilldown path so Smart Money/Tax/Portfolio tickers can open without fabricating quote values.
- Consider making connected-account environment the single Mock/Local/Live authority instead of preserving a standalone mode toggle.

## Blockers

- The in-app browser successfully supported the pre-change visual audit, including desktop/mobile screenshots and mouse-style scrolling. After the patch, an attempted browser reload was blocked by Browser Use URL policy, so the post-change visual re-check was completed through local HTTP/PM2 checks rather than the in-app browser surface.
