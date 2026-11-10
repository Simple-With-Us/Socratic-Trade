# 2026-07-23 Admin Panel Server RAM Fix & CI ESLint Ignores

## Summary
The Admin panel's "Server Metrics" tab was modified to extract actual RAM capacity directly from the Hetzner Server API's metadata rather than relying on Coolify metadata to ensure accurate memory percentages. Also, added `**/.worktrees/**` to the ESLint configuration ignores to prevent CI `verify` gates from failing when linting other agents' worktree paths.

## Why
Another agent discovered that the Hetzner server API returns memory metadata inside `server.server_type.memory`, so the Admin UI can display the total physical RAM size correctly. Concurrently, CI lint checks were failing due to unrelated syntax errors residing within another agent's `.worktrees/pr-1792-fix` directory because the ESLint flat config ignored `**/worktrees/**` instead of `**/.worktrees/**`.

## Files Touched
- `src/lib/server-metrics-shapes.ts`
- `app/api/admin/server-metrics/route.ts`
- `eslint.config.mjs`

## Verification
- `npm run lint`: successfully ignored `.worktrees/` and passed.
- `npx tsc --noEmit`: zero type errors.
- `npm test`: cleanly executed 5000+ tests.
- `npm run build`: cleanly executed.

## Next Action
None.
