# 2026-08-08 — Weekly R2 cold snapshot (second-provider DR)

Seat: MONET · branch `monet/r2-cold-snapshot` · lane `~/apps/trading-monet`

## Context & Objective

Owner directive 2026-08-08: with litestream's active replica moved to Backblaze B2
(PR #2584), the Cloudflare R2 bucket sits idle — use it intelligently as a **weekly cold
snapshot of the production SQLite DB**, i.e. second-provider disaster recovery (B2 holds
the continuous replica; R2 holds weekly full-file snapshots), while staying reliably far
under the R2 free tier.

## Changes Made

New module `src/lib/r2-cold-snapshot.ts`:

- **Durable weekly due-job** (`due_jobs` job_type `r2_cold_snapshot`, via `db-jobs.ts`)
  instead of an in-process interval: the scheduler tick idempotently enqueues the next
  Sunday **03:17 UTC** slot (dedupe key `week-YYYY-MM-DD`, staggered off the top of the
  hour) and drains due jobs (limit 1, 45-min lease). If the box is down over the slot,
  the pending job is claimed on the next tick after boot.
- **Consistent snapshot**: better-sqlite3's online-backup API (`getDb().backup(dest)`)
  into a temp file under `tmpdir()` (`agentic-r2snap-<uuid>.db` — matches the repo's
  temp-file conventions and the janitor's `agentic-*` sweep). Never a raw copy of the
  live WAL-mode file. Temp file unlinked in a `finally` on success AND failure.
- **Multipart upload via minimal S3 SigV4** (modeled on the verified signer in
  `src/lib/market-signals/massive-s3.ts`, extended with canonical query strings +
  request bodies): CreateMultipartUpload → UploadPart (100 MB parts; ~16 for the
  ~1.5 GB DB) → CompleteMultipartUpload, with best-effort AbortMultipartUpload on
  failure. Target key: `cold-snapshots/app-<ISO-date>.db` in the historic R2 bucket.
- **Retention**: after a successful upload, ListObjectsV2 under `cold-snapshots/` and
  delete all but the newest 4 (`R2_COLD_SNAPSHOT_RETAIN`). Defensive key filter
  (`^cold-snapshots/app-\d{4}-\d{2}-\d{2}\.db$`) so historic litestream objects can
  never be pruned by this lane. A prune failure does not fail the run.
- **Gating**: default ON only when the full `AWS_R2_HISTORIC_*` credential set from
  PR #2584 exists; otherwise silent no-op with ONE audit row per distinct reason
  (`r2_cold_snapshot.disabled`). Explicit kill switch `R2_COLD_SNAPSHOT_ENABLED=0/off/false/no`.
- **Budget guard**: refuses to run (`r2_cold_snapshot.budget_refused` audit +
  `storage_warning` advisory) when the r2-usage monitor's latest ST snapshot shows
  month-to-date **Class A ops ≥ 50%** of the free tier (read via
  `getR2UsageSnapshots()` — no extra Cloudflare calls). Unknown usage (monitor
  unconfigured / never ran) defers the guard and proceeds.
- **Audit + notify**: `r2_cold_snapshot.start/success/error/prune_error/drain` audit
  rows with sizes, part counts, pruned keys, durations. Failures surface once via the
  existing `alertStorageWarning` path (db-health.ts — 12h per-warning-type cooldown),
  then the due-job retries with backoff (db-jobs default: 10 min, max 5 attempts, then
  unresolvable; next week's job arrives regardless).
- The R2 free-tier **kill-switch in `r2-usage.ts` is untouched** (it is gated to
  litestream's endpoint being R2, which it no longer is — see #2584).

Files touched:

- `src/lib/r2-cold-snapshot.ts` (new)
- `test/r2-cold-snapshot.test.ts` (new — 22 tests)
- `src/lib/scheduler.ts` (new `r2-cold-snapshot` journal lane next to the other
  due-job drain, dynamic import so it stays off the static graph)
- `.env.example` (new `R2_COLD_SNAPSHOT_*` knobs; AWS_R2_HISTORIC comment updated)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout note

## Decisions & Trade-offs

- **Env names**: exactly the #2584 convention — `AWS_R2_HISTORIC_BUCKET_NAME`,
  `AWS_R2_HISTORIC_ENDPOINT`, `AWS_R2_HISTORIC_REGION` (default `auto`),
  `AWS_R2_HISTORIC_ACCESS_KEY_ID`, `AWS_R2_HISTORIC_SECRET_ACCESS_KEY`. New knobs:
  `R2_COLD_SNAPSHOT_ENABLED`, `R2_COLD_SNAPSHOT_RETAIN` (default 4),
  `R2_COLD_SNAPSHOT_PART_MB` (default 100, clamped to the 5 MB S3 floor).
  **Owner action for prod**: the historic vars are commented placeholders in
  `.env.example`; the lane stays a silent no-op until they are set in Infisical
  (`AWS_R2_HISTORIC_*` were preserved there per #2584 — note the preserved key must be
  read-WRITE for uploads+pruning; if it was scoped read-only for restore drills, the
  first run will fail with an auditable 403 and a storage_warning, not silently).
- **Budget math** (documented in the module header): one weekly run ≈ 20 Class A ops
  (~90/month vs 1M free) — negligible. Storage is retain×DB-size: 4 × ~1.5 GB ≈ 6 GB of
  the 10 GiB tier, **shared with the historic litestream objects still in the bucket**.
  The r2-usage monitor's absolute storage alert (70%) remains the watchdog; if it fires,
  the levers are lowering `R2_COLD_SNAPSHOT_RETAIN` or clearing the historic litestream
  generations once B2 restore is proven.
- No AWS SDK dependency added — the repo already ships a verified SigV4 signer pattern;
  ~120 lines of focused code beats a new dependency on the money path's host app.
- Multipart is used unconditionally (even for small files — a single part is legal),
  keeping one code path; the S3 5 MB minimum only applies to non-final parts.
- Budget-refused and creds-vanished weeks **complete** the job (`skipped`) rather than
  retrying — the next weekly job covers the gap; retry-with-backoff is reserved for
  transient upload errors.
- Restore drill deliberately out of scope here (the upload is a plain SQLite file:
  `aws s3 cp` / rclone + `PRAGMA integrity_check` — documented as a follow-up).

## Verification State

```
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npx tsc --noEmit         # clean
PATH=... npx vitest run test/r2-cold-snapshot.test.ts               # 22 passed
PATH=... npx vitest run test/r2-cold-snapshot.test.ts \
  test/deep-safety-fixes.test.ts test/health-route-exposure.test.ts \
  test/scheduler-boot-halt-notify.test.ts test/scheduler-leader-heartbeat.test.ts \
  test/scheduler-followup-lease.test.ts test/scheduler-lease.test.ts \
  test/scheduler-single-leader-default.test.ts test/sentry-inert.test.ts \
  test/scheduler-draining.test.ts test/scheduler-managed-vector-reconcile.test.ts \
  test/db-jobs.test.ts test/r2-usage.test.ts                        # 13 files, 136 passed
PATH=... npm run lint                                               # 0 errors (729 grandfathered warnings, none in touched files)
```

Full suite + build deliberately left to the landing operator per task scope.

## Next Steps & Blockers

1. Landing operator: full gate (`npm run lint` → `tsc` → `npm test` → `npm run build`)
   + `bash scripts/land.sh` from the monet lane.
2. Owner/agent with Infisical access: confirm `AWS_R2_HISTORIC_*` exist in ST prod env
   (and that the key permits PutObject/DeleteObject/ListBucket on the bucket) — until
   then the lane is a silent no-op with one `r2_cold_snapshot.disabled` audit row.
3. After the first Sunday run: verify `r2_cold_snapshot.success` in audit events and the
   object in the R2 console; then schedule a restore drill (download + integrity_check).
