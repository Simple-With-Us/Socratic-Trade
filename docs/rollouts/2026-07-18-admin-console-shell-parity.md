# 2026-07-18 — Admin console shell parity

## Summary

Updated the admin.socratictrade.com experience to share the normal console's visual chrome while
retaining an admin-specific navigation rail and admin-only content.

## Why

The admin portal had console tokens but a visibly separate top bar, no brand mark, and only a plain
settings link where the normal console has a profile control. The admin navigation and overview also
used inconsistent sentence-case labels, and the server section's infrastructure wording was too long.

## Changes

- Reworked `app/admin/layout.tsx` to use console spacing/surfaces, the animated Socratic Trade logo,
  and a profile popover with theme, Profile & Settings, and Sign Out actions.
- Kept account scope, Start/Resume/STOP, and Run once controls out of the admin layout; admin tabs
  remain the responsive left rail/mobile drawer.
- Normalized labels to `API Connections`, `LLM Usage & Cost`, `RAG Coverage`, `Server Stats`, and
  `Chat Transcript` across the admin rail, overview cards, page headings, metadata, and Settings links.
- Kept `/admin/server` and `/api/admin/server-metrics` routes unchanged.
- Addressed review feedback in `app/admin/layout.tsx`: the full logo/name is hidden below the small
  breakpoint so the mobile menu/profile controls remain reachable, while the console return arrow
  remains visible; logout is a plain anchor so Next does not prefetch the side-effectful GET route.

## Files

`app/admin/layout.tsx`, `app/admin/page.tsx`, `app/admin/connections/page.tsx`,
`app/admin/connections/connections-health-client.tsx`, `app/admin/llm-usage/page.tsx`,
`app/admin/llm-usage/llm-usage-client.tsx`, `app/admin/rag-coverage/rag-coverage-client.tsx`,
`app/admin/server/page.tsx`, `app/admin/server/server-metrics-client.tsx`,
`app/admin/transcript/page.tsx`, `app/admin/transcript/transcript-client.tsx`,
`app/console/settings/page.tsx`, `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`.

## Verification

All commands ran in `/Users/jay/.codex/worktrees/socratic-admin-console-shell` with Node 24:

- `npm run lint` — passed, 0 errors; 582 existing warnings.
- `npx tsc --noEmit` — passed.
- `npm test` — passed, 412 files / 4,794 tests.
- `npm run build` — passed; Next.js emitted only existing middleware/Edge-runtime/cache warnings.
- `git diff --check` — passed.
- Focused review follow-up: `npx eslint app/admin/layout.tsx` and `npx tsc --noEmit` — passed.

## Follow-up

- The first post-routing Playwright smoke run hit exit 137 while starting the local Next webServer.
  The CI-only `NODE_OPTIONS` ceiling is now 2048 MiB to preserve runner headroom for Chromium and
  build workers; rerun the smoke gate before merging.

Run `scripts/land.sh` from the clean Codex branch. After merge, verify Coolify auto-deploy serves the
exact merge SHA and `/api/health` is healthy. No production deploy or admin API/security behavior was
changed in this branch. Full repository gates remain the existing PR baseline; this follow-up adds no
new test file because both fixes are direct markup contracts already covered by the shell patterns and
the existing logout route tests.
