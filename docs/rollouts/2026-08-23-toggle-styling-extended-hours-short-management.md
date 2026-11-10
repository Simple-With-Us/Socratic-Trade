# Rollout: Toggle Styling, Account-Specific Extended Hours, and Active Short Management

**Date:** 2026-08-23  
**Agent:** Antigravity  
**Branch:** `fix/settings-toggle-styling`  

## 1. Context & Objective
1. **Toggle Switch Styling:** The settings toggle switches rendered as deformed 44x44px round circles on touch/mobile devices because `.con-toggle` was included directly in `@media (pointer: coarse)` `min-height: 44px; min-width: 44px;` rules instead of using a touch hit-target pseudo-element.
2. **Extended Hours Clarity:** Extended hours / after hours settings (`runDuringExtendedHours`, `permitExtendedHours`, `allowExtendedHoursSyntheticStops`) needed to state the exact market hours (pre-market and after-hours) for the system and reflect account/broker-specific order placement hours.
3. **Open Short Position Protection:** Disabling short selling (`shortSellingEnabled: false`) is designed to prevent opening *new* short positions, but previously skipped proactive stop-loss covers, take-profit trims, and synthetic stops on *existing* open shorts. Existing open short positions now remain fully protected and managed across all stop and exit enforcement layers.

## 2. Changes Made
- **`app/console/console.css`:** Removed `.con-toggle` from the direct `min-height: 44px; min-width: 44px;` coarse-pointer rule; added `@media (pointer: coarse) { .con-toggle::before { ... } }` expanding tap area to 44x44px while preserving the 36x20px pill shape and 14px slider thumb.
- **`src/lib/market-hours.ts`:** Exported `getBrokerMarketHours(broker?: string)` and `BrokerMarketHoursInfo` returning exact market hours (e.g., pre-market, regular, after-hours, and overnight notes for Robinhood/Alpaca/Tradier/Public/eToro/default).
- **`app/console/guardrails/field-defs.ts`:** Updated hints for `runDuringExtendedHours`, `permitExtendedHours`, `allowExtendedHoursSyntheticStops`, and `shortSellingEnabled` with explicit market hours and open-short protection rules.
- **`app/console/components/policy-form.tsx`:** Added optional `hint?: string` support to `PolicyFieldRow` so caller-provided dynamic hints override static hints.
- **`app/console/guardrails/page.tsx`:** Injected broker-specific extended hours text for the active connected account into `permitExtendedHours`, `runDuringExtendedHours`, and `allowExtendedHoursSyntheticStops`.
- **`src/lib/strategy.ts`:** Removed `!policy.shortSellingEnabled` gate in `generateProactiveRiskProposals` and `planTakeProfitTrims` so held shorts are protected with proactive stop-loss covers and take-profit trims.
- **`src/lib/synthetic-stops.ts`:** Removed `!policy.shortSellingEnabled` bypass in `syncSyntheticStops` trailing and fixed/ATR loops so open shorts maintain tick-by-tick synthetic stop protection.
- **`src/lib/broker-protective-stops.ts`:** Updated `brokerStopsForShortsEnabled` so resting buy-stops at Alpaca remain active for open shorts as long as `brokerStopsForShorts !== false`.
- **`app/console/lib/derive.ts`:** Updated `deriveProtection` and `deriveUnmanagedShorts` so existing short positions reflect active protection and are not falsely flagged as unmanaged when new shorting is off.
- **`test/reconciliation-risk.test.ts` & `test/console-live-data-derive.test.ts`:** Updated unit tests to verify existing short positions remain protected with stop covers and active badges when `shortSellingEnabled` is false.

## 3. Decisions & Trade-offs
- **WCAG Touch Target:** Used `::before` with `min-width: 44px; min-height: 44px;` positioned over the center of `.con-toggle`. This preserves WCAG 2.5.8/2.5.5 touch target compliance without mutating the toggle button geometry.
- **Broker-Specific Hours:** Handled per-venue boundaries (Alpaca 4:00 AM – 9:30 AM ET & 4:00 PM – 8:00 PM ET; Robinhood 7:00 AM – 9:30 AM ET & 4:00 PM – 8:00 PM ET with 24-hour overnight note; Tradier 7:00 AM – 9:30 AM ET & 4:00 PM – 8:00 PM ET; Public 8:00 AM – 9:30 AM ET & 4:00 PM – 8:00 PM ET; eToro regular-only).
- **Short Selling Scope:** Gated `side === "short"` / `side === "sell_short"` opening orders behind `shortSellingEnabled === true` (in `policy.ts`, `strategy.ts`), while ensuring all exit/protection logic (`side === "cover"`, stop-loss, take-profit, synthetic stops, broker stops) evaluates open shorts (`quantity < 0`) unconditionally.

## 4. Verification State
- `npm run lint` — ESLint passed with 0 errors.
- `npx tsc --noEmit` — Clean typecheck with 0 errors.
- `npm test` — Vitest passed 681 test files and 7,581 tests.
- `npm run build` — Clean production Next.js build.

## 5. Next Steps & Blockers
- Ready for PR creation, CI merge to `main`, and production auto-deployment.
