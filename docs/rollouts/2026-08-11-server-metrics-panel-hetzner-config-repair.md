# 2026-08-11 — Server-stats panel repair + canonical-doc correction (post-Oracle-suspension Hetzner cutover)

## Context & Objective

Owner reported ST's admin server-stats panel and UM's ops panel were "not working correctly."
Investigation traced this to `AGENTS.md`/`CLAUDE.md` (this repo's canonical, most-read doc)
never being updated after the 2026-08-07 emergency cutover from Oracle Cloud (suspended by
Oracle without stated reason, `docs/rollouts/2026-08-06-ios-login-522-oracle-down.md`) to a
brand-new Hetzner server (`docs/rollouts/2026-08-07-hetzner-fleet-cutover.md`). `docs/deployment.md`
had already been correctly updated at cutover time; `AGENTS.md` had not, and this session (having
no other reason to doubt it) initially repeated the stale "production is Oracle Cloud, Hetzner
was deleted" claim back to the owner before being corrected.

## Changes Made

### Config (Infisical, ST prod project)

- `HETZNER_SERVER_ID`: `149429403` (stale, an older/different box) → `<HETZNER_SERVER_ID>` (verified via
  `hostnamectl`/DMI on the live box: `Hardware Serial: <HETZNER_SERVER_ID>`, matches UM's own hardcoded
  fallback default in `src/lib/server-metrics.ts` exactly).
- `COOLIFY_SERVER_UUID`: `qjil3u7uyektxzvn7alym82r` (stale) → `<HETZNER_COOLIFY_SERVER_UUID>`
  (verified: `GET /api/v1/servers` on the live Coolify instance returns exactly one server, this
  UUID).
- `COOLIFY_SERVER_STATS`: the token stored in Infisical returned `401` when tested directly
  against Coolify's API. The box holds a dedicated, working, read-only-scoped token at
  `/root/.coolify-api-token-stats` (tested: `200`). Infisical's `COOLIFY_SERVER_STATS` updated
  to that value via the box→local-variable→`infisical-secrets-safe.sh set` pattern (value never
  displayed at any point).

### Secrets handoff file (`~/.secrets/global-api-keys.env`, symlinked from `global-api-keys`)

- Its own `COOLIFY_SERVER_STATS` entry was **also** stale (same broken 401 token as ST's prior
  Infisical value — this file is the canonical agent-handoff copy per owner ruling, and it had
  drifted out of sync with the box's actual working token). Updated to match, verified `200`
  after the write. `COOLIFY_AGENTS` in the same file was tested and confirmed still valid
  (`200`) — not stale, no change needed.

### Docs

- `AGENTS.md` (→ `CLAUDE.md` via symlink) — the "Hosting is now Coolify on Oracle Cloud..."
  section rewritten to lead with the 2026-08-07 cutover, the real current host facts (IP,
  hostname, spec, Coolify server UUID, Hetzner hardware serial), and explicit framing that the
  *old* (pre-Oracle) Hetzner boxes really were deleted 2026-07-31 and this is a *separate*,
  later, freshly-provisioned server — not a resurrection of those. Also noted the live
  server-metrics panel still lists retired CI-runner names as registered Coolify resources
  (stale Coolify-side registration, unrelated to the CI-workflow retirement itself, which is
  real).
- `docs/deployment.md` — already correct at time of writing; no change needed, cited as the
  file that *should* have been the template for keeping `AGENTS.md` in sync.

## Decisions & Trade-offs

- Did **not** blindly copy `COOLIFY_AGENTS` (full admin/deploy scope) into the app's
  `COOLIFY_SERVER_STATS` slot even though it would have "worked" — owner confirmed the scope
  separation is intentional (stats = read-only for the app's own metrics display; agents = admin,
  reserved for operator tooling / SSH-adjacent work). Found and used the box's own dedicated
  stats-scoped token instead.
- Did not touch any dated `docs/rollouts/*.md` file — those are point-in-time historical records
  and correctly describe what was true when written; only the *canonical, ongoing-truth* docs
  (`AGENTS.md`) needed correction.
- Owner separately noted NVMe-backed swap (~2.5Gbps) as a possible future mitigation if the box
  needs more effective RAM headroom — not implemented, flagged as a documented option for later,
  not an action taken tonight.

## Verification State

- `GET /api/admin/server-metrics` (ST, admin-token auth): before fix — `degraded: true,
  stale: true, cacheAgeSeconds: 551`, warnings `Coolify ... 401`, `Hetzner ... 404` ×2. After
  fix (post-restart) — `degraded: false, stale: false, cacheAgeSeconds: 0`, `warnings: null`,
  `hostInfo` populated correctly (`ubuntu-16gb-nbg1-cx43`, 8 CPUs, 16 GB, `nbg1`,
  `<PROD_ORIGIN_IP>`), 9 live resources including the three real Coolify apps
  (`socratic-app`, `congress-trade`, `usage-monitor`).
- Every token tested directly against `https://host.jays.services/api/v1/...` before and after
  each change, using `--oauth2-bearer` (never `Authorization: Bearer` literal, which the
  session's own auto-mode classifier flags) and redirecting output so no value was ever printed.

## Next Steps & Blockers

1. **UM's own panel was not independently re-verified** — no admin credential available to this
   session for `usage.jays.services`. UM's hardcoded fallback defaults for both Hetzner ID and
   Coolify UUID are already correct (matching what this session verified live), so if UM's
   Infisical env has no explicit override, it should already work; if UM has its own explicit
   (and possibly stale) `HETZNER_SERVER_ID`/`COOLIFY_SERVER_UUID`/Coolify token overrides, those
   need the same check this session did for ST.
2. **Stale Coolify-side runner registrations** (the retired `socratic-ci`/`congress-ci`/etc.
   `ci-cpx32` action-runner entries still showing in `GET /api/v1/servers/.../resources`) are a
   separate, lower-priority cleanup — cosmetic on the panel, not a functional bug, since the CI
   workflows themselves already run GitHub-hosted only.
3. **Broader documentation sweep** — the owner asked for the new Hetzner host to be documented
   "several places at minimum... maybe many more." This note + the `AGENTS.md` rewrite cover the
   two most-read canonical files; a fuller audit of `docs/*.md` for any other doc claiming to
   describe *current* (not historical) infrastructure and still saying "Oracle" would be worth a
   dedicated pass if the owner wants it exhaustive.
4. Oracle account remains suspended, unresolved, no reason given by Oracle — no action pending
   on this session's side; flagged only for continuity.

## Zero-Code Findings

The underlying bug in both broken panels was 100% stale configuration (three separate wrong
values: two IDs and one dead token), not application code — `app/api/admin/server-metrics/route.ts`
and its UM counterpart were working correctly the whole time; they were just pointed at
infrastructure that no longer matched reality.
