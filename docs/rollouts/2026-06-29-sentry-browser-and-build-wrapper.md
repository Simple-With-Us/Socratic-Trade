# 2026-06-29 — Complete Sentry: browser SDK + build wrapper (Cursor / cursor/complete-sentry-setup-8bed)

## Summary
Finished the Sentry Next.js integration that was previously server/edge-only. Added the
browser (client) runtime init, wired `global-error.tsx` to report to Sentry, and enabled
the `withSentryConfig` build wrapper — the three pieces that `docs/ops-observability-security.md`
and `.env.example` had explicitly deferred "after the Sentry Next.js build wrapper is
revalidated." All env-gated and privacy-preserving; nothing changes unless a DSN is set.

## Why
The repo had `sentry.server.config.ts` / `sentry.edge.config.ts` + `instrumentation.ts`
working, but `instrumentation-client.ts` was an empty `export {}`, `global-error.tsx` did
not call `Sentry.captureException`, and `next.config.mjs` was not wrapped — so browser errors,
client navigation traces, root-layout render errors, and de-minified prod stack traces (source
maps) were all uncovered. The historical blocker was build instability with the wrapper; with
`@sentry/nextjs@10.60.0` + Next 16.2.9 that no longer reproduces (full `npm run build` is clean).

## Files
- `instrumentation-client.ts` — browser `Sentry.init`, gated on `NEXT_PUBLIC_SENTRY_DSN`,
  `sendDefaultPii: false`, `beforeSend` → `redactForTelemetry`, configurable traces rate,
  opt-in Session Replay (`maskAllText` + `blockAllMedia` when enabled), and
  `export const onRouterTransitionStart = Sentry.captureRouterTransitionStart`.
- `app/global-error.tsx` — added `useEffect(() => Sentry.captureException(error), [error])`
  while keeping the existing custom error UI.
- `next.config.mjs` — wrapped export with `withSentryConfig(...)`: `org`/`project` default to
  `jays-services` / `agentic-trading` (overridable via `SENTRY_ORG`/`SENTRY_PROJECT`),
  `authToken: process.env.SENTRY_AUTH_TOKEN` (source-map upload only runs when set),
  `widenClientFileUpload: true`, `silent: !process.env.CI`.
- `.env.example` — un-reserved (uncommented) the `NEXT_PUBLIC_SENTRY_*` browser vars and the
  `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` build vars, with privacy notes.
- `docs/ops-observability-security.md` — updated the Sentry bullet + Production Notes to
  reflect browser SDK + wrapper now enabled (replay still opt-in, source-map upload still
  needs `SENTRY_AUTH_TOKEN`).

## Decisions
- **No `tunnelRoute`.** The ad-blocker-bypass proxy adds a `/monitoring` route that the
  fail-closed auth `middleware.ts` would block (and require a matcher exclusion). Skipped to
  keep the build simple and auth surface unchanged; revisit only if ad-blocker drop-off is seen.
- **Session Replay default OFF.** Financial app — when enabled it masks all text + blocks all
  media. Controlled by `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED` + sample-rate vars.
- **Kept env-gating + redaction.** Browser config mirrors the server config's `beforeSend`
  redaction and `sendDefaultPii: false`, so the privacy posture is identical across runtimes.
- Removed the initial `disableLogger: true` after a deprecation warning (it's a webpack-only
  tree-shake no-op under Turbopack).

## Verification
- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (251 grandfathered warnings).
- `npm test` — 159 files / 1536 tests passed.
- `npm run build` — clean, "Compiled successfully", no Sentry warnings.
- **End-to-end capture test (mock ingest on `localhost:9999`, temp `/sentry-test` page +
  `/api/sentry-test` route, both since removed):**
  - Server route → envelope received; message redacted to
    `SERVER_TEST secret=[redacted] hex=[redacted]`, request `cookies` redacted, `environment=test`.
  - Browser button → client envelope received with browser SDK integrations
    (BrowserApiErrors, GlobalHandlers, BrowserTracing, NextjsClientStackFrameNormalization),
    message redacted to `CLIENT_TEST secret=[redacted] hex=[redacted]`, `infer_ip: never`.
  - Temp scaffolding (`app/sentry-test/`, `app/api/sentry-test/`, mock server) deleted after.

## Follow-ups
- To activate in prod: set `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` (same public DSN
  `https://14bbb7e63f2d524b5be67232e05db33b@o4511650476326912.ingest.us.sentry.io/4511650513158144`),
  and optionally `SENTRY_AUTH_TOKEN` (a build-time secret, store in Infisical) to enable
  source-map upload. `NEXT_PUBLIC_*` are inlined at build time — set them before `next build`.
- Optionally enable Session Replay (`NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=true`) once the masking
  posture is confirmed acceptable.
