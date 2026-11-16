# 2026-08-18 — Coolify RTH latch, skip docs-only, /api/live for Traefik

## Context & Objective

Jay believed Coolify already refused production deploys during regular US equity
hours.  It did not.  Since 2026-07-10 every push to `main` has auto-deployed
immediately, including market hours (`docs/rollouts/2026-07-10-auto-deploy-on.md`
said so explicitly).  The blind-spots audit (`docs/audits/2026-08-17-blind-spots.md`
F-OPS-1) recorded the same gap.

ASC then produced tonight's 503 on socratictrade.com.  Keep **stop-old-first**,
consistent container name, and no rolling (one Litestream writer).  Block RTH
except `HOTFIX=1`.  Skip docs-only Coolify rebuilds.  Also stop a finished
deploy from leaving origin 503 for ~20 extra minutes while the process is
up.  Do not bounce the live box.  Do not `FORCE_RESTORE`.  Do not PATCH live
Coolify from this agent.

## Tonight's 503 (ASC refined)

Public Cloudflare `no available server` ran ~7:15–7:49pm CT.  That was **two
short docs-only rebuilds plus a 20-minute unhealthy-while-up window**, not one
stuck ~34-minute Horizon build.

| UTC | CT | What |
|---|---|---|
| 00:15:37Z | 7:15pm | #2810 merged — docs-only blind-spots (`cde3deee`) |
| 00:15:40Z–00:22:27Z | 7:15–7:22 | #2810 image build (~7m), stop-old-first |
| 00:22:27Z–00:43:42Z | 7:22–7:43 | **#2810 container running** (`litestream-runtime.log`) while public 503 continued |
| 00:43:40Z | 7:43 | #2811 merged — docs-only Pinecone audit (`23412aff`) |
| 00:43:42Z–00:49:25Z | 7:43–7:49 | #2811 image build (~6m), stop-old-first again |
| 00:49:27Z | 7:49 | `processStartedAt` — **#2811 completing**, not a stuck deploy |

`last_restart_at` null was a misread of "never came up."  The successor
process is #2811 at 00:49:27Z.  Persistent `litestream-runtime.log` has only
the two SIGTERMs (stop-old for each rebuild) and **no ERROR**.  Litestream
was not the crash.  The 7:22–7:43 window is Coolify `running:unhealthy`:
Traefik had no healthy backend even though Next and Litestream were up.

Dockerfile HEALTHCHECK used to `curl /api/health` with a 5s timeout.
`/api/health` is the rich ops probe: it can return 503 on a Pinecone/RAG/Alpaca
hard-stop, and it can exceed 5s after boot (credits + Litestream IPC).  Either
marks the named container unhealthy.  Docker does not restart `unhealthy`
(`restart: unless-stopped` only reacts to process exit) — origin stays 503
until the next swap.

Both #2810 and #2811 are image-noop (markdown + `docs/**`).  **Keep
stop-old-first** for real runtime commits (one writer).  Do not add rolling.

## Live Coolify `watch_paths` (ASC applied 2026-08-18 — do not re-apply)

ASC set `watch_paths` on Coolify app **socratic-app**
(`<ST_COOLIFY_APP_UUID>`) while the app stayed healthy.  No bounce.
Auto-deploy is still on.  Stop-old-first is kept.  `health_check_start_period`
is still **60**.  This PR must **not** PATCH or re-apply that list.

Applied (runtime / image trees only):

```
Dockerfile
.dockerignore
package.json
package-lock.json
next.config.mjs
postcss.config.mjs
tsconfig.json
middleware.ts
instrumentation.ts
instrumentation-client.ts
sentry.server.config.ts
sentry.edge.config.ts
litestream.coolify.yml
src
src/**
app
app/**
public
public/**
scripts
scripts/**
```

Omitted: `docs/**`, `STATUS.md`, `PLAN.md`, `docs/rollouts`, `ios/`, `test/`.

A later docs-only merge (#2810 / #2811 class) no longer starts a Coolify
deploy.  `docs/benchmarks/**` is also omitted (Next imports those JSON files
at build time); a benchmarks change needs a runtime-path touch or a manual
Deploy.  Do not add `docs/` from this PR.

## Stop-old-first path (kept)

1. **Coolify `watch_paths`** (already live) skips docs-only / ios / test
   pushes so stop-old-first is not taken for markdown.
2. **In-repo RTH latch** (this PR) refuses the image build during weekday
   RTH unless `HOTFIX=1` / `RTH_DEPLOY_OVERRIDE=1`.  `watch_paths` does not
   know about market hours.
3. Dockerfile image-noop exit 3 is belt-and-suspenders if someone clicks
   Deploy on a docs-only SHA.
4. For a watched runtime commit: Coolify **stop-old-first**, then start the
   new named container (one Litestream writer).  Tonight's watched-path
   builds were ~6–7 minutes.
5. Once the process is up, Traefik must see Docker `healthy` via
   `GET /api/live`.  `/api/health` stays the UptimeRobot / deploy-verify
   probe.

Owner Coolify UI (do **not** apply from this agent): do not rewrite
`watch_paths`.  If an HTTP health path is set, it must be `/api/live`, not
`/api/health`.  Leave `health_check_start_period` at 60.

## Changes Made

No prior latch existed.  The GitHub webhook to
`https://host.jays.services/webhooks/source/github/events/manual` is still
the deploy trigger (hook id `662359267` at investigation time).

The Dockerfile now runs `tsx scripts/assert-rth-deploy-latch.ts` **before
`npm ci`**:

- Exit 2 during weekday RTH unless `HOTFIX=1` (env or commit token) or
  `RTH_DEPLOY_OVERRIDE=1`.
- Exit 3 when every changed path is image-noop (docs-only / dockerignored
  trees).  `docs/benchmarks/**` is image-relevant and still deploys.
- Exit 0 otherwise (evenings, weekends, holidays, early-close afternoon,
  runtime diffs).

A refused build must keep the last healthy named container.  The check is
**not** in `scripts/coolify-prod-start.sh`.

- `src/lib/deploy-image-impact.ts` (`COOLIFY_WATCH_PATHS_LIVE` record; do not PATCH)
- `src/lib/rth-deploy-latch.ts`
- `scripts/assert-rth-deploy-latch.ts`
- `scripts/rth-deploy-drain.sh` (skips image-noop pending diffs)
- `test/rth-deploy-latch.test.ts`
- `app/api/live/route.ts` (Coolify / Traefik liveness)
- `middleware.ts` (`/api/live` public)
- `app/api/health/route.ts` (comment: not the Traefik probe)
- `test/live-route.test.ts`
- `test/middleware-auth.test.ts`
- `Dockerfile` (latch before `npm ci`; HEALTHCHECK `/api/live`)
- `.github/workflows/rth-deploy-latch.yml`
- `.github/workflows/sentry-ci-report.yml`
- `scripts/sentry-ci-report.py`
- `docs/deployment.md`
- `docs/rollouts/2026-07-10-auto-deploy-on.md` (supersede pointer)
- `AGENTS.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- this note

## Decisions & Trade-offs

- **`watch_paths` is already live.**  ASC applied it.  Do not re-apply or
  PATCH Coolify from this PR.  Auto-deploy stays on.
- **Build-time RTH latch, not webhook disable.**  `watch_paths` does not
  know about market hours.  This agent does not PATCH live Coolify.
- **Image-noop skip beats HOTFIX=1.**  A hotfix token on a markdown commit
  must not recreate the named container.  Touch a runtime file to force a
  rebuild.
- **Skip needs a file list.**  Prefer `CHANGED_FILES`.  Coolify builds
  pass `SOURCE_COMMIT` / `COOLIFY_COMMIT_SHA` and the latch fetches the
  public GitHub commit files.  A failed or truncated (>=300 files) fetch
  is treated as image-relevant (fail closed for skip).  `.git` stays
  dockerignored, so the image build cannot `git diff`.
- **Keep stop-old-first.**  Owner refined: do not flip Coolify to
  build-then-stop or rolling.  Skip no-ops instead.
- **`/api/live` vs `/api/health`.**  Traefik follows Docker health.  A
  serving process must not go `running:unhealthy` because the ops probe
  503'd or timed out.
- **No rolling / no zero-downtime flag.**  Two Litestream writers are the
  L2 wedge RCA.  Consistent container name stays.
- **No `FORCE_RESTORE`.**  A docs-only 503 is not a replica-restore event.
- **Did not bounce the live box.**
- **Did not steal #2792 / #2798 / #2800 / #2794.**
- Drain redeliver may 403 on `GITHUB_TOKEN`.  Fail-soft.

## Verification State

```bash
./node_modules/.bin/tsc --noEmit
npm run lint
./node_modules/.bin/vitest run test/rth-deploy-latch.test.ts \
  test/live-route.test.ts test/sentry-ci-report-workflows.test.ts \
  test/market-hours.test.ts
```

tsc clean.  lint 0 errors (prior pass).  Latch + live tests 26 passed after
the `watch_paths` record.  Prior `verify-hosted` on this branch was green
before these follow-ups (run `32087609316`).  Re-run after this push.

## Next Steps & Blockers

- Rebased onto `main` after #2824 (restore-drill receipts + live
  `watch_paths` omit).  No Coolify PATCH.  Do not merge from this agent.
- Merge this PR outside weekday RTH (this branch touches `app/` + `src/` +
  `Dockerfile`, so `watch_paths` will start a real stop-old-first deploy).
  After the latch is live, later RTH builds refuse unless `HOTFIX=1`.
- Do **not** re-apply `watch_paths`.  Leave `health_check_start_period` at 60.
- Optional: `COOLIFY_DEPLOY_WEBHOOK_URL` if hook redeliver stays forbidden.

## Zero-Code Findings

- #2810 and #2811 are both the CI docs-only / image-noop class.
- `processStartedAt` 00:49:27Z is #2811 completing, not a hung #2810.
- 7:22–7:43pm CT is unhealthy-while-up, not a missing process.
  `litestream-runtime.log` has only the two SIGTERMs, no ERROR.
- ASC applied `watch_paths` live on `socratic-app` (`<ST_COOLIFY_APP_UUID>`).
  App stayed healthy.  No bounce.  Auto-deploy still on.
- Repo hook still POSTs every `push`; Coolify now ignores unwatched paths.
- `scripts/coolify-prod-start.sh` has no market-hours gate and must not gain
  one (runtime refusal after swap = another 503).
