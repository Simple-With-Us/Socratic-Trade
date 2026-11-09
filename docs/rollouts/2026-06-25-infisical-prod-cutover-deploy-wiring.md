# 2026-06-25 — Wire deploy.yml for Infisical + operator cutover script

## Summary

Follow-up to #165 (Infisical-only). Adds the repo-side pieces so production can
source secrets from Infisical, **without breaking deploys before the box is ready**:

- `scripts/infisical-prod-cutover.sh` (new, executable) — idempotent operator
  script run **on the production box**. It does the host-side steps a cloud agent
  cannot (needs the machine-identity `INFISICAL_TOKEN`; reads live secret values
  that stay on the box): writes the bootstrap to
  `~/.config/agentic-trading/deploy.env` (chmod 600), imports the current
  `.env.local` into the Infisical prod env (excluding bootstrap vars), re-creates
  PM2 `trading` to launch via `npm run start:secrets`, verifies `/api/health`, and
  — only with `--scrub` — backs up + trims `.env.local`.
- `.github/workflows/deploy.yml` — sources `~/.config/agentic-trading/deploy.env`
  if present, and builds via `npm run build:secrets` when `INFISICAL_TOKEN` + the
  Infisical CLI are available, else plain `npm run build`. **Safe to merge:** with
  no `deploy.env` (pre-cutover), behaviour is unchanged (plain build, `pm2 restart`
  reuses the existing launch command).

## Why

Operator asked to rewire `deploy.yml`/PM2 and run cutover steps 2–3. Steps 2–3 are
host-side (the production Mac) and need the machine-identity token + live secret
values, which can't pass through the cloud agent — so they're delivered as a
one-command, idempotent script the operator runs on the box. `deploy.yml` is wired
to pick up the bootstrap automatically once it exists, with a safe fallback so the
auto-deploy on this PR's merge is a no-op behaviourally.

## Files

- `scripts/infisical-prod-cutover.sh` — new (executable, `bash -n` clean).
- `.github/workflows/deploy.yml` — source box bootstrap + conditional `build:secrets`.
- `docs/secrets.md` — cutover-script TL;DR + PM2/deploy auto-pickup note.
- `docs/deployment.md` — "Production cutover" note updated.
- `STATUS.md`, `PLAN.md`, this rollout note.

## Verification

- `bash -n scripts/infisical-prod-cutover.sh` — clean; executable bit set.
- Trio (no app code changed): `npm run build` ✓, `npx tsc --noEmit` ✓ clean,
  `npm test` → **1222/1222**. CI `verify` re-runs it.
- The `deploy.yml` change is conditional + fallback, so the post-merge auto-deploy
  behaves exactly as before until `~/.config/agentic-trading/deploy.env` exists.

## Follow-ups (operator, on the box — cannot run from the cloud agent)

1. Create the Infisical **Machine Identity** for the `agentic-trading` project; get
   its universal-auth token.
2. `INFISICAL_TOKEN='…' bash scripts/infisical-prod-cutover.sh` — writes the
   bootstrap, imports `.env.local`, switches PM2 to `start:secrets`, verifies boot.
3. Confirm, then `bash scripts/infisical-prod-cutover.sh --scrub --no-restart` to
   trim `.env.local`.
- Shared App-A/B secrets live in the `shared-at-ct` project — reference them into
  `agentic-trading` (Infisical cross-project references) so the single runner sees
  them.
- Optionally run the Litestream sidecar under `infisical run` too (its R2 creds).
