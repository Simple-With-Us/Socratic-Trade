# 2026-06-25 — Force a secrets manager (Infisical) + boot guard; stop relying on .env.local

## Summary
Make Infisical Cloud the production source of truth for secrets and add an opt-in guard so the app
won't run on a local `.env.local` by mistake.

- **`src/lib/secrets-source.ts`** (new): `secretsSource()` reads the `SECRETS_SOURCE` marker;
  `secretsManagerProblem()` / `assertSecretsManagerIfRequired()` throw at boot when
  `REQUIRE_SECRETS_MANAGER` is set but the app wasn't launched through a manager runner. Pure +
  unit-tested.
- **`instrumentation.ts`**: calls `assertSecretsManagerIfRequired()` first in the nodejs `register()`
  boot path (before any credential is read).
- **`scripts/infisical-run.mjs`**: injects `SECRETS_SOURCE=infisical`.
- **`scripts/gcp-secrets-run.mjs`**: injects `SECRETS_SOURCE=gcp` ONLY on a successful Secret Manager
  fetch (a fail-open fallback intentionally leaves it unset, so the guard trips rather than silently
  running on `.env.local`).
- **`.env.example`** + **`docs/secrets.md`**: document the Infisical-source-of-truth /
  bootstrap-token-only model, the `REQUIRE_SECRETS_MANAGER` enforcement, and the one-time
  `.env.local → Infisical` migration (run by the operator; secret values never pass through an agent).

## Why
Owner wants to stop using `.env.local` and force a cloud secrets manager. Infisical Cloud chosen over
GCP: genuinely free for unlimited secrets, already wired (`:secrets` scripts), no service-account key
file to protect. `.env.local` can't be made un-read by Next, so "force it" = a boot guard that fails
fast unless secrets came from a manager.

## Default-off / safety
`REQUIRE_SECRETS_MANAGER` defaults unset → zero behavior change for dev, tests, CI. The guard only
arms when the operator sets it on the box. No secret values are handled by code here — only the
marker.

## Files
- new `src/lib/secrets-source.ts`, `docs/secrets.md`, `test/secrets-source.test.ts`
- `instrumentation.ts`, `scripts/infisical-run.mjs`, `scripts/gcp-secrets-run.mjs`, `.env.example`

## Verification
`npx tsc --noEmit`, `npm test` (+ new secrets-source tests), `npm run build` via `scripts/land.sh`.

## Operator follow-up (not code; see docs/secrets.md)
1. Import `.env.local` → Infisical Cloud; create a Machine Identity.
2. Set the bootstrap (`INFISICAL_TOKEN`/`INFISICAL_PROJECT_ID`/`INFISICAL_ENV=prod`) +
   `REQUIRE_SECRETS_MANAGER=1` on the box.
3. Switch PM2 `trading` (`trading.config.cjs`) to `npm run start:secrets`; verify; scrub `.env.local`.
