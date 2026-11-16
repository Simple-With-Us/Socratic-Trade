# 2026-07-02 — Integration worktree sync + unfinished local changes (Cursor)

## Summary
The integration worktree (`~/Code/Agentic Trading`, branch `main`) was 51 commits
behind `origin/main` with a small set of uncommitted local edits from an earlier
session. Fast-forwarded to current `origin/main`, reapplied the local diff, and
re-ran the full verify quartet.

## Why
"Continue all unfinished work" — the local tree had drifted far behind merged
agent work (console UI Wave 2, learning-loop autotuning, Sentry Crons, IRA
wash-sale, etc.) while carrying partial Sentry-wizard and short/cover documentation
changes that were never verified or committed.

## Files (local uncommitted delta after sync)
- `package.json`, `package-lock.json` — `@sentry/nextjs` ^10.60.0 → ^10.63.0
- `next.config.mjs` — Sentry wizard webpack options (`automaticVercelMonitors`,
  `treeshake.removeDebugLogging`); tunnel route still commented out
- `src/lib/db-execution.ts` — rename misleading `isBuy` → `isOpening` (behavior
  unchanged; always counted buy+short as opening)
- `src/lib/performance.ts` — comment documenting return sign convention for all
  four order sides
- `src/lib/policy.ts` — comment clarifying add-to-position risk rules skip
  sell/cover exits

## Verification (all run on synced tree + local delta)
- `npm install` — applied Sentry 10.63.0 lockfile
- `npm run lint` — 0 errors (295 grandfathered warnings)
- `npx tsc --noEmit` — clean after removing stale `.next/dev` and `npm run build`
- `npm test` — 237 files / 2350 tests passed
- `npm run build` — green (includes `withSentryConfig` source-map hook)
- `pm2 restart trading-main` — beta `/api/health` → 200

## Follow-ups
- ~~Decide whether to land the Sentry 10.63 bump + wizard config as a PR, or
  revert and keep only the comment-only risk-path clarifications (lower risk).~~
  **Resolved 2026-07-02 (Claude):** owner directed all uncompleted tasks be
  worked; the full delta is landing via PR from
  `claude/sentry-bump-shortcover-clarity` with auto-merge on green `verify`.
  Cursor had already verified the quartet green on this exact delta; the PR
  re-runs it locally and in CI.
- `.mcp.json` is untracked locally — do not commit unless owner wants MCP config
  in repo.
- Production (`trading-live`) still needs owner env setup per
  `docs/rollouts/2026-07-02-sentry-monitoring.md` before Sentry telemetry arms.
