# 2026-08-18 — Hotfix: `/console/connections` crashed with `process.uptime is not a function`

## Context & Objective
Found during the MONET full-app expert review (live pass on a fresh `origin/main` worktree).  PR #2848 (`c55c2e642`, live in production since 2026-08-19T00:51Z) added a module-scope `process.uptime()` to `src/lib/db-execution.ts`.  That module is reachable from the BROWSER bundle through the `db` barrel: `app/console/settings/brokers.tsx` ("use client") -> `src/lib/venue-contract.ts` -> `src/lib/source-settings.ts` -> `src/lib/db-api-keys.ts` -> `src/lib/db.ts`.  The webpack client aliases in `next.config.mjs` stub `better-sqlite3`, `fs`, `dns`, ... to `false`, so the barrel evaluates in the browser; Next's browser `process` shim has `env` but no `uptime`, so module evaluation threw and the Connections page (broker + LLM key management) rendered "Dashboard error: process.uptime is not a function".

## Changes Made
- `src/lib/db-execution.ts` — `PROCESS_STARTED_AT_MS` is now a lazy, guarded accessor `processStartedAtMs()` (memoized on first use; `uptime` = 0 when `process.uptime` is not a function).  Server semantics unchanged: the first server call captures the real boot instant.
- `test/stale-running-runs.test.ts` — regression test that evaluates the module with a browser-shaped `process` (no `uptime`); proven to fail on the old code (`TypeError: process.uptime is not a function`) and pass on the fix.
- `docs/rollouts/2026-08-18-connections-process-uptime-hotfix.md` (this note), `STATUS.md` stanza, `docs/EFFORT-LOG.md` row.

## Decisions & Trade-offs
- Surgical guard only.  The ROOT CAUSE — server DB modules bundled (stubbed) into the client — is left for the review's P1 item: `import "server-only"` in `src/lib/db.ts`, and moving pure venue helpers (`mergeAccountCapabilities`) into a client-safe module.  Doing that here would widen the blast radius of a hotfix.
- Related dev-only symptom (documented in the review, not fixed here): under the default Turbopack `npm run dev`, compiling `/console/connections` produces "Module not found: Can't resolve 'fs'" and every route 500s until restart; `next dev --webpack` matches the production bundler.

## Verification State
- `npx tsc --noEmit` clean.
- `npx vitest run test/stale-running-runs.test.ts test/runtime-health.test.ts` — 68 passed (incl. the new regression test).
- `npx eslint` on the two touched files clean.
- Browser: `next dev --webpack -p 3006` on this branch, `/console/connections` renders (broker cards, API keys, LLM rows), zero console errors.  On `origin/main` the same page shows the "Dashboard error" boundary.

## Next Steps & Blockers
- Merge -> auto-deploy; confirm with `bash scripts/verify-deploy-sha.sh` and a manual visit to `/console/connections`.
- Root-cause split tracked in `docs/reviews/2026-08-18-full-app-expert-review.md` (LIVE-01).
