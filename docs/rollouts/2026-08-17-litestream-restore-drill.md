# 2026-08-17 — Litestream restore drill (scratch only)

## Context & Objective

`docs/litestream.md` still recorded restore as unexercised (G9a, 2026-07-01).  ASC ran scratch-only B2 restores on `fleet-hetzner-nbg1` on 2026-08-18 UTC and then re-verified decrypt and R2 weekly retain=1.  Goal: write the audit trail so the next operator can see what is VERIFIED.  This PR is report-only.  No product code.  No live Coolify writes.  No bounce.  No `FORCE_RESTORE`.  No Mac pm2.  Both scratches off the live volume.  Site stayed up.

## Changes Made

Docs only.  The restore and re-checks already happened on the host.  This note records them.

Touched files:

- `docs/rollouts/2026-08-17-litestream-restore-drill.md` (this note)
- `docs/litestream.md` (restore verification status + B2-proven pointer)
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Scratch paths only.  Live `/app/data/app.db` was not overwritten.
- Creds came from the running Socratic Litestream process env.  The env file was shredded after.  No Infisical dump in this PR.
- Decrypt proof is last-4 `6dd4` plus `plaintext_len 32`.  Do not write the plaintext or `ENCRYPTION_KEY`.  The ciphertext file was removed after the check.
- `R2_ARCHIVE_KEEP_GENERATIONS=2` is unused on ST (`weekly/` prefix empty).  Do not treat that env as a retain=1 failure.  The live weekly path is `R2_COLD_SNAPSHOT_DEFAULT_RETAIN=1` with `R2_COLD_SNAPSHOT_RETAIN` unset, and `cold-snapshots/` has exactly one object.
- Do not add Coolify rolling or zero-downtime.  The live app is already stop-old-then-start (`is_consistent_container_name_enabled=true`, dockerfile pack).  A separate docs-deploy 503 after #2810/#2811 is recorded below and is not part of the restore proof.

## Verification State

ASC / host findings (2026-08-18 UTC).  No bounce.  No `FORCE_RESTORE`.  No Mac pm2.  Live volume untouched.  Site stayed up.

Nothing from this drill remains BLOCKED or NOT VERIFIED.

### VERIFIED — B2 restore to scratch

- Host: `fleet-hetzner-nbg1` via `ssh coolify`
- Replica: B2 (`litestream.coolify.yml` path `trading-live/app.db`).  Creds from running socratic litestream process env; env file shredded after.
- First scratch: `litestream restore -config /data/scratch/socratic-restore-20260818/litestream.coolify.yml -o /data/scratch/socratic-restore-20260818/app.db /app/data/app.db`.  Started 2026-08-18T01:12:26Z, file complete ~01:14Z, 4.9G.
- Second scratch (also not live): `/data/backups/restore-proof/socratic-restore-scratch-20260817/app.db`.  Host litestream 0.5.16, 107s, exit 0, 4.9G, integrity ok.  Newest LTX at restore: level 0 txid `0000000000080781` @ 2026-08-18T01:14:43Z.
- Both scratches finished.  Both off the live volume.

### VERIFIED — PRAGMA integrity_check (scratch)

- First scratch: sqlite3 3.46.1 → `ok`.  ~4m (01:16:30Z–01:20:38Z)
- Second scratch: integrity ok (same 4.9G file after the 107s restore)

### VERIFIED — max(audit_events.created_at) vs live

- First live sample (read-only node sqlite on container, ~01:11Z): max 2026-08-18T01:11:22.198Z, n=210000.  First scratch: max 2026-08-18T01:12:10.915Z, n=210008.  Scratch ~48s newer than that live sample / within seconds of restore start.
- Later live compare at 8:19pm CT: scratch max 01:12:10Z n=210008 vs live 01:19:28Z n=210039.  Seconds / ~31 rows behind.  Expected.
- RPO looks healthy.

### VERIFIED — decrypt one stored credential (second ASC pass)

- Path: `src/lib/db-api-keys.ts` `decryptValue` + container Infisical `ENCRYPTION_KEY` (64 hex).  Do not write the key or the plaintext.
- Scratch row: `user_api_keys.service=fred`, `isEncryptedValue=true`, `enc_len` 122, prefix `ff0` (legacy envelope, not `v1:`).
- SUCCESS last-4 `6dd4`, `plaintext_len` 32.  Value not printed.  Ciphertext file removed.

### VERIFIED — no dual Socratic Litestream writers

- Three replicate PIDs, three apps: socratic `4806ba4f` (`litestream.coolify.yml` + next start, started 00:49Z), congress `d7e8f6e0` (deno), usage `83555eddd`.
- One socratic container.  Coolify: `is_consistent_container_name_enabled=true`, dockerfile pack, no rolling/zero-downtime.  Stop-old-then-start.

### VERIFIED — host 6h local sqlite backups

- `/data/backups/socratic/socratic-app-{20260817T121501Z,20260817T181501Z,20260818T001501Z}.db` (+ sha256)
- Latest 4.9G.  `PRAGMA integrity_check` ok.  max(audit_events)=2026-08-18T00:18:08.117Z n=212967 (older max, higher count than current — consistent with later pruning + new events).

### VERIFIED — R2 weekly retain=1

- Code default `R2_COLD_SNAPSHOT_DEFAULT_RETAIN=1`; `R2_COLD_SNAPSHOT_RETAIN` unset.
- `socratic-trade-bucket` `cold-snapshots/` has exactly 1 object: `cold-snapshots/app-2026-08-16.db` (4671946752).  Matches health `r2Weekly.key`.
- `R2_ARCHIVE_KEEP_GENERATIONS=2` is unused on ST (`weekly/` prefix empty).  Do not treat that env as a retain=1 failure.

### Out of scope — Coolify 503 after docs deploys

Separate Coolify 503 ~00:15–00:49Z after docs deploys #2810/#2811 (stop-old-first, Cloudflare no available server).  Recovered sha `23412aff`.  That is not part of the restore proof.  #2822 raced Coolify `watch_paths` (now omit `docs/**`, `STATUS.md`, `PLAN.md`); this follow-up should not rebuild.

```
# docs-only; no product-code compile required
npx tsc --noEmit   # not required for this PR; skipped
npm test           # not required for this PR; skipped
npm run lint       # not required for this PR; skipped
npm run build      # not required for this PR; skipped
```

## Next Steps & Blockers

1. Leave Coolify as stop-old-then-start.  Do not add rolling or zero-downtime.
2. Scratch files at `/data/scratch/socratic-restore-20260818/` and `/data/backups/restore-proof/socratic-restore-scratch-20260817/` can be shredded when the owner no longer wants the proof copies.
3. Repeat the scratch restore after any Litestream / `litestream.coolify.yml` version bump (quarterly otherwise).
4. No remaining BLOCKED / NOT VERIFIED items from this drill.

## Zero-Code Findings

B2 restore to two host scratch paths works (litestream 0.5.16, 4.9G, integrity ok, newest L0 txid `0000000000080781` @ 01:14:43Z).  The restored SQLite file is intact.  A later live compare is seconds / ~31 rows ahead of the scratch, as expected.  One stored credential decrypts on the scratch (`fred` last-4 `6dd4`).  One Socratic Litestream writer is running.  Host 6h local backups are intact.  R2 weekly retain=1 is live: exactly one `cold-snapshots/` object, matching health.  `R2_ARCHIVE_KEEP_GENERATIONS=2` is unused on ST.  The ~00:15–00:49Z Coolify 503 after #2810/#2811 is a stop-old-first docs-deploy gap, not a restore failure.
