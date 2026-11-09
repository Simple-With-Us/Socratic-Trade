# 2026-06-29 — Profile Menu And Header Cleanup

Branch: `codex/profile-menu`

## Summary

- Added provider display metadata to Auth.js JWT/session handling: verified email still drives identity, while name, provider avatar, and login provider are retained for UI display.
- Extended the dashboard snapshot's `currentUser` payload with `name`, `imageUrl`, and `loginProvider`.
- Replaced separate top-bar Help, Activity, theme, email, and logout controls with a single profile menu.
- The profile menu shows the provider photo when available, falls back to initials, and includes Settings, Account Management, Activity Log, System Help, light/dark mode, and Sign Out.

## Handoff To Antigravity

Use worktree `/Users/jay/.codex/worktrees/profile-menu/Agentic Trading` on branch `codex/profile-menu`.

Key files:

- `src/lib/auth/auth.ts` persists display metadata in the Auth.js JWT/session.
- `app/api/dashboard/route.ts` combines trusted request identity with session display metadata.
- `src/lib/dashboard.ts` and `app/dashboard-types.ts` carry the expanded `currentUser` shape.
- `app/dashboard-client.tsx` renders the new `AccountMenu` and removes the separate header controls it replaces.

Verification:

- `npx tsc --noEmit`
- `npm test -- test/auth-github-email.test.ts test/middleware-auth.test.ts test/request-user.test.ts test/dashboard-ui.test.ts`
- Full `npm test`
- `npm run lint -- --quiet`
- `npm run build`
- Playwright browser smoke against `http://127.0.0.1:4137/` at 1440x900 and 390x844. Confirmed the profile menu opens, avatar/initials render, menu items are visible, System Help opens from the menu, and Activity Log opens from the menu.

Screenshots:

- `/tmp/profile-menu-desktop.png`
- `/tmp/profile-menu-mobile.png`
