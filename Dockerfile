# syntax=docker/dockerfile:1.7
# Production image for Coolify (socratic-app).
#
# Design constraints (learned the hard way 2026-08-04):
# - Coolify Horizon kills the build command at ~30 minutes. A full
#   `COPY --chown=node:node /app /app` of an unpruned tree (~4 GB image) was
#   routinely exceeding that budget and freezing prod on the last good image.
# - Do not COPY --chown or RUN chown -R large trees (both blew the 30m budget).
# - Prune devDependencies and .next/cache before the runtime stage so the
#   inter-stage copy is small and fast.
# - Pair with .dockerignore so the build context never includes local
#   node_modules/.next/test/ios/docs/agent state.
#
# better-sqlite3 / bookworm glibc (deploy 175-178):
# - better-sqlite3@13 prebuilds need GLIBC_2.38; bookworm ships 2.36.
# - `npm rebuild better-sqlite3 --build-from-source` after prune is a NO-OP:
#   npm 10 ignores --build-from-source as a CLI flag, and after prune the
#   node-gyp toolchain is gone, so rebuild only re-stamps and never emits
#   build/Release/better_sqlite3.node (deploy 178: MODULE_NOT_FOUND, 500
#   healthchecks, roll-back to 6ad913d5).
# - Force a real node-gyp rebuild with an explicit clean of build/ + prebuilds/,
#   keep python3/make/g++ for that step, and fail the image build if the
#   .node binary is missing or unloadable.

FROM node:24.14.1-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Latch BEFORE npm ci.  #2811 (docs-only) still ran a full ~30 min image build
# after Coolify stopped the named container, so origin 503'd.  A refused
# build here is seconds, not the Horizon budget.  Do not move this into
# scripts/coolify-prod-start.sh and do not enable Coolify rolling (two
# Litestream writers).  SOURCE_COMMIT lets the latch read the commit files
# plus HOTFIX=1 from the public GitHub API.
RUN npm install -g tsx@4.23.1
COPY src/lib/market-hours.ts src/lib/market-hours.ts
COPY src/lib/market-calendar.ts src/lib/market-calendar.ts
COPY src/lib/deploy-image-impact.ts src/lib/deploy-image-impact.ts
COPY src/lib/rth-deploy-latch.ts src/lib/rth-deploy-latch.ts
COPY scripts/assert-rth-deploy-latch.ts scripts/assert-rth-deploy-latch.ts
ARG HOTFIX=0
ARG SOURCE_COMMIT=""
ARG COOLIFY_COMMIT=""
ARG COOLIFY_COMMIT_SHA=""
ENV HOTFIX=${HOTFIX} \
    SOURCE_COMMIT=${SOURCE_COMMIT} \
    COOLIFY_COMMIT=${COOLIFY_COMMIT} \
    COOLIFY_COMMIT_SHA=${COOLIFY_COMMIT_SHA} \
    NEXT_TELEMETRY_DISABLED=1
RUN tsx scripts/assert-rth-deploy-latch.ts
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# scripts/eval/* imports test/fixtures (dockerignored). Next typecheck includes
# **/*.ts and would fail the image build. Drop eval runners before build.
# --ignore-scripts on prune: avoid re-extracting glibc-2.38 prebuilds.
# Then wipe any prebuild/build residue and compile better-sqlite3 from source
# with a real node-gyp (installed globally so prune cannot remove it).
RUN rm -rf scripts/eval test \
  && npm run build \
  && npm prune --omit=dev --ignore-scripts \
  && npm install -g node-gyp@11 \
  && rm -rf node_modules/better-sqlite3/prebuilds node_modules/better-sqlite3/build \
  && (cd node_modules/better-sqlite3 && node-gyp rebuild --release) \
  && test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  && node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); console.log('better-sqlite3 ok', db.prepare('select 1 as x').get()); db.close();" \
  && rm -rf .next/cache \
  && rm -rf ios pdf_pages .git .github \
  && find docs -mindepth 1 -maxdepth 1 ! -name benchmarks -exec rm -rf {} + 2>/dev/null || true \
  && rm -rf node_modules/.cache

FROM node:24.14.1-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl tar gzip tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4000

# Copy without ownership rewrite (recursive chown blew the 30m budget).
# Run as root: coolify-prod-start must mkdir/write /app/data/.bin and the
# Coolify volume mount for /app/data is the writable surface. USER node with
# root-owned /app caused crash-loop exit 1 on deploy 173 (healthcheck never
# passed; rolled back to 6ad913d5).
COPY --from=build /app /app

USER root
EXPOSE 4000
# Traefik follows Docker health.  /api/health is the rich ops probe and
# can 503 (Pinecone/RAG hard-stop) or exceed this 15s timeout after boot.
# That marks running:unhealthy while the process is up -- public 503 for
# ~20 min after #2810 finished on 2026-08-17.  /api/live is process-only:
# it does not open app.db.  Do not point Coolify HTTP health back at /api/health.
# 2026-09-09: /api/live itself intermittently took ~8s because it read SQLite.
# better-sqlite3 is SYNCHRONOUS, so a heavy query against the ~11GB app.db
# blocked the event loop and every request behind it, including this probe.
# Measured on prod:
# 8.60s then 0.09s then 0.03s back-to-back, CPU 107%, disk %util 0.10 -- CPU
# bound in-process, not IO.  At timeout=5s/retries=3 that flapped the container
# to unhealthy and Traefik served a public 503 while the app was fine (DB ok,
# scheduler ticking, Alpaca streams live).  Same class as the 2026-08-17 #2810
# incident noted above.  Widened to tolerate an ~8s stall; 5 x 30s still
# detects a genuine hang within ~2.5 min.  This is MITIGATION -- the event-loop
# block is the real defect and is tracked separately (PR #3202).
#
# Detection bound, corrected: Docker schedules the next check `interval`
# seconds after the PREVIOUS CHECK COMPLETES, so a failing cycle costs
# timeout+interval = 45s and 5 retries is ~225s, not 150s.
#
# Honest limit of this mitigation: stalls up to 36,511 ms were measured on
# 2026-09-08, so a 15s timeout still fails against the worst of them.  This
# reduces flapping; PR #3202 (non-convergent FTS mirror loop) is what actually
# stops it.
#
# tini is PID1 so Docker HEALTHCHECK children are reaped.  infisical-run
# (Node) does not wait() those curls; hung probes SIGKILL'd at the old 5s
# timeout piled up as zombies (CPU 105%, Traefik 503) on 2026-09-09.
# curl --max-time 14 exits itself before Docker's 15s kill.
HEALTHCHECK --interval=30s --timeout=15s --start-period=90s --retries=5 \
  CMD curl -fsS --max-time 14 --connect-timeout 2 http://127.0.0.1:4000/api/live >/dev/null || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["bash", "scripts/coolify-prod-start.sh"]
