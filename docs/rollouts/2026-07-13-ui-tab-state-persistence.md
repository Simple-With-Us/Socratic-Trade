# 2026-07-13: UI Tab State Persistence

- **Summary:** Updated the console UI to persist active tab and filter selections across page refreshes using `sessionStorage`.
- **Why:** The user reported that refreshing the page with the browser refresh button would reset the active tab and filters, forcing them to re-navigate to the view they were just on. `sessionStorage` provides an ideal solution for this because it inherently scopes to the current browser tab and naturally survives a hard refresh without leaking indefinitely.
- **Files:**
  - `app/console/lib/usePersistedState.ts` (NEW)
  - `app/console/activity/page.tsx`
  - `app/console/scan/page.tsx`
  - `app/console/approvals/page.tsx`
  - `app/console/components/alert-center.tsx`
  - `app/console/components/allocation.tsx`
- **Verification:** Ran `npm run lint && npx tsc --noEmit && npm run build` successfully. The build passed cleanly without errors.
- **Follow-ups:** If other components are converted to multi-view tabs in the future, they should similarly use `usePersistedState`.
