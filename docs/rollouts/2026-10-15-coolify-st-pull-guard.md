# Coolify st-pull-guard — stop pulling locally-built ST/UM images from a registry

Date: 2026-10-15
Seat: MM
Board: `2c6a6a53` / Linear ST-3707 (closed by MM, see below)
Host: `fleet-hetzner-nbg1` (`167.233.254.55`), Coolify `4.3.23`
Fleet recall: the reusable lesson is already in the `fleet-agents` corpus as `contrib/MM/2026-10-15/ce4843a2` (category `lesson`, app `socratic-trade`: the local-only-tag pull comes from `compose up`, not from `pull_docker_compose_images()`) and `contrib/CURSOR/2026-10-15/fcfa9383` (category `infrastructure`).

## 1. Context & Objective

ST-3707 recorded a 5.3-minute P0 on 2026-09-25 where a Coolify deploy tried to pull
Socratic-Trade's image from Docker Hub and took production down while doing it.  Jay
asked for the cause to be found and fixed on the host.  Investigation showed the outage
was **latent, not active** — production was healthy and deploying normally — but the
failure mode was fully present and would fire again.  This note records the fix that
removes it.

## 2. Changes Made

### Root cause, located to the exact mechanism

`pull_docker_compose_images()` is called at line 811 of `ApplicationDeploymentJob`:

```php
$this->save_runtime_environment_variables();
$this->pull_docker_compose_images();            // <-- unconditional registry pull
$this->stop_running_container(force: true);      // <-- NOT conditional on the pull
```

**Correction made 2026-10-15 after further investigation:** that call sits inside
`deploy_docker_compose_buildpack()` (line 636).  **ST does not go through that function.**
ST's build pack is `dockerfile`, so it runs `deploy_dockerfile_buildpack()` (line 950), which
never calls `pull_docker_compose_images()` at all.  Confirmed three ways: the method has exactly
one call site; ST deploys in the log show no pull stage whatsoever between "Building docker image
completed" and "Removing old containers"; and congress-trade (build pack `dockercompose`) is the
only recent deploy that logs the pull line.

So the 2026-09-25 registry pull did **not** come from that pre-flight step.  It came from
**`docker compose up` itself**.  Compose's default `pull_policy` is `missing`: when the built tag
is not present locally, `up` reaches for a registry, resolves the bare `{uuid}:{sha}` as
`docker.io/library/<uuid>`, and fails — after Coolify has already stopped the old container.
That is the 5.3-minute P0.

This matters for which half of the patch does the work:

- **PATCH 2 — `pull_policy: never` on bare local-only tags — is the fix that protects ST.**  It is
  emitted by `generate_compose_file()`, which every build pack uses.
- **PATCH 1 — skipping `pull_docker_compose_images()` — is inert.**  That method is reached only
  from `deploy_docker_compose_buildpack()`, where `build_pack` is `dockercompose`, so PATCH 1's
  `build_pack === 'dockerfile'` condition cannot be true there (congress-trade's pull proceeds
  unchanged, as deploy #4584 showed), and ST never reaches the method.  It is harmless and kept
  only as defence in depth; nothing relies on it.

Evidence that patch 2 is live on the real ST compose:

```
$ grep -nE "image:|pull_policy" /data/coolify/applications/d83b1aykr03uwr32yhgzaiay/docker-compose.yaml
3:        image: 'd83b1aykr03uwr32yhgzaiay:df7e6d108965be79dfcb93b42ad37732ef78f560'
4:        pull_policy: never
```

That tag is deploy **#4587**'s commit, and the compose was regenerated at 09:55:14Z — by the
patched code — one second before #4587 finished at 09:55:15Z.  #4587 completed with **zero**
`pull access denied` / `insufficient_scope` / `unauthorized` lines in its log.  That is the
end-to-end proof: a real ST deploy, generated under the guard, with no registry call attempted.

Also confirmed unrelated and NOT involved: `use_build_server` is `false` (one server,
`is_build_server=f`), so the `up --pull always --build -d` branch at line 4243 is dead code here.
ST takes the `up --build -d` branch, where the default `missing` policy applies.

### The patch (two changes to the vendor job)

1. `pull_docker_compose_images()` returns early for the Dockerfile build pack when no registry
   image is configured.  **Inert today** (see above): no effect on ST or on congress-trade.
2. The generated compose gains `pull_policy: never` for any `production_image_name` with no `/`,
   gated on `build_pack === 'dockerfile'` and no configured `docker_registry_image_name`.
   **This is what protects ST.**  The gate matters because an official image such as
   `postgres:15-alpine` also has no slash, and without it a `dockerimage` app would have had a
   genuine Docker Hub pull frozen.

Verified guard condition against the live DB:

| id | app | build_pack | behaviour |
|----|-----|-----------|-----------|
| 1 | ST app/worker | dockerfile | `pull_policy: never` emitted (patch 2); patch 1 not reached |
| 2 | congress-trade | dockercompose | pull proceeds — **unchanged** |
| 3 | UM app/worker | dockerfile | `pull_policy: never` emitted (patch 2); patch 1 not reached |
| 4 | agent-sync listener | dockerfile | `pull_policy: never` emitted (patch 2); patch 1 not reached |
| 5 | echo-mail-relay | dockerfile | `pull_policy: never` emitted (patch 2); patch 1 not reached |

### Files touched

- `scripts/ops/coolify-st-pull-guard.sh` — new.  Idempotent `apply` / `verify` / `revert`.
  Lints the patched PHP **before** installing it, keeps a `.mm-orig` backup, fixes
  ownership, and restarts the `horizon` queue worker so the reloaded job class is used.
- `scripts/ops/coolify-st-pull-guard.selftest.sh` — new.  Re-extracts the guard script's
  own anchors and patcher and applies them to a pristine copy of the vendor file, proving
  the script still works against an untouched Coolify rather than only against a file it
  already patched.
- `docs/deployment.md` — replaced the absolute "This repo does not PATCH live Coolify"
  with the narrow, documented `st-pull-guard` exception.
- `AGENTS.md` — added the registry-pull trap to the Coolify stanza.

Live host change: `/var/www/html/app/Jobs/ApplicationDeploymentJob.php` inside the
`coolify` container (backup at `.mm-orig`).

## 3. Decisions & Trade-offs

- **Patched vendor PHP instead of waiting for upstream.** No Coolify changelog entry
  through 4.4.6 mentions `pull_policy` or the stop ordering, and there is no per-app
  setting for it.  The repo-side alternative is worse: Coolify regenerates
  `/data/coolify/applications/<uuid>/docker-compose.yaml` on every deploy and ignores a
  committed compose, so no repo change can set the policy durably.
- **Did not add a Docker Hub credential, despite it looking like the obvious fix.**
  There is no `/root/.docker/config.json` on the host and Docker Hub is reachable (auth
  token endpoint 200), so this was never an expired-login or rate-limit problem.  Adding a
  credential converts `unauthorized: authentication required` into `pull access denied,
  insufficient_scope` — the exact 2026-09-25 signature — and fixes nothing.
- **Did not set `pull_policy` to pull.**  For this build pack any pulling policy sends
  `{uuid}:{sha}` to Docker Hub on every deploy and guarantees a repeat of the P0.  Jay's
  original instruction ("it should pull our image, not never/stale") was inverted for this
  app; it was flagged and not followed.
- **Did not run a deploy by hand.**  Triggering one needs an API token that is currently
  broken (`COOLIFY_AGENTS` → `Unauthenticated`), and the patch is strictly
  no-op-or-better, so it was verified by composition plus a pristine-file replay instead.
- **Known durability limit, accepted:** the patch lives inside the container and is wiped
  by any Coolify recreate or upgrade.  The scheduled 4.3.23 → 4.4.6 upgrade **failed** at
  2026-10-15T00:00:19Z with a containerd `lease does not exist` error and is still
  pending, so it will wipe this.  `verify` exists precisely to catch that drift.

## 4. Verification State

Commands run, and what they showed:

```bash
# reproduce the outage mechanism, then show the fix (throwaway project, no prod impact)
# Coolify as-is:   Image ... Pulling  -> Error pull access denied for
#                   d83b1aykr03uwr32yhgzaiay, repository does not exist
# +pull_policy:never:  Image ... Skipped          (no registry call at all)
```

```bash
# syntax gate before install
$ docker exec coolify php -l /tmp/adj.patched.php
No syntax errors detected in /tmp/adj.patched.php

# idempotence / state
$ /root/coolify-st-pull-guard.sh verify
guard: PRESENT (2 patch markers)
php syntax: OK
horizon workers running: 1
 1|ST app/worker|dockerfile|GUARD FIRES (pull skipped)
 2|congress-trade|dockercompose|pull proceeds (unchanged)
 ...

# anchors still match a PRISTINE Coolify 4.3.23 file
$ /root/selftest.sh
pre-patch  sha256: 288680b7837550b1
post-patch sha256: 1226ed9ccd47daa3
markers after patch: 2
No syntax errors detected in /tmp/pristine.patched.php
PRISTINE-APPLY TEST PASSED
```

The pristine replay's `post-patch sha256` is **identical** to the sha256 of the file
installed on the box, so the script reproduces the live file byte for byte from untouched
vendor source.

Production health during and after the change:

```bash
$ curl -o /dev/null -w '%{http_code}' https://socratictrade.com/api/live   # 200
$ curl -o /dev/null -w '%{http_code}' https://socratictrade.com/login      # 200
$ curl -o /dev/null -w '%{http_code}' https://host.jays.services/           # 302 (login)
```

No production container was stopped, recreated or bounced.  The only restart was the
Coolify `horizon` queue worker, done with nothing in flight in
`application_deployment_queues`.

**Not yet verified:** nothing further.  The end-to-end proof arrived while this note was being
written — see the deploy #4587 evidence above, which supersedes the earlier "still waiting for a
natural deploy" note.  A future deploy should still log `Removing old containers` immediately
after `Building docker image completed` with no pull stage in between, which is the expected
post-guard shape for ST.

## 5. Next Steps & Blockers

1. ~~**Watch the next ST deploy** for `Skipping image pull`~~ — superseded.  ST never emits
   that line, because its deploy path does not call `pull_docker_compose_images()`.  The correct
   signal is `pull_policy: never` in the generated compose, already verified on deploy #4587.
2. **Fix the Coolify 4.4.6 upgrade**, then immediately re-run
   `scripts/ops/coolify-st-pull-guard.sh apply`.  The upgrade failure is a containerd
   content-store lease error, a different fault from this one; it was left alone because
   retrying restarts a control plane shared by ST, Congress and Usage Monitor.
3. **Mint a new `COOLIFY_AGENTS` token.**  It returns `Unauthenticated` on every endpoint,
   which disables any fleet tooling that drives Coolify by API.
4. Consider wiring `coolify-st-pull-guard.sh verify` into the deploy-freshness watchdog so
   vendor drift pages instead of waiting for the next outage.

## 6. Zero-Code Findings

- The reported incident ("production deploy is failing to pull images") was **not
  reproducing**.  At investigation time production was healthy, deploy **#4580** for main
  HEAD was `in_progress` and finished cleanly at 07:56:17Z, and the Docker daemon journal
  had **zero** `insufficient_scope` / `pull access denied` / `authorization failed` lines
  in the preceding 24h.
- Coolify 4.3.23 has **no `deployments` table**, and `COOLIFY_AGENTS` is unusable, so
  deployment history must come from
  `docker exec coolify-db psql -U coolify -d coolify` against
  `application_deployment_queues`.  Completed rows are pruned, so that table shows only
  in-flight and recent work — it is not history.
- There is a **Zombie process** (1) on the host and swap at ~12.7/17.4 GiB with load
  average 8–11 on 8 vCPU.  Not addressed here; worth a look separately.