# Rollout Note: Sticky Top Bar and Slide-Over Offsets (2026-06-29)

## Summary

Made the dashboard header/top bar sticky so it always remains at the top of the page (especially useful on mobile views). Modified the `SlideOver` component to dynamically position itself below the top bar using a `--header-height` CSS custom property. The height of the sticky container (which wraps both the dynamic execution/safety banner and the dashboard command bar) is measured dynamically via a `ResizeObserver` in `DashboardApp` and exposed to the document root.

## Why

1. **Activity Log Overlapping**: The Activity Log (and other `SlideOver` panels like the Symbol Drilldown) was rendering behind the top bar, partially obscuring the slide-over title ("Activity") and top tabs.
2. **Top Bar Sticky Requirement**: The user requested that the top bar always stay at the top of the page, and the activity log should show up below it. Offsetting the slide-overs and locking the header area in a sticky wrapper solves both requirements uniformly.

## Files Touched

- [app/dashboard-client.tsx](file:///Users/jay/apps/trading-antigravity/app/dashboard-client.tsx)
- [app/ui/overlays.tsx](file:///Users/jay/apps/trading-antigravity/app/ui/overlays.tsx)

## Verification

The following verification steps were run successfully in `/Users/jay/apps/trading-antigravity`:

1. **Type Check**:
   ```bash
   npx tsc --noEmit
   ```
   *Result*: Compiled cleanly with 0 errors.

2. **Linter Check**:
   ```bash
   npm run lint
   ```
   *Result*: Passed with 0 errors (existing warnings-only backlog intact).

3. **Test Suite**:
   ```bash
   npm test
   ```
   *Result*: Successfully passed all 1,516 unit/integration tests.

4. **Production Build**:
   ```bash
   npm run build
   ```
   *Result*: Full Next.js production build generated successfully.

5. **PM2 Process Restart**:
   ```bash
   pm2 restart trading-antigravity
   ```
   *Result*: PM2 preview server restarted on port 4102 and is healthy.

## Follow-ups

None.
