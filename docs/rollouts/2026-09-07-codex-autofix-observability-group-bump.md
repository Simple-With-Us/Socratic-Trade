# 2026-09-07 — Codex-autofix for observability group dependency bump (PR #3178)

## Context & Objective

Dependabot bumped the `observability` dependency group (PR #3178, commit `437e08531`):  `@opentelemetry/instrumentation` 0.221.0 → 0.222.0, `@opentelemetry/sdk-trace-node` 2.10.0 → 2.11.0, `@sentry/nextjs` 10.71.0 → 10.73.0, `@sentry/profiling-node` 10.71.0 → 10.73.0 (7 updates total per Dependabot, incl. transitive lockfile updates).  Codex review flagged the bump as missing the repo's mandatory handoff records (STATUS.md + docs/EFFORT-LOG.md + PLAN.md) before landing, flagged that the lockfile bump must be classified as a runtime change, and asked that `next.config.mjs` import `withSentryConfig` from `@sentry/nextjs/config`.  This codex-autofix round adds the handoff records and the Sentry import fix so PR #3178 clears the review gate.

## Changes Made

- `next.config.mjs` — import `withSentryConfig` from `@sentry/nextjs/config` instead of the deprecated root re-export `@sentry/nextjs`.  Verified in the installed 10.73.0 package:  the root export is a deprecation shim that `console.warn`s once per process on build/dev, is typed `@deprecated`, and is removed in v11; `@sentry/nextjs/config` is silent and has the identical function signature, so this is a pure import-path swap.
- `STATUS.md` — updated the dated snapshot entry for the bump and this round.
- `docs/EFFORT-LOG.md` — updated the `[codex-autofix]` row (runtime dependency-only; IN PROGRESS).
- `PLAN.md` — added a scope note (no roadmap change; runtime dependency-only) per the repo handoff protocol.
- `docs/rollouts/2026-09-07-codex-autofix-observability-group-bump.md` — this note.
- `package.json` / `package-lock.json` — the Dependabot commit `437e08531` itself (authored by Dependabot, untouched by this lane).

## Decisions & Trade-offs

- **Classified as runtime, not docs-only.**  The lockfile + production-dependency change is a runtime watch path (AGENTS.md auto-deploy / `watch_paths`), so the handoff records call this a runtime dependency-only change rather than "no runtime code changed."  The earlier phrasing in this note, STATUS.md, and docs/EFFORT-LOG.md was corrected after Codex's P2 so the three agree.
- **Fixed the Sentry config import now rather than deferring.**  The deprecation warning is real in 10.73.0 (verified in the installed package source) and the v11 removal is documented upstream, so swapping the import now keeps build logs clean and avoids a later build break.  No behavior change:  the `./config` export has the identical `withSentryConfig<C>(nextConfig?, sentryBuildOptions?)` signature.  Only `next.config.mjs` imports the symbol; every other `@sentry/nextjs` consumer in the repo uses a namespace import of the SDK entry, which never touches the deprecated shim, so no other site needed changing.
- **No pushback on the doc-record findings.**  Recording the bump in STATUS.md / docs/EFFORT-LOG.md / PLAN.md is harmless and consistent with the repo handoff protocol.

## Verification State

```bash
npx tsc --noEmit   # PASS (exit 0) on this branch at this commit
npm test           # 7782 passed / 9 failed / 51 skipped on this cloud seat; the 9 failures are pre-existing LLM key-routing tests that reproduce on the pristine branch with these changes stashed (they depend on seat-injected secrets) and do not touch this change; the repo `verify` CI gate runs without those secrets and is authoritative
npm run build      # PASS (exit 0)
```

## Next Steps & Blockers

- Auto-merge (squash) lands PR #3178 once the repo `verify` / required checks pass and the Codex threads are resolved.  No further code action expected.
