# 2026-10-29 — Block OpenTelemetry core/resources v3 (Langfuse peer ceiling)

## Context & Objective

Renovate PR #4938 attempted the observability-group major bump of `@opentelemetry/core` and `@opentelemetry/resources` to v3.  Hosted `verify` failed at `npm ci` with `ERESOLVE`.  This note records the upstream blocker and the repo-side guard so Renovate does not reopen the same dead PR.

## Changes Made

- Reverted `package.json` devDependency pins for `@opentelemetry/core` and `@opentelemetry/resources` to `^2.10.0` (aligned with `@langfuse/otel@6` peers and the existing trace SDK 2.x tree).
- Added a Renovate `packageRules` entry disabling **major** updates for those two packages until `@langfuse/otel` declares OpenTelemetry 3-compatible peers.

**Files touched**

- `package.json`
- `renovate.json`
- `docs/rollouts/2026-10-29-otel-3-langfuse-peer-block.md`
- `STATUS.md`
- `PLAN.md` (one-line note)

## Decisions & Trade-offs

- **No `--legacy-peer-deps` / npm overrides.**  Forcing OTel 3 alongside `@langfuse/otel@6.0.2` would violate Langfuse's declared `@opentelemetry/core@^2.0.1` peer and risk a mixed 2.x/3.x trace tree at runtime in `startObservability()` (`src/lib/observability.ts`).
- **Separate from PR #4935 (`@opentelemetry/instrumentation`).**  Instrumentation semver tracks the JS contrib line (`0.x`); it does not lift core/resources to v3.  Keeping core/resources on 2.x stays compatible with the instrumentation bump path.
- **Upstream signal:** `@opentelemetry/core@3.0.0` requires `@opentelemetry/api@>=1.10.0 <1.11.0`; Langfuse still peers `@opentelemetry/api@^1.9.0` and core/sdk-trace-base at `^2.0.1` (checked `@langfuse/otel@6.0.2` on npm, 2026-10-29).

## Verification State

```bash
npm ci --no-audit
npm run lint   # 0 errors
npx tsc --noEmit
```

Build status: `npm ci` and lint/tsc pass locally.  Full `npm test` / `npm run build` not re-run to completion on this cloud seat (prior vitest OOM/noise; hosted `verify-hosted` is authoritative).

## Next Steps & Blockers

- Re-enable OTel 3 majors for core/resources in the **same PR** that upgrades `@langfuse/otel` (or replaces Langfuse OTel integration) once npm peers include OpenTelemetry 3.
- Optional follow-up: move runtime `@opentelemetry/resources` from devDependencies to dependencies (it is dynamically imported in production) — out of scope for this unblock.

## Zero-Code Findings

- CI failure step: `verify-hosted` → **Install dependencies** → `npm ci --no-audit` → `ERESOLVE` on dev `@opentelemetry/core@^3.0.0` vs `@langfuse/otel` peer `@opentelemetry/core@^2.0.1`.
