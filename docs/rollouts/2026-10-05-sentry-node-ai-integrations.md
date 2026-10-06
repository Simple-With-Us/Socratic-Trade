# Sentry server AI integrations import fix

## Context & Objective

Production builds logged webpack "Attempted import error" for six integrations referenced via `@sentry/nextjs` in `sentry.server.config.ts` (Sentry issue 7753792417).  Those helpers are exported from `@sentry/node`, not the Next.js SDK re-export surface.  Goal: keep LLM AI auto-instrumentation working on the Node server without silent import failures at build time.

## Changes Made

- Import `nodeRuntimeMetricsIntegration`, `openAIIntegration`, `anthropicAIIntegration`, `googleGenAIIntegration`, `vercelAIIntegration`, and `langChainIntegration` from `@sentry/node`; keep `Sentry.init` on `@sentry/nextjs`.
- Add explicit runtime dependency `@sentry/node@11.0.0` (aligned with lockfile `@sentry/nextjs` / `@sentry/profiling-node` 11.0.0).

Files touched:

- `sentry.server.config.ts`
- `package.json`
- `package-lock.json`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-10-05-sentry-node-ai-integrations.md`

## Decisions & Trade-offs

- Kept all six integrations (not dropped) so Node runtime metrics and official GenAI SDK hooks stay registered for this LLM-heavy app.
- Did not move `Sentry.init` to `@sentry/node`; Next.js instrumentation path still uses `@sentry/nextjs` as before.

## Verification State

```bash
npm run lint          # 0 errors
npx tsc --noEmit      # clean
npm test              # (full vitest suite)
npm run build         # no "Attempted import error" for sentry.server.config.ts
```

Build before fix emitted six `not exported from '@sentry/nextjs'` lines; after fix `npm run build` reports none.

## Next Steps & Blockers

- Merge PR after `verify` CI is green; production deploy follows normal `main` auto-deploy (RTH latch may queue image build on weekdays).

## Zero-Code Findings

- `@sentry/node` was already present transitively via `@sentry/nextjs@11.0.0`; pinning it as a direct dependency makes the integration import explicit and version-locked.
