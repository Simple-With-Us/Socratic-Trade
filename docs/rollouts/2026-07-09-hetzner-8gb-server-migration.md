# 2026-07-09 — Hetzner server migration: 91.98.44.8 (4GB fsn1) → <HETZNER_OLD_IP_RETIRED> (8GB hel1)

## Summary

Owner-directed migration of the entire production hosting box. The 4 GB Falkenstein
server (`ubuntu-4gb-fsn1-1`, `91.98.44.8`) that ran Coolify + `socratic-trade-prod`
(= socratictrade.com) + the `github-runner` service repeatedly hit memory/disk limits
(OOM-wedged builds 2026-07-07/08, disk-full 500s, 76%-disk pages). The owner provisioned
an 8 GB Helsinki server (`ubuntu-8gb-hel1-2`, `<HETZNER_OLD_IP_RETIRED>`, 75 GB disk, 4 vCPU,
same `~/.ssh/hetzner` key) and asked CLAUDE (this session) to move everything and flip
Cloudflare DNS.

## Why full-instance migration (not app re-create)

The Coolify Postgres DB carries the GitHub App source (`usl7brir061hoh21lhad31dv`,
GitHub App ID 4238447) whose setup required an owner OAuth dance in the Coolify UI
(2026-07-07 blocker). Copying the DB + `/data/coolify` (incl. `source/.env` APP_KEY that
encrypts DB secrets, and `ssh/keys` the instance uses to reach its own host) preserves
that, plus all app envs, domains, deploy history, and the API token. Re-creating apps
via the API recipe would have re-introduced the owner-interactive GitHub App step.

## Method

1. **Prep (prod up):** pinned-version Coolify install on the new box
   (`install.sh 4.1.2`, `AUTOUPDATE=false`), image pre-pulls, temp `migration_key` for
   direct box→box transfer.
2. **Control plane (prod up):** `pg_dump -Fc` of `coolify` DB + tar of `/data/coolify`
   → restore on new box (fresh `coolify-db` volume so Postgres re-inits with the
   restored `.env` credentials, then `pg_restore --clean`), append the instance's
   `ssh/keys/*` public keys to `/root/.ssh/authorized_keys`.
3. **Cutover (brief downtime, after market close + #ag***-s**c announce):**
   `docker save | load` of the freshly built prod image (skips a cold ~40-min nixpacks
   rebuild on the new box); stop old app + runners (SIGTERM → litestream final sync;
   single-writer/single-scheduler invariant held — the old app was stopped before the
   new one started); tar-copy the `m1os7ijf31bg3fanil152e4b-prod-app-data` volume
   (restore marker travels with it, so boot skips the R2 restore); start traefik +
   the app from Coolify's generated compose; flip six Cloudflare A records
   (`jays.services` apex + `*` + `prod`; `socratictrade.com` apex + `*` + `admin`) from
   `91.98.44.8` → `<HETZNER_OLD_IP_RETIRED>`; verify health through the edge.
4. **Decommission-standby:** all old-box containers stopped with `--restart=no`
   (a reboot must NOT resurrect the old scheduler — double-trading risk). Box left
   intact as rollback until the owner deletes it in the Hetzner console.

## Coordination

- #ag***-s**c claim posted 2026-07-09 ~17:49 CDT with a deploy-hold request; cutover
  waited for the in-flight `c4d1bfa` console-hang-fix deploy (another CLAUDE session)
  to finish, plus the 10-minute objection window. Market closed throughout.

## Files

- `docs/rollouts/2026-07-09-hetzner-8gb-server-migration.md` (this note)
- `AGENTS.md` — IP/box references updated to the new server
- `STATUS.md`, `docs/EFFORT-LOG.md` + live board — migration effort rows
- No application code changed.

## Verification

All run 2026-07-09 ~18:10–18:20 CDT (23:10–23:20Z), after cutover:

- `https://socratictrade.com/api/health` → 200 `{"ok":true, db:"ok"}`, scheduler tick age
  26 s; `socratictrade.com` / `prod.jays.services` / `admin.socratictrade.com` → 307
  (login redirect, normal); `https://jays.services` → 302 (Coolify dashboard alive).
- App boot log: Infisical merged 51 shared + 101 app secrets; `DB_BOOTSTRAP=live` went
  straight to `litestream replicate` (NO R2 re-restore — copied volume used as-is);
  Next.js Ready; scheduler started. Litestream replica txid == db txid (caught up,
  single writer — old app was stopped before the new one booted).
- Coolify on the new box: API answers with the restored token (`/api/v1/version` →
  4.1.2, same as old box; `latest` image tag currently resolves to it), sees
  `socratic-trade-prod` `running:healthy`, and successfully executed the
  `github-runner` service start over SSH to its own host (proves the restored server
  key + `authorized_keys` wiring). Both runners: "√ Connected to GitHub … Listening
  for Jobs". `github-runner` shows `degraded:unhealthy` exactly as it did on the old
  box (no container healthcheck — cosmetic, pre-existing).
- Old box: 0 running containers, every container `--restart=no` (a reboot cannot
  resurrect the old scheduler — the double-trading hazard is structurally closed).
- The in-flight `c4d1bfa` deploy on the OLD box **failed during its nix phase with
  memory exhaustion** (`TCP: out of memory` in dmesg) while this migration waited on
  it — the 4 GB box could no longer complete even a single cold build. Prod cut over
  on the last good image `83e80953…` (the exact image that was serving).

## Known regression found & root-caused (needs one owner action)

`[congress-stream] SSE connect failed: HTTP 403` from the new box (old box: 0 such
errors in 3 h). Root cause: the `congress.trade` zone runs Bot Fight Mode and had a
Cloudflare **IP Access Rule whitelisting `91.98.44.8`** ("CI self-hosted runner …
bypass Bot Fight Mode for deploy health/migrate"). The new IP needs the same rule:
whitelist `<HETZNER_OLD_IP_RETIRED>` on the `congress.trade` zone (then delete the old-IP rule
at decommission). The permission classifier declined to let this session create a
firewall rule on a zone outside the migration scope — deliberate, surfaced to owner.
Also affects Congress.Trade CI health checks from the relocated deploy runners.
`alpha-vantage: ok:false` in health is pre-existing (the AV key-pool code ships with
the next deploy), not migration-caused.

## Deliberately NOT done

- **No new-code deploy was triggered.** Prod runs the same image as before cutover.
  Main HEAD (`6363e1e7`, incl. the console-hang fix + #1222 TwelveData fix + #1221
  short-stop default) awaits a normal ANNOUNCE-THEN-DEPLOY release on the new box —
  which will also be the first proof of the 8 GB build path.
- The old-IP whitelist on `congress.trade` was not replaced (see above).

## Rollback

Old box left stopped-but-intact. Rollback = stop new-box app container, `docker start`
the old-box Coolify stack + app container, flip the six A records back to `91.98.44.8`.
The `migration_key` temp SSH key (new box → old box) should be removed from the old
box's `authorized_keys` at decommission time.

## Follow-ups

- Owner: delete the old 4 GB server in the Hetzner console after a soak period
  (it still bills while it exists; no Hetzner API/MCP access in this session).
- Revisit `concurrent_builds=1` — the 8 GB box may tolerate 2, but keep 1 until proven.
- Update any stale notes still calling `91.98.44.8` "the box".

## Same-evening follow-ups (2026-07-09 ~19:00–21:00 CDT)

- **congress.trade fixed:** owner authorized the IP Access Rule (whitelist
  `<HETZNER_OLD_IP_RETIRED>`, Bot Fight Mode bypass, rule id `00ce7036ca114749a31cdcc0bc031503`);
  congress-stream SSE and the health dependency went `ok:true` immediately.
- **First 8 GB build proven:** AG took the deployer seat (CLAUDE's trigger was
  permission-blocked; claim withdrawn on #ag***-s**c); the deploy built main HEAD from
  scratch and shipped image `a8b0185b…` healthy — the exact build class the 4 GB box
  OOM-failed on.
- **DOMAIN RENAME (owner-directed): the Coolify dashboard/API moved from the apex to
  `https://host.jays.services`.** Owner changed the instance FQDN + renamed the DNS
  record; apex `jays.services` now CNAMEs to the Mac Cloudflare tunnel (does NOT reach
  Coolify) and the `*.jays.services` wildcard A record was deleted. References updated:
  AGENTS.md, STATUS.md, this note, effort logs, `/Users/jay/apps/AG***-S**C.md`, Claude
  Desktop `coolify` MCP `COOLIFY_BASE_URL`, agent memory. Fleet broadcast posted on
  #ag***-s**c.
- **Coolify API token rotated:** the previously stored token returns `Unauthenticated`
  everywhere (including loopback) since the owner's UI session — agents need a fresh
  token via the secret-handoff protocol before Coolify API work.
- **Still open:** GitHub App (`socratic-trade`) webhook URL on github.com still points
  at the apex — update to `https://host.jays.services` (owner, in the GitHub App
  settings; low impact while auto-deploy is OFF). Old-server deletion after soak.

## Decommission close-out (2026-07-10)

- Owner updated the GitHub App webhook URL to `host.jays.services` and **deleted the old
  `91.98.44.8` server** in the Hetzner console (SSH confirmed unreachable).
- CLAUDE removed the temp `migration_key` keypair from the new box and deleted the
  obsolete old-IP whitelist rule on the `congress.trade` zone (owner-directed).
- **No standby box remains** — the DB rollback path is the litestream R2 replica
  (`trading-live-backups/trading-live/app.db`), restored by `coolify-prod-start.sh`'s
  marker-guarded boot on a fresh volume.
- Post-migration connections check (prod DB `api_health_log` evidence): all dependencies
  healthy except (a) alpha-vantage — pool works but AV enforces its 25/day cap PER IP, so
  the 6-key rotation yields 25/day total from one box (flagged to MONET's lane on
  #ag***-s**c; design decision theirs); (b) tiingo — free-tier hourly 429 burst at the
  08:00Z scan, self-heals. Neither is migration-related.
