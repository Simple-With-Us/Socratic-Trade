# 2026-06-21 — Litestream WAL replication, live on Cloudflare R2 (P2-5)

## Summary

Litestream is installed and **running in production** as a PM2 sidecar, replicating
`~/apps/trading-live/data/app.db` to a Cloudflare R2 bucket (`trading-live-backups`).
First snapshot (~9.4 MB) verified uploaded; `replica sync` ticking each second.

## Why

Offsite continuous backup for the single-node SQLite deployment. Addresses P2-5 from
the financial expert panel.

## What changed / what we learned

- **Litestream 0.5.x, not 0.3.x.** Homebrew installs 0.5.12. Two breaking differences
  from the originally-authored config bit us live:
  1. **Single replica only** — the dual s3+file replica config errors with
     "multiple replicas on a single database are no longer supported". Dropped the
     local file replica.
  2. **No `snapshots` command** — replaced by LTX files; inspect with `litestream ltx`.
- **R2 endpoint** — added `endpoint:` to the s3 replica and `LITESTREAM_S3_ENDPOINT`
  env var; `region: auto`.
- **Durable PM2 launch** — `scripts/run-litestream.sh` sources only `LITESTREAM_*` from
  `.env.local` with `eval "$(grep ...)"` and execs litestream. Two traps found live:
  - Relying on a shell that sourced `.env.local` before `pm2 start` is not durable — a
    later `pm2 restart` from a clean shell wipes the env → "bucket required". The
    wrapper fixes this.
  - `source <(grep ...)` (process substitution) silently sets nothing under PM2's
    stripped launch env; `eval "$(grep ...)"` works.
  - `.env.local` has a line that breaks naive `source` (`command not found: Wedgeworth`),
    so the wrapper greps only `LITESTREAM_*` lines.

## Files

- `litestream.yml` — single s3 replica, R2 endpoint, env-var driven
- `scripts/run-litestream.sh` — NEW, durable PM2 launcher
- `scripts/litestream-restore.sh` — 0.5.x restore syntax (no `-replica` flag; reads
  `.env.local`)
- `docs/litestream.md` — rewritten for 0.5.x + R2 + wrapper
- `.env.example` — `LITESTREAM_S3_*` documented (incl. endpoint)

Live-only (untracked, on the host): `~/apps/trading-live/{litestream.yml,run-litestream.sh}`
and the `LITESTREAM_*` block appended to `~/apps/trading-live/.env.local`.

## Verification

- `litestream databases -config …` → lists `app.db` → `s3`
- `litestream ltx -config … app.db` → two LTX files in R2 (9402865 + 207 bytes)
- `pm2 show litestream` → status online, restart_time 0
- Output log: `replicating to type=s3 bucket=trading-live-backups`, `ltx file uploaded`,
  `snapshot complete`, steady `replica sync`

## Follow-ups

- **Rotate the R2 token** — the access key/secret were pasted in a chat session.
  Token is scoped to Object R/W on the single `trading-live-backups` bucket (limited
  blast radius), but rotate as hygiene; then update `.env.local` and `pm2 restart litestream`.
- Optional local snapshot via a `launchd` `sqlite3 .backup` job (0.5.x can't second-replica).
- Consider a periodic restore drill (restore to /tmp, check row counts) to validate DR.
