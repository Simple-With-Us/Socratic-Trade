# 2026-06-16 - resizable-cockpit-panels

## Summary

- Shrunk the overall global font scale using `zoom: 0.9` on the body element.
- Restructured the dashboard cockpit grid using `react-resizable-panels`.
- Converted `.cockpit-shell` and `.cockpit-grid` to `flex` layouts to better accommodate resizing.
- Made the Left Rail, Center Workspace, Right Inspector, and Bottom Drawer fully resizable via drag handles.

## Why

- The user requested a slightly smaller font footprint everywhere ("zoomed out") to fit more information on screen.
- The user also requested that all cockpit sections have draggable edges so anyone can customize their widths/heights according to their own preference.

## Files

- `app/dashboard-client.tsx`
- `app/styles.css`
- `package.json`

## Verification

- `npx tsc --noEmit`
- `npm test`
- `npm run build`
- All commands passed successfully without warnings.

## Follow-ups

- We could persist the users' customized panel sizes using `react-resizable-panels`' native localStorage support if that becomes highly requested.
