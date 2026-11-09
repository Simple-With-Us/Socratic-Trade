# 2026-06-21 — Remove dead Litestream stub (consolidate on live R2 setup)

## Summary

Removed the older, never-run Litestream scaffolding so there is a single Litestream
implementation in the tree: the live PM2 + R2 setup from PR #47.

## Why

Two parallel Litestream approaches coexisted after #47 merged:
- **Live (PR #47):** `litestream.yml` + `scripts/run-litestream.sh` (PM2 sidecar) +
  `scripts/litestream-restore.sh` + `docs/litestream.md` + `LITESTREAM_S3_*` — actually
  replicating `data/app.db` to Cloudflare R2 and verified end-to-end (restore = live DB).
- **Dead stub (2026-06-19):** `scripts/litestream.mjs` + `litestream:replicate/restore/dry-run`
  npm scripts + `LITESTREAM_DB_PATH`/`LITESTREAM_REPLICA_URL` — never configured or run.

Two competing approaches are confusing and a maintenance trap. Owner chose to remove the
dead stub and keep the live R2 setup.

## Files

- Deleted `scripts/litestream.mjs`
- `package.json` — removed the 3 `litestream:*` npm scripts
- `.env.example` — removed the old `LITESTREAM_DB_PATH` / `LITESTREAM_REPLICA_URL` block
  (the `LITESTREAM_S3_*` block from #47 stays)
- `docs/ops-observability-security.md` — Litestream bullet + production note now point at
  the PM2/R2 setup and `docs/litestream.md`
- `STATUS.md`, this rollout note

Historical rollout/review notes from 2026-06-19 that mention the old stub were left
untouched (they are accurate records of that session).

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — 723/723 pass
- `npm run build` — green

## Follow-ups

- None. The live Litestream→R2 replication is unaffected by this cleanup (it uses
  `litestream.yml` + `run-litestream.sh`, which are unchanged).
