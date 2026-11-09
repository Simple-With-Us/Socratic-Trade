# 2026-08-04 — Slim Docker image so Coolify deploys stop timing out [GROK]

## Context & Objective

After merging the full open-PR drain (#2367–#2371, #2375, #2381) to `main`,
production stayed frozen on `6ad913d5` (#2378). Coolify webhooks queued
correctly (`Deployment queued`), but every subsequent build **failed** during
the final inter-stage copy.

## Root cause

Coolify's Horizon job aborts the remote `docker build` at ~30 minutes
(`DeploymentException` / exit 255 from `docker exec … bash /artifacts/build.sh`).

The production Dockerfile was:

```dockerfile
COPY --from=build --chown=node:node /app /app
```

That copies the **entire** build tree (full `npm ci` node_modules including
devDependencies, `.next` including cache, tests, docs, …) and rewrites
ownership file-by-file. Resulting images were ~3.96 GB. Under concurrent
load on the Oracle box (congress-trade + usage-monitor builds), the COPY
layer alone ran long enough to hit the 30-minute kill — even after
`next build` had already succeeded (~7–8 min).

Evidence from Coolify `application_deployment_queues`:

- Last finished: id 137, commit `6ad913d5`, 2026-08-03 23:57Z
- Failed: 140/144/147 (timeout or COPY hang), 156 (killed stuck COPY), 162
  (HEAD `8a50fd51` — next build DONE 452s, then exit 255 at ~30 min wall clock)

## Changes Made

- Added `.dockerignore` so build context excludes `node_modules`, `.next`,
  `test`, `docs`, `ios`, agent state, local data hoards, env files.
- Slimmed `Dockerfile`:
  - `npm prune --omit=dev` + drop `.next/cache` after build
  - Drop non-runtime trees before the runtime stage
  - Replace `COPY --chown=… /app /app` with `COPY` + single `RUN chown -R`
  - Install `tar`/`gzip` in runtime (start script unpacks litestream/infisical)
- Touched files:
  - `Dockerfile`
  - `.dockerignore` (new)
  - `docs/rollouts/2026-08-04-docker-slim-deploy.md` (this file)
  - `docs/EFFORT-LOG.md` / live board (PR drain → deploy unblock)

## Decisions & Trade-offs

- Did **not** switch to Next `output: 'standalone'` in this PR — that changes
  the start command and needs a separate verification pass. Prune + no
  `--chown` on the inter-stage copy is the minimal fix for the timeout class.
- Cancelled intermediate Coolify queue entries (dependabot intermediate SHAs)
  during the incident so only HEAD re-deploys after this lands; no manual
  Coolify API deploy trigger (ANNOUNCE-THEN-DEPLOY is retired).

## Verification State

- Local: Dockerfile + dockerignore authoring only; full image build left to
  Coolify (box is the production build host).
- After merge: `bash scripts/verify-deploy-sha.sh` must show live SHA contains
  the merge commit; `/api/health` `ok=true`, `db=ok`, litestream replicating.

## Follow-up: dockerignore hole (deploy 170)

First post-merge build failed at `next build`:

```
Module not found: Can't resolve '../../../../docs/benchmarks/2026-07-10-mistral-rebench.json'
```

Cause: `.dockerignore` excluded all of `docs/`, but
`app/api/llm-usage/model-stats/route.ts` statically imports two
`docs/benchmarks/*.json` files. Fixed by allowing `docs/benchmarks/**` and
only pruning non-benchmark docs after build.

## Next Steps & Blockers

1. Merge this PR → auto-deploy via webhook.
2. Watch Coolify deployment for HEAD until `finished` (target wall clock ≪30m).
3. `bash scripts/verify-deploy-sha.sh origin/main`.
4. Optional follow-up: Next standalone output for sub-1 GB images; raise Coolify
   Horizon timeout only as belt-and-suspenders (root fix is image size).

## Follow-up 2: drop RUN chown entirely

Deploy 171 reached `next build` DONE (186s) and prune DONE (127s) then sat
in `RUN chown -R node:node /app` for 20+ minutes and would have timed out
again. Recursive chown on pruned node_modules is still too slow on this box.

Fix: omit ownership rewrite. Image files stay root-owned 755/644 (readable by
`USER node`); writable state is on the Coolify `/app/data` volume.

## Follow-up 3: USER root (deploy 173 crash-loop)

Image built cleanly (~15m, no chown hang) but the new container Restarting(1):
Coolify "New container is not healthy, rolling back". Cause: `USER node` cannot
write under root-owned `/app` for `coolify-prod-start` (mkdir `/app/data/.bin`,
download litestream/infisical). Switch runtime USER to root for Coolify.

## Follow-up 4: strip scripts/eval before next build

Deploy 174 image started then Restarting(1). Build log: Next typecheck failed
on `scripts/eval/run-faithfulness.ts` importing `test/fixtures/...` which is
dockerignored. Incomplete/broken `.next` still packaged → crash loop.

Fix: `rm -rf scripts/eval test` before `npm run build` (+ dockerignore
`scripts/eval`).

## Follow-up 5: rebuild better-sqlite3 for bookworm glibc

Deploy 175 built and started but healthcheck got HTTP 500:

```
libm.so.6: version GLIBC_2.38 not found
(required by node_modules/better-sqlite3/prebuilds/linux-arm64.node)
```

better-sqlite3@13 (PR #2371) prebuilds need glibc ≥2.38; bookworm-slim has 2.36.
Fix: `npm rebuild better-sqlite3 --build-from-source` after `npm ci` (python3/make/g++ already in the build stage).

## Follow-up 6: rebuild AFTER prune; delete prebuilds

Deploy 177 still failed with GLIBC_2.38 — `npm prune --omit=dev` re-extracted
the incompatible prebuild after the earlier rebuild. Fix: after prune,
`rm -rf node_modules/better-sqlite3/prebuilds` then
`npm rebuild better-sqlite3 --build-from-source`.
