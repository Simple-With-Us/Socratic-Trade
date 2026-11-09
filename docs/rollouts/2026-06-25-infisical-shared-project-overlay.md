# 2026-06-25 — Infisical app+shared project overlay (app wins)

## Summary

The Infisical runner pulled from a **single** project, so the `shared-at-ct`
(App-A/B / congress-trade) secrets were documented but never actually reached the
app. Added a deterministic two-project overlay:

- `scripts/infisical-run.mjs` — when `INFISICAL_SHARED_PROJECT_ID` is set, the
  runner fetches BOTH the shared and the app project via `infisical export` (each
  with its own machine-identity token) and merges them itself as
  `{ ...process.env, ...shared, ...app }` — **the app project wins** any overlapping
  key; shared is the fallback. Precedence is runner-controlled, so it does NOT
  depend on the Infisical CLI's env-merge default. Single-project (no shared id)
  keeps the proven `infisical run` path unchanged.
- `scripts/infisical-prod-cutover.sh` — accepts `INFISICAL_SHARED_TOKEN` (+ optional
  `INFISICAL_SHARED_PROJECT_ID`, default shared-at-ct), verifies read access to the
  shared project, and writes both to `deploy.env`.
- `.env.example`, `docs/secrets.md`, `docs/deployment.md` — document the overlay +
  the app-wins precedence (replacing the earlier vague "cross-project / second pass"
  TODO).

## Why

Operator asked "how does it access the shared secret project" — it didn't. Chose
option B (in-runner) with **app wins on collisions**. Each project has its own
machine identity, so the runner authenticates per project and merges deterministically.

## Files

- `scripts/infisical-run.mjs` — app+shared overlay (export+merge, app wins);
  single-project path unchanged.
- `scripts/infisical-prod-cutover.sh` — write `INFISICAL_SHARED_PROJECT_ID` /
  `INFISICAL_SHARED_TOKEN` to deploy.env; verify shared read access.
- `.env.example` — `INFISICAL_SHARED_PROJECT_ID` / `INFISICAL_SHARED_TOKEN`.
- `docs/secrets.md`, `docs/deployment.md` — concrete overlay + app-wins.
- `STATUS.md`, `PLAN.md`, this rollout note.

## Verification

- `node --check scripts/infisical-run.mjs` ✓; `bash -n scripts/infisical-prod-cutover.sh` ✓.
- **Deterministic merge proven with a fake `infisical` shim** (the real CLI is
  absent in the sandbox): multi-project run → overlapping `FOO` resolved to the
  **app** value, shared-only + app-only keys both present, `SECRETS_SOURCE=infisical`,
  child exit code 3 propagated; single-project → exit 4 propagated. `parseDotenv`
  handled single/double/unquoted values + comments.
- Trio (the runner is a standalone `.mjs`, not imported by the app): build ✓, tsc ✓
  clean, tests **1228/1228**.

## Follow-ups

- Operator: confirm the real `infisical export --format dotenv` flags/output once on
  the box (standard command; the live CLI couldn't be exercised here). Provide the
  shared machine identity's token via `INFISICAL_SHARED_TOKEN` to the cutover script
  to enable the overlay.
