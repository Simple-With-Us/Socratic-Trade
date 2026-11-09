# 2026-06-25 — Switch all secret delivery to Infisical; remove the GCP path

## Summary

Collapsed the dual secrets-manager setup (Infisical + GCP) to **Infisical only**,
per operator decision. Infisical is now the single authoritative source of truth
for secret values; `.env.local` is not a secret source (git-ignored, and prod
enforces `REQUIRE_SECRETS_MANAGER=1` so the app refuses to boot off it).

Removed:
- `scripts/gcp-secrets-run.mjs` (the GCP runner).
- `dev:gcp` / `build:gcp` / `start:gcp` npm scripts.
- the `@google-cloud/secret-manager` dependency.
- `gcp` (and the unused `doppler`) from `SecretsSource` in
  `src/lib/secrets-source.ts`; the boot-guard error message and the
  `instrumentation.ts` comment now reference only `start:secrets`.

The Infisical runner (`scripts/infisical-run.mjs`) already injected
`SECRETS_SOURCE=infisical`, so the `REQUIRE_SECRETS_MANAGER` boot guard is
unchanged in behavior — it just no longer mentions GCP.

Wired the operator's Infisical identifiers into config/docs (slugs/IDs are
identifiers, not secrets; the machine-identity client SECRET stays out of the repo):
- App project **`agentic-trading`** — `agentic-trading-s-xn-n` /
  `39d93bb7-76f9-498c-8b50-a7def52e072f` (set as `INFISICAL_PROJECT_ID` in
  `.env.example`), machine identity `agentic-trading`.
- Shared App-A/B project **`shared-at-ct`** — `shared-at-ct-tg-v7` /
  `18f563a3-9c88-454c-96eb-28fc9678f3ba`, machine identity `shared-at-ct`.

## Why

Operator chose Infisical as the single secrets backend ("switch all to Infisical …
ignore all .env.local"). Keeping two managers — and the now-redundant GCP runner
shipped in #154/#157 — invited drift; one path is simpler and the enforcement
guard already exists.

## Files

- `scripts/gcp-secrets-run.mjs` — deleted.
- `package.json` — removed `*:gcp` scripts + `@google-cloud/secret-manager` dep.
- `package-lock.json` — regenerated (`npm install`).
- `src/lib/secrets-source.ts` — `SecretsSource = "infisical" | "env"`; only
  `infisical` recognized; comment + error message de-GCP'd.
- `instrumentation.ts` — boot-guard comment de-GCP'd.
- `test/secrets-source.test.ts` — asserts `gcp` is no longer a recognized manager
  (→ `env`); keeps Infisical case-insensitivity + the enforcement cases.
- `docs/secrets.md` — Infisical-only; project IDs wired; removed the
  "if secrets are already in GCP" section and GCP mentions.
- `docs/deployment.md` — "Configuration & secrets" section rewritten for Infisical
  (source of truth, runner, projects, bootstrap, `REQUIRE_SECRETS_MANAGER`
  enforcement, `ENCRYPTION_KEY`, Litestream sidecar). Defers to `docs/secrets.md`.
- `docs/ops-observability-security.md` — Production Notes: Infisical canonical.
- `.env.example` — Infisical bootstrap block: project ID filled, `shared-at-ct`
  noted, enforcement comment de-GCP'd.
- `.gitignore` — explicit comment + `**/.env.local` (already covered by
  `.env*.local`; now unambiguous).
- `PLAN.md` — topology note → Infisical.
- `STATUS.md`, this rollout note — handoff.
- Historical GCP rollout notes (2026-06-24/25) left intact as the record.

## Verification

`npm install` (drops `@google-cloud/secret-manager` + its tree from the lock) →
`npm run build` → `npx tsc --noEmit` → `npm test` (incl. the updated
`secrets-source.test.ts`). Results: `npm install` ✓, build ✓, `tsc --noEmit` ✓ clean,
**1222/1222 tests pass**.

Also `node --check scripts/infisical-run.mjs` (parses). The Infisical CLI itself is
not installed in this sandbox, so the runner's CLI-missing path (exit 127) is by
design and not exercised end-to-end here.

## Follow-ups

- **Host-side (operator):** flip production to Infisical — bulk-import the current
  `.env.local` into the `agentic-trading` prod env, set the bootstrap
  (`INFISICAL_TOKEN` machine-identity + `INFISICAL_PROJECT_ID` + `INFISICAL_ENV=prod`)
  and `REQUIRE_SECRETS_MANAGER=1` on the box, switch PM2 `trading` to
  `npm run start:secrets`, verify, then scrub `.env.local`. `deploy.yml` still
  launches plain `next start` — not rewired here (the runner/box need the Infisical
  CLI + machine-identity auth first). See `docs/secrets.md`.
- Run the Litestream sidecar under `infisical run` too so its `LITESTREAM_*` / R2
  credentials also come from Infisical.
