# Sentry server AI integrations import fix

## Context & Objective

Production builds logged webpack "Attempted import error" for six integrations referenced via `@sentry/nextjs` in `sentry.server.config.ts` (Sentry issue 7753792417).  Those helpers live on `@sentry/node`.  A top-level import from `@sentry/node` in `sentry.server.config.ts` is traced into the Edge bundle (`instrumentation.ts` → that file) and fails the build on `diagnostics_channel` and `worker_threads`.  Goal: keep the Node server registrations without an Edge webpack failure.

## Changes Made

- Leave `Sentry.init` on `@sentry/nextjs` in `sentry.server.config.ts`.  Do not name the six factories there.
- From the Node branch of `instrumentation.ts`, load `nodeRuntimeMetricsIntegration`, `openAIIntegration`, `anthropicAIIntegration`, `googleGenAIIntegration`, `vercelAIIntegration`, and `langChainIntegration` with `webpackIgnore` (same shape as `@sentry/profiling-node`) and `Sentry.addIntegration`.  `addIntegration` skips a name that default integrations already installed.  Each factory is registered in its own try/catch and a failure is logged, so one throw does not drop the other five.  `addIntegration` is taken from `@sentry/nextjs` or its default export.
- Direct dependency `@sentry/node` at `^11.0.0`, the same range as `@sentry/nextjs`, so npm dedupes to one copy.  Lockfile still resolves 11.0.0.  Unrelated lockfile `libc` churn from the first commit is reverted.

Files touched:

- `sentry.server.config.ts`
- `instrumentation.ts`
- `package.json`
- `package-lock.json`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-10-05-sentry-node-ai-integrations.md`

## Decisions & Trade-offs

- Kept all six integrations.  With `tracesSampleRate` set, `@sentry/nextjs` already installs the five GenAI hooks via `getTracingIntegrations`.  `nodeRuntimeMetricsIntegration` is not in that default list, so the Node-only `addIntegration` is what registers it.
- Did not move `Sentry.init` to `@sentry/node`.  Datadog request logs in `instrumentation.ts` stay as they are; this change does not add or remove an observability backend.

## Verification State

2026-10-06 rebase onto `origin/main` (`608ae672`, `--force-with-lease`; prior tip `785c1e70`).  GitHub `verify` + `verify-hosted` green on `608ae672`.  Fleet recall query `Sentry Next.js webpackIgnore @sentry/node Edge bundle` (app `socratic-trade`) cited on `docs/EFFORT-LOG.md` row.

```bash
npm run lint          # touched files, 0 errors
npx tsc --noEmit      # clean
npm test              # CI verify, full vitest suite
npm run build         # CI verify; no Attempted import error; no Edge Module not found for @sentry/node
```

## Next Steps & Blockers

- Merge PR #4227 after `verify` CI is green.  Production deploy follows normal `main` auto-deploy (RTH latch may queue the image build on weekdays).

## Zero-Code Findings

- `@sentry/node` is already required by `@sentry/nextjs@11.0.0` at the same exact version.  The direct `^11.0.0` range tracks that copy instead of pinning `11.0.0` while `@sentry/nextjs` floats.
