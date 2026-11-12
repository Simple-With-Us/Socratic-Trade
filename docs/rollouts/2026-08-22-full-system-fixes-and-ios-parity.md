# Full System Fixes & Native iOS Website Parity Upgrades

**Date:** 2026-08-22  
**Agent:** Antigravity  
**Branch:** `agent/antigravity-fixes-and-parity`  
**PR:** #3046  

---

## 1. Context & Objective

Following a top-to-bottom audit across the desktop web console, mobile web view, native iOS application, and backend infrastructure, this rollout addresses critical frontend dependencies and safe area layout gaps, backend database query performance bottlenecks, and implements native iOS feature parity with interactive Swift Charts equity curves, standardized error JSON contracts, and sensory feedback.

---

## 2. Changes Made

### Frontend Web & Dependency Hygiene
- **Pruned Dead Dependencies**: Removed unused packages `@xyflow/react` and `lightweight-charts` from `package.json` and cleanly updated `package-lock.json`.
- **Navigation Links**: Fixed stale link in `app/console/assistant/chat.tsx` pointing to `/console/settings` so it correctly links to `/console/connections#api-keys`.
- **Mobile Safe Area Clearance**: Updated `PolicySaveBar` bottom offset in `app/console/components/policy-form.tsx` to `bottom-[calc(3.75rem+env(safe-area-inset-bottom,0px))]` to ensure full visibility and clearance above mobile browser / PWA navigation bars.
- **API Error Standardization**: Standardized error response JSON payloads to `{ error, message }` in `app/api/proposals/[id]/approve/route.ts` and `app/api/proposals/[id]/reject/route.ts`.

### Backend & Database Performance
- **Migration 87 (`composite_query_indexes`)**: Appended Migration 87 in `src/lib/db.ts` adding composite indexes on:
  - `idx_fill_events_user_account_time` on `fill_events(user_id, account_number, filled_at DESC)`
  - `idx_notification_events_user_time` on `notification_events(user_id, created_at DESC)`
  - `idx_historical_fundamentals_sym_field_time` on `historical_fundamentals(symbol, field, effective_at DESC)`
- **Schema Assertions**: Updated `test/persistence-hardening.test.ts` schema version expectations to 87.
- **Vitest Teardown Hardening**: Added `onConsoleLog: () => false` in `vitest.config.ts` to eliminate Vitest worker teardown RPC races during parallel suite execution.

### Native iOS Parity & Architectural Polish
- **Native Swift Charts (`import Charts`)**:
  - Embedded `EquityChartView` into `ios/SocraticTrade/AppComponents.swift` supporting interactive area and line plots with trailing axis marks, zero-line rules, and touch-scrub date/value selection.
  - Integrated `EquityChartView` directly into `PortfolioOverviewCard` in `ios/SocraticTrade/HomeView.swift` and `ResultsView` in `ios/SocraticTrade/ResultsView.swift`.
  - Extended `ios/SocraticTrade/MobileModels.swift` to parse `liveEquityCurve` and `paperEquityCurve` points (`EquityCurvePoint`).
  - Resolved `plotAreaFrame` deprecation to modern `proxy.plotFrame` anchor.
- **Rendering Performance Optimization**: Scoped `TimelineView` in `SnapshotScaffold` / `SnapshotStatusBanner` (`ios/SocraticTrade/AppComponents.swift`) strictly to the status banner component so the entire card hierarchy is not re-rendered on the 30-second tick.
- **Haptic Sensory Feedback**: Added centralized `AppHaptics` helper (`UIImpactFeedbackGenerator`, `UINotificationFeedbackGenerator`) and wired it to proposal approvals, rejections, retry requests (`ios/SocraticTrade/ProposalsView.swift`), and order cancellations (`ios/SocraticTrade/MarketsView.swift`).
- **Resilient SSE Reconnection**: Implemented exponential backoff with jitter in `ios/SocraticTrade/MobileStore.swift` (`min(30.0, retryDelay * 1.5) + jitter`).
- **CI Simulator Disambiguation**: Updated `.github/workflows/ios-build.yml` to extract and pass simulator UUID (`id=$sim_id`) to avoid destination ambiguity when runners host multiple simulators with identical display names.

### Touched Files
- `package.json`
- `package-lock.json`
- `app/console/assistant/chat.tsx`
- `app/console/components/policy-form.tsx`
- `app/api/proposals/[id]/approve/route.ts`
- `app/api/proposals/[id]/reject/route.ts`
- `src/lib/db.ts`
- `test/persistence-hardening.test.ts`
- `vitest.config.ts`
- `.github/workflows/ios-build.yml`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/ResultsView.swift`
- `ios/SocraticTrade/ProposalsView.swift`
- `ios/SocraticTrade/MarketsView.swift`
- `ios/SocraticTrade/MobileStore.swift`

---

## 3. Decisions & Trade-offs

- **Single Component Location for New Views**: Placed `EquityChartView` inside `AppComponents.swift` rather than creating standalone unindexed `.swift` files to adhere strictly to the rule prohibiting hand-edits to `project.pbxproj` and avoiding missing file reference compile failures in CI.
- **Swift Charts AxisMarks Syntax**: Structured trailing axis marks in Swift Charts to receive `value in` and unpack `if let val = value.as(Double.self)` ensuring clean Swift 5.9+ compiler conformance.
- **TimelineView Invalidation Isolation**: Isolated the relative timestamp ticker to `SnapshotStatusBanner` rather than wrapping the scaffold body in `TimelineView`, eliminating wasteful layout passes across multi-card views every 30 seconds.

---

## 4. Verification State

All local gate and CI verification suites ran and passed cleanly with 0 errors:

1. **`npm run lint`**: 0 errors (773 grandfathered warnings).
2. **`npx tsc --noEmit`**: 0 type errors.
3. **`npm test`**: 677 test files passed (7,504 tests passed, 51 skipped).
4. **`npm run build`**: Next.js production build succeeded with clean webpack compilation and static generation for all 41 routes.
5. **`xcodebuild build`**: `generic/platform=iOS` scheme `SocraticTrade` succeeded (`** BUILD SUCCEEDED **`).

---

## 5. Next Steps & Blockers

- Merge PR to `main` (auto-deploys `socratic-app` to Coolify production).
- Update effort boards and post completion note to Slack `#ag***-s**c`.
