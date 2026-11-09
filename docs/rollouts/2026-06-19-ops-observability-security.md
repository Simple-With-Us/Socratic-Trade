# 2026-06-19 - Ops Observability Security

## Summary

Added the user-selected ops stack: Infisical wrappers, local Gitleaks scanning,
Sentry runtime hooks, Langfuse LLM tracing, npm Dependabot config, Litestream
scripts, and a Playwright smoke test. GitHub CI/e2e/security workflows are
deferred because the current push credentials do not include `workflow` scope.

## Why

The app now stores user credentials, can connect to brokers, and is moving toward
hosted/multi-user operation. Secret management, secret scanning, runtime error
telemetry, LLM observability, dependency upkeep, database backup, and browser smoke
coverage are the right foundation before broader rollout.

## Files

- `.env.example`
- `.github/dependabot.yml`
- `.gitignore`
- `.gitleaks.toml`
- `.pre-commit-config.yaml`
- `app/global-error.tsx`
- `docs/ops-observability-security.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-19-ops-observability-security.md`
- `instrumentation-client.ts`
- `instrumentation.ts`
- `next.config.mjs`
- `package-lock.json`
- `package.json`
- `app/api/health/route.ts`
- `playwright.config.ts`
- `scripts/infisical-run.mjs`
- `scripts/litestream.mjs`
- `sentry.edge.config.ts`
- `sentry.server.config.ts`
- `src/lib/observability.ts`
- `src/lib/post-mortem.ts`
- `src/lib/red-team.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/strategy.ts`
- `src/lib/telemetry-sanitize.ts`
- `test/e2e/dashboard-smoke.spec.ts`
- `test/vector-db.test.ts`
- `vitest.config.ts`

## Decisions

- Infisical is a wrapper around existing npm commands, not a replacement for local
  `.env.local` during development.
- Sentry and Langfuse stay disabled unless DSNs/keys are configured.
- Sentry is runtime-only in this rollout. The Next.js Sentry build wrapper and
  browser SDK wiring were deferred because the wrapper made local Next app-route
  manifest generation unstable during `npm run build`.
- GitHub Actions workflow files were generated during local validation, then
  removed from the final commit so this branch can push with the currently
  available GitHub OAuth scopes.
- Langfuse defaults to summarized/redacted request and response metadata. Full I/O
  capture requires `LANGFUSE_CAPTURE_IO=full` and still runs through the redactor.
- Browser Session Replay stays off by default.
- Litestream restore uses non-overwrite flags by default.

## Verification

```bash
npx tsc --noEmit
npm test
npm run build
npx playwright install chromium
npm run test:e2e
PLAYWRIGHT_PORT=4301 npm run test:e2e
PLAYWRIGHT_PORT=4301 PLAYWRIGHT_WEB_SERVER_COMMAND="npm run start -- -H 127.0.0.1 -p 4301" npm run test:e2e
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4201 npm run test:e2e
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4101 npm run test:e2e
npm audit --audit-level=moderate
git diff --check
pm2 restart trading-codex
curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:4101/
```

Results:

- `npx tsc --noEmit` passed.
- `npm test` passed: 223 tests across 30 files.
- `npm run build` passed with a clean compile after stopping stale Codex-worktree
  build processes that were racing `.next`.
- `npm run test:e2e` initially failed before assertions because local port `4201`
  was already occupied by a leftover/local Node listener.
- `PLAYWRIGHT_PORT=4301 npm run test:e2e` passed during the first pass, but later
  local retries exposed that the PM2 `next dev` preview and Playwright's managed
  build can race over `.next` in the same worktree.
- `PLAYWRIGHT_PORT=4301 PLAYWRIGHT_WEB_SERVER_COMMAND="npm run start -- -H 127.0.0.1 -p 4301" npm run test:e2e`
  passed against the already-built production artifact: 1 Chromium smoke test.
- `PLAYWRIGHT_BASE_URL=http://127.0.0.1:4201 npm run test:e2e` passed against a
  temporary `next start` production server: 1 Chromium smoke test.
- `PLAYWRIGHT_BASE_URL=http://127.0.0.1:4101 npm run test:e2e` passed against the
  warmed Codex PM2 `next dev` preview after restarting it post-build: 1 Chromium
  smoke test.
- `npm audit --audit-level=moderate` passed after upgrading Vitest and adding npm
  overrides for transitive Axios/PostCSS.
- `git diff --check` passed.
- `pm2 restart trading-codex` succeeded; the cold first dashboard compile was
  slow/flaky, but the warmed preview returned `200` for `/` and `/api/health`,
  and the Playwright smoke passed against `4101`.

Notable install issue: the first npm install attempt hit root-owned global cache
entries under `/Users/jay/.npm`; dependencies were installed with a local
`./.npm-cache` instead, and `.npm-cache/` is gitignored.

Notable verification fixes:

- Vitest initially collected the Playwright spec under `test/e2e`; added
  `vitest.config.ts` to keep browser tests under `npm run test:e2e`.
- The broad `@opentelemetry/sdk-node` package pulled optional gRPC/OpenCensus
  paths into Next dev/build. Replaced it with `@opentelemetry/sdk-trace-node`
  plus explicit `@opentelemetry/instrumentation`.
- The local Playwright browser was not installed; ran `npx playwright install
  chromium`.
- Cold `next dev` smoke was flaky for the dashboard page, so Playwright now uses
  the production path (`next build && next start`) and probes `/api/health`.
- Vitest 4 requires constructable SDK mocks where tests instantiate classes with
  `new`; updated the Pinecone and VoyageAI test mocks accordingly.
- The Sentry Next.js build wrapper initially fixed static client instrumentation,
  but then made app-route manifest generation unstable in repeated local builds.
  This rollout keeps Sentry runtime/request hooks plus a plain App Router global
  error fallback, and defers browser SDK/source-map upload until the wrapper can
  be revalidated.
- The Codex PM2 `next dev` process repeatedly restarted during verification; it
  must be stopped while running `npm run build` or e2e checks in the same worktree
  and restarted afterward.

Initial `npm install` reported 9 audit findings (5 moderate, 3 high, 1 critical).
This rollout cleared them without `npm audit fix --force`: Vitest was upgraded to
4.1.9, Alpaca's transitive Axios is overridden to 1.18.0, and Next's nested
PostCSS is overridden to 8.5.15.

## Follow-ups

- Configure Infisical machine identity and production project/path.
- Configure Sentry DSNs plus source-map upload secrets.
- Re-enable and verify Sentry browser SDK/source-map upload only after proving the
  Sentry build wrapper no longer destabilizes `npm run build`.
- Configure Langfuse keys and review the first traces for over/under-capture.
- Configure `LITESTREAM_REPLICA_URL` and prove restore to a scratch DB.
- Add GitHub CI/e2e/security workflows with credentials that have `workflow`
  scope, then decide whether Playwright smoke should become a required branch
  protection check.
