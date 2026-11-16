# 2026-07-06: Mobile Settings Sheet Focus Loop Fix

- **Summary**: Fixed a "Maximum call stack size exceeded" error that occurred on mobile when clicking "Settings" inside the "More" tab sheet.
- **Why**: React 18 concurrent rendering and Next.js navigation can cause a race condition where a sheet is removed from the DOM but its `focusin` event listener is still active (cleanup deferred). When focus shifts to the route announcer, the trap tries to steal it back to an unmounted sheet element, causing an infinite focus loop.
- **Files**: 
  - `app/console/ui/sheet.tsx`
- **Verification**: 
  - Ran `npm run build` which compiled successfully (verifying the change did not break TypeScript or Next.js layout).
- **Follow-ups**: None. This is a targeted UI stability fix.
