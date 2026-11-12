# 2026-07-10 — Auto-deploy ON: merge-to-main auto-deploys prod (retires announce-then-deploy) (MONET)

> **2026-08-18:** ASC applied Coolify `watch_paths` on `socratic-app`
> (docs/ios/test omitted).  Do not re-apply.  Weekday RTH image builds are
> still refused unless `HOTFIX=1` / `RTH_DEPLOY_OVERRIDE=1`.  Docker
> HEALTHCHECK is `/api/live`.  See
> `docs/rollouts/2026-08-18-rth-deploy-latch.md`.

## Summary

Owner-directed (in-conversation): the "merged to `main`" vs "deployed to production" distinction was
pure friction for the owner, so production now **auto-deploys on every push to `main`**. Merge → live,
no manual step. This **retires the ANNOUNCE-THEN-DEPLOY protocol** — agents no longer post deploy
claims or manually trigger Coolify deploys.

Proven end-to-end 2026-07-10: webhook-triggered deploy `e9e9138b` (`is_webhook = t`) built and reached
`finished`; prod = `main` HEAD, healthy.

## Why it wasn't already working (two layers, both fixed)

Coolify's native GitHub-App auto-deploy was in place but dormant for two reasons:

1. **`is_auto_deploy_enabled` was `false`** on the `socratic-trade-prod` app (uuid
   `m1os7ijf31bg3fanil152e4b`). Coolify exposes this only in its DB / UI toggle, not the public REST
   API, and the API is unreachable from outside anyway (see below). Flipped to `true` via the box:
   `UPDATE application_settings SET is_auto_deploy_enabled=true WHERE application_id=(SELECT id FROM
   applications WHERE uuid='m1os7ijf31bg3fanil152e4b');` (single boolean, exactly what the UI toggle
   sets; reversible).

2. **GitHub's push webhooks were being 403'd at the Cloudflare edge.** The `jays.services` zone (which
   fronts Coolify at `https://host.jays.services`) uses **Cloudflare IP Access Rules (mode=whitelist)**
   — the same IP-allowlist pattern the congress zone uses — so any non-whitelisted source, including
   GitHub's webhook servers, gets a hard 403 (this is also why the Coolify REST API is unreachable from
   a dev machine). Every historical deploy was `is_webhook = f` (manual) as a result. **Fix:**
   whitelisted GitHub's documented **webhook** source ranges (from `https://api.github.com/meta` →
   `.hooks`: `192.30.252.0/22`, `185.199.108.0/22`, `140.82.112.0/20`, `143.55.64.0/20`,
   `2606:50c0::/32`). CF IP Access Rules only accept IPv4 `/16` or `/24`, so the `/22` and `/20` ranges
   were expanded into **40 `/24` blocks**; notes: "GitHub webhook delivery (Coolify auto-deploy) -
   MONET 2026-07-10". These are the STABLE webhook IPs — **not** the variable Actions-runner IPs — so
   bot protection stays fully on for all other traffic.

## Verification

- `is_auto_deploy_enabled = t` confirmed on the app.
- Post-fix, pushes to `main` produce `is_webhook = t` deploys (previously always `f`).
- End-to-end: `e9e9138b` webhook deploy reached `finished`; running container is fresh and healthy on
  `main` HEAD.

## Deploy-execution incident found while verifying (separate, pre-existing — now resolved)

Between ~08:29 and ~12:20 all deploys (manual AND auto) failed at the **git-clone** step — a transient
`github.com` connectivity window on the box (the "git-clone EOF" AG had flagged). It also left a
**zombie deploy** (`eb14dea3`, stuck `in_progress`, build container dead) holding the
`concurrent_builds=1` queue, so nothing behind it could run and prod sat on a 6-hour-old container.
Connectivity recovered on its own (`github.com` git-upload-pack → `401`/0.28s, `codeload` 0.6s);
clearing the zombie drained the queue and `ea89b23e` (then `e9e9138b`) built clean. NOT caused by this
change (clones go straight to GitHub, not through the CF edge). AG's lane owned the incident;
diagnosis handed off on `#ag***-s**c`.

## Operational notes

- **Every merge still hits Coolify immediately** (owner ruling).  As of
  2026-08-18 ASC applied `watch_paths` on `socratic-app` (do not re-apply);
  docs/ios/test/STATUS/PLAN do not start a deploy.  The image build is
  refused during weekday regular US equity hours unless `HOTFIX=1` or
  `RTH_DEPLOY_OVERRIDE=1`; evenings/weekends still swap **watched runtime**
  commits.  Docker HEALTHCHECK is `/api/live` so a finished deploy cannot
  sit `running:unhealthy` while the process is up (7:22–7:43pm CT after
  #2810).  Coolify serializes builds (`concurrent_builds=1`), so bursty
  merges queue rather than run in parallel.
- **Rollback:** set `is_auto_deploy_enabled=false` (box DB) to return to manual deploys. The CF
  whitelist rules can be removed via the CF API if ever needed.
- The GitHub Actions / self-hosted-runner alternative was NOT used (native flag + CF fix is simpler and
  needs no `workflow` scope or repo secret); the staged workflow file + `COOLIFY_DEPLOY_TOKEN` secret
  were removed.

## Follow-ups

- `AGENTS.md` deploy stanzas + `/Users/jay/apps/AG***-S**C.md` (canonical fleet protocol) updated to
  reflect auto-deploy on / announce-then-deploy retired.
- The CF whitelist adds 40 `/24` allow rules for GitHub ranges zone-wide — a small broadening scoped to
  GitHub-owned infra. A tighter WAF custom rule (skip only for GitHub IPs + the webhook path) is a
  possible future refinement (the DNS-scoped CF token could not create WAF custom rulesets this session).
