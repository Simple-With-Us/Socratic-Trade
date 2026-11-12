# 2026-10-03 — Infisical sole-source-of-truth rollout (fleet directive)

## Context & Objective

Fleet-wide owner directive 2026-10-03: Infisical is the sole source of truth — secrets, env
vars, AND tunable settings knobs.  App-level settings load at startup into a memory cache
with background refresh (never per-request fetches); per-user settings stay in the app's own
store; admin edits write back to Infisical automatically.  Socratic-Trade was already
strict-Infisical for secrets (2026-09-18: no .env files, `scripts/infisical-run.mjs` injects
at boot); this change adds the canonical cache/refresh/write-through contract on top.
Config plumbing only — no strategy/behavior changes: effective knob values are identical at
every point.

## Changes Made

- New `src/lib/infisical-settings.ts`: settings service reusing `createInfisicalSettings`
  from `@jaywedgeworth22/congress-trading-shared` (zero new runtime deps).  Startup load
  into an in-memory Map (shared project first, app project shadows — the repo's 2026-08-20
  merge order); memory-only reads (`peekSetting`/`getSetting`/`getRequiredSetting`/`has`);
  5-min background timer + SIGHUP handler; `setSetting()` write-through (Infisical FIRST,
  then cache; failed write fails the save).  Two credential modes: credentialed (full
  contract) and uncredentialed (production — the runner scrubs bootstrap creds by design —
  seeds the cache from the boot-injected env; refresh/write-through unavailable and loudly
  reported).  Init is fail-soft: a failed credentialed init falls back to the boot-env
  snapshot rather than failing boot.
- `src/lib/server-knobs.ts`: the env layer of knob resolution now reads the live settings
  cache (`peekSetting`, falls back to `process.env` pre-init — identical source).  New
  `writeServerKnobThrough(id, value)`: Infisical → cache → DB override; `null` clears only
  the override.
- `app/api/admin/server-knobs/route.ts`: POST is now write-through (502 + no DB write when
  the Infisical write fails); GET payload gains the `settings` status block.  Still
  `requireAdmin`-gated (403 for non-admins).
- New `app/api/admin/settings-reload/route.ts`: admin-only on-demand cache refresh (the
  "Reload settings" admin action); GET returns status.
- `instrumentation.ts`: `await initInfisicalSettings()` at server boot (after the secrets-manager guard).
- `INFISICAL.md` (root): policy, key inventory (16 knob keys, secret categories, env config),
  explicit per-user boundary, cache/refresh/write-through contract, rotation notes, the
  credentialed/uncredentialed modes, agent guidance.
- `AGENTS.md`: new "Infisical sole source of truth (fleet, 2026-10-03)" paragraph pointing at `INFISICAL.md`.
- `package.json` / `package-lock.json`: `@jaywedgeworth22/congress-trading-shared` bumped
  `#v2.7.0` → `#v2.7.1` (exact-tag pin per the fleet pin convention in
  `scripts/check-shared-package-pin.mjs`; `createInfisicalSettings` landed in v2.7.1 —
  verified jaywedgeworth22 and Simple-With-Us tags are the same commit).
- `test/infisical-settings.test.ts`: 13 tests (startup merge, zero-network reads,
  write-through ordering incl. an in-flight cache probe, failed-write rejection,
  failed-refresh last-known-good, uncredentialed seed/refusal, init-failure fallback,
  knob write-through incl. DB-untouched-on-failure, stale-env preference).
- Seeded the 16 knob keys (non-sensitive defaults) into the `socratic-trade` Infisical
  project `dev` environment.

## Decisions & Trade-offs

- Did NOT rewrite the 451 direct `process.env` read sites: they are boot-injected from the
  same Infisical source, so they are already SOT-sourced; the new cache adds live refresh
  for the knob layer without a behavior-risk diff in a live trading console.
- Kept the DB override layer in knob resolution (override > cache > env > default): the
  operator's existing fast local flip semantics are preserved; write-through keeps Infisical
  as the SOT.
- Kept the exact-tag `jaywedgeworth22` dep pin instead of the brief's
  `Simple-With-Us#semver:^2.7.1` suggestion: the repo's pin-check convention cross-checks ST
  vs Usage-Monitor on that exact pin, and both tags resolve to the same commit.
- Deliberately env-only (not UI knobs): provider-protection interlocks
  (`PROVIDER_RATE_LIMIT_DISABLED`, …), DR snapshot switch, boot-time SDK wiring — a UI
  mis-click must not remove them.  Still adjustable via Infisical.
- Per-user settings (LLM budgets, broker keys, source/proxy settings, notification prefs)
  stay in SQLite — explicitly out of scope per the canonical pattern.

## Verification State

- `npx tsc --noEmit`: clean, 0 errors.
- `npm run lint` (full `eslint .`): 0 errors (warnings all pre-existing in unrelated files; the one warning in `instrumentation.ts` is pre-existing, shifted line numbers only).
- `npx vitest run` on the 8 test files touching the changed surface: 105/105 pass, including the 14 new tests in `test/infisical-settings.test.ts` (startup merge, zero-network reads, write-through ordering with an in-flight cache probe, failed-write rejection, failed-refresh last-known-good, uncredentialed seed/refusal, init-failure fallback, knob write-through incl. DB-untouched-on-failure, stale-env preference).
- Full `npm test` (~723 tests) not completed locally: the shared VM is under heavy parallel load (load ~12-24, /tmp full) and full-suite runs kept getting OOM-killed / disk-full on temp DBs.  CI `verify` runs the full suite and gates auto-merge.
- `npm run build`: could not complete locally — the Next.js build was OOM-killed twice on this shared 8 GB VM (load 10-16 from parallel fleet work; 8 GB RAM).  Not a code signal: `tsc --noEmit` (the type gate the build re-runs) is clean and the import graph was verified edge-safe.  CI `verify` runs the full build on GitHub-hosted runners and gates auto-merge, so a red build cannot merge.
- Seeded dev env verified by key names/metadata only (no values printed).
- Environment notes for the next agent: /tmp is 512MB and fills up (sibling clones) — run vitest with `TMPDIR=~/workspace/.sot/tmp`; `npm ci` needs `--ignore-scripts` here (node-gyp fchown EPERM as root) + manual `node-gyp rebuild` for better-sqlite3 with pre-staged headers in `~/.cache/node-gyp/24.20.0`.

## Next Steps & Blockers

- After merge: verify on prod that the settings status block in Admin > Operations shows
  `credentialed: false` (expected — runner scrubs creds) and knob flips still land the DB
  override with `infisicalWriteThrough: false`.
- `staging`/`prod` knob values in the `socratic-trade` Infisical project are operator-managed;
  only `dev` was seeded.
- Owner input if wanted: whether a future change should make the prod runner pass a
  short-lived token to the app for live refresh + true write-through (rejected for now —
  it would weaken the no-bootstrap-credential-in-app posture).

## Zero-Code Findings

None — code changed as above.
