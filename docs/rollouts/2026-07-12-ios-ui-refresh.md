# 2026-07-12 — iOS Native-Style Web UI Refresh

## Summary
Migrated the web application's settings pages to use an iOS native-inspired aesthetic featuring "Inset Grouped" lists, edge-to-edge content on small viewports, and semantic grouping matching modern iOS interfaces.

## Why
The user requested that the web dashboard (both mobile and desktop views) be updated to use the UI components and design aesthetic established during the recent iOS native app overhaul, ensuring a consistent and premium cross-platform experience.

## Files Touched
- `app/ui/ios-components.tsx` (New components: `List`, `ListSection`, `ListRow`, `LabeledContent`, etc.)
- `app/console/components/nav.tsx` (Navigation styling)
- `app/console/settings/page.tsx`
- `app/console/settings/api-keys.tsx`
- `app/console/settings/brokers.tsx`
- `app/console/settings/danger.tsx`
- `app/console/settings/delivery.tsx`
- `app/console/settings/help.tsx`
- `app/console/settings/learning-review.tsx`
- `app/console/settings/sharing.tsx`

## Verification
- `npm run lint`: Passed (0 errors, 427 warnings).
- `npx tsc --noEmit`: Passed with zero errors after fixing `ListSection` and `LabeledContent` prop type signatures.
- `npm test`: Passed (all 349 files / 3896 tests).
- `npm run build`: Succeeded (production Next.js build completed cleanly).

## Follow-ups
- Apple Sign-In support is still pending implementation for both the web application and the native iOS app (as mentioned in the earlier requests).
- Verify responsive layout edge-cases in production on small mobile devices.
- Extend the `ListSection` grouped aesthetic to other non-settings pages across the console (e.g. Activity, Dashboard).
