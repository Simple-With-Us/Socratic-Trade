# 2026-08-04 — Docker: force real better-sqlite3 native rebuild (deploy 178)

## Context & Objective

All open PRs were merged to `main` (HEAD `8777c87b`) and the slim Dockerfile
built successfully on Coolify (image ~1.45 GB). Deploy **178** still failed
healthchecks and rolled back to `6ad913d5`. Production must accept main HEAD.

## Changes Made

- **Root cause (deploy 178 container logs):**
  ```
  Cannot find module '/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
  ```
  The image had a `build/Release/` tree of empty **stamp** files only — no
  `.node` binary. `npm rebuild better-sqlite3 --build-from-source` finished in
  ~3s ("rebuilt dependencies successfully") because:
  1. npm 10 treats `--build-from-source` as an unknown CLI config (warns; does not
     force compile).
  2. After `npm prune --omit=dev`, the node-gyp toolchain is gone, so rebuild
     cannot compile from source.
  3. Deleting `prebuilds/` left nothing for runtime to load (bookworm has glibc
     2.36; published prebuilds need 2.38 — that was why we deleted them).

- **Fix (`Dockerfile`):**
  - `npm prune --omit=dev --ignore-scripts` (do not re-run install scripts that
    re-extract glibc-2.38 prebuilds).
  - `npm install -g node-gyp@11` so the compiler driver survives prune.
  - `rm -rf prebuilds build` then `(cd node_modules/better-sqlite3 && node-gyp rebuild --release)`.
  - **Fail the image build** if `.node` is missing or `new Database(':memory:')` throws.

## Decisions & Trade-offs

- Global node-gyp in the **build** stage only (not copied to runtime).
- Keep `python3`/`make`/`g++` in build stage for the compile (already present).
- Assert at build time so Coolify never starts another empty-binding image.

## Verification State

- Inspected failed image `socratic-app:8777c87b…` on Oracle: no `*.node` under
  better-sqlite3; constructing Database threw MODULE_NOT_FOUND (matches prod logs).
- Local change is Dockerfile-only; full app tsc/test/build still required by land.sh.

## Next Steps & Blockers

1. Land branch `grok/docker-sqlite-native` → PR → auto-merge.
2. Watch Coolify deploy: build must log a real node-gyp compile (tens of seconds,
   not ~3s) and print `better-sqlite3 ok { x: 1 }`.
3. Confirm `https://socratictrade.com/api/health` release.sha contains main HEAD.

## Zero-Code Findings

- Deploys 173–177 failed earlier layers (USER node, typecheck, GLIBC prebuild
  dlopen, COPY timeout). Deploy 178 was the first to **start** a container from
  the slim image — native binding was the last remaining blocker.
