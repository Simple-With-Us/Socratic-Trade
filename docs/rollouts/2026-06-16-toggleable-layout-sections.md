# 2026-06-16 - toggleable-layout-sections

## Summary
Added a "Layout" dropdown menu to the top right command strip. This allows the user to individually toggle the visibility of the four main dashboard sections (Left Rail, Center Workspace, Right Inspector, and Bottom Drawer).

## Why
The user requested a way to hide sections of the application they aren't actively using, providing a more focused and customizable trading workspace that maximizes screen real estate.

## Files
- `app/dashboard-client.tsx`: Added React state for layout toggles (`showLeftRail`, `showCenterWorkspace`, `showRightInspector`, `showBottomDrawer`), implemented the `LayoutDashboard` dropdown button in the header, and wrapped the `PanelGroup` and `Panel` components in conditional rendering logic based on the state.

## Verification
- `npx tsc --noEmit` - Passed
- `npm test` - Passed 80 tests across 11 files
- `npm run build` - Compiled successfully
