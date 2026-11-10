# 2026-07-13 — Development background workers fail closed

## Summary

Process-level autonomous work now stays off in every non-production runtime unless
`DEV_BACKGROUND_WORKERS=on` is explicit. Production still starts the autonomous scheduler,
crash-durable Usage Monitor replay, and individually configured outbound streams by default.
Startup prints one unambiguous enabled/disabled receipt.

## Why

A UI-only `next dev` session started the real scheduler and background RAG/provider work. A local
worktree can contain copied account state and real credentials, so merely rendering a page must not
implicitly authorize those side effects. Individual provider flags were insufficient because the
scheduler itself is broad and default-on.

The gate is intentionally environment-scoped rather than a production off-switch: production keeps
the existing always-on trading contract, while development, Vitest, and ad-hoc/unknown environments
fail closed. Developers can opt in deliberately when their task requires worker behavior.

## Files

- `.env.example`
- `instrumentation.ts`
- `src/lib/background-worker-startup.ts`
- `test/background-worker-startup.test.ts`
- `PLAN.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-13-development-background-workers.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board)

## Verification

Run with Node 24:

- `npm ci` — completed; surfaced the known TypeScript 7 / typescript-eslint peer mismatch tracked by
  the separate `codex/typescript-gate-repair` lane.
- `npx vitest run test/background-worker-startup.test.ts test/sentry-inert.test.ts` — 2 files,
  22 tests passed, including `NODE_ENV=production` + `VITEST=true` remaining test/fail-closed.
- `node --require ./eslint-preload.cjs node_modules/eslint/bin/eslint.js instrumentation.ts src/lib/background-worker-startup.ts test/background-worker-startup.test.ts` — passed with zero output.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.
- Stripped-environment `next dev --hostname localhost --port 4317` against a disposable database,
  then `GET /login` — instrumentation printed `[background-workers] disabled (development; ...)`
  and never printed `[scheduler] started`. The route itself returned 500 on the pre-existing invalid
  Tailwind `var(--con-*)` generation bug in current `main`; that independently reproduced defect is
  fixed and regression-tested in the separate `codex/console-usage-tokens` lane.
- Direct `npx eslint ...` — failed in the already-deployed TypeScript 7 split-toolchain state with
  `Cannot read properties of undefined (reading 'Cjs')`; the repository's current preload wrapper
  passed. This lane does not duplicate the corrective toolchain work.

Those focused checks preceded the independent review and final repository gate recorded below.

### Final independent review and ordered gate

Fresh review accepted the scoped startup decision: disabled runtimes return before the lazy imports,
the enabled path preserves the existing idempotent worker starters, production remains default-on,
and no provider/broker behavior is changed. Current `HEAD` and fetched `origin/main` were both
`86971ec40aeb9fedc286670f3db9790a7980911c` before the gate.

The first full-test invocation accidentally inherited the host's Node 26.5.0 and failed at the known
native boundary: `better-sqlite3` was built for ABI 137 while Node 26 requires ABI 147. No assertion
failure was diagnosed from that run. The complete ordered gate was rerun with
`/opt/homebrew/opt/node@24/bin` first on `PATH`:

- `npm run lint` — exit 0; 0 errors and 458 grandfathered warnings.
- `npx tsc --noEmit` — exit 0.
- `npm test` — 363 files / 4,051 tests passed in 958.02 seconds.
- `npm run build` — exit 0; production bundle completed.
- `git diff --check` — exit 0.

The build reproduced two current-main warnings that are not caused by this lane: the unsafe
`var(--con-*)` Tailwind candidate (fixed in `codex/console-usage-tokens`) and Next skipping its
in-build type pass (fixed in `codex/typescript-gate-repair`). The required standalone TypeScript gate
was green here. No external provider, broker, corpus, Infisical, or production action occurred.

`scripts/land.sh` then repeated standalone TypeScript, all 4,051 tests, and the production build
under Node 24 before pushing `codex/dev-background-workers`. Its final PR command missed `gh` because
the one-off PATH override contained Node 24 but not Homebrew's general binary directory; the pushed
branch and gate were unaffected. Authenticated `gh` recovery opened ready PR #1576. Hosted `verify`
is pending.

## Follow-ups

- Require hosted `verify` on ready PR #1576; do not manually deploy.
- After merge auto-deploys, verify `/api/health`, the production enabled boot receipt, and fresh
  scheduler ticks without starting any retired preview.
