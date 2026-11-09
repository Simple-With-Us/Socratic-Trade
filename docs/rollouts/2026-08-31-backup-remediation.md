# 2026-08-31 — Backup remediation: gzip the weekly R2 cold snapshot + litestream log rotation + backup-docs corrections

## Context & Objective

The production SQLite DB reached ~9.7 GB, so the raw weekly R2 cold snapshot
(`cold-snapshots/app-YYYY-MM-DD.db`, Sunday 03:17 UTC due-job) sat at ~90% of the
R2 10 GiB free tier on its own.  Separately, `/app/data/litestream-runtime.log`
in the production container had grown to 237 MB unrotated since 8/13, and several
backup docs carried stale or missing facts (B2 lifecycle restore-depth cap, the
retired host-level Congress.Trade litestream unit, today's L1 suffix heal).

## Changes Made

High level: the weekly cold snapshot now gzip-streams the better-sqlite3
`backup()` file during the multipart upload (node zlib `createGzip`, no
full-file buffering — memory stays bounded at ~one part plus zlib buffers),
producing `cold-snapshots/app-YYYY-MM-DD.db.gz` (~2.5-4 GB expected).  Retention
counts and prunes across BOTH extensions with retain=1 semantics, so the first
successful `.gz` upload prunes the legacy 9.68 GB `app-2026-08-30.db`.  The
success receipt (`r2coldsnap:lastSuccess`) now records compressed `bytes` plus
`rawBytes`; the health reader is extension-agnostic and unchanged in behavior.
No compression knob — always gzip.  No code downloads the cold snapshot (restore
is manual via rclone/aws cli), so the only symmetric change is documentation:
restore now needs `gunzip` first.

The container boot path rotates the litestream runtime log at start: if it
exceeds 64 MB, the whole old log moves aside as `litestream-runtime.log.1`
(overwriting any previous `.1`) and a fresh log is seeded with the newest 16 MB
(`tail -c`) so `runtime-health.ts`'s log scan keeps recent context.

Touched files:

- `src/lib/r2-cold-snapshot.ts` — gzip streaming upload (`uploadGzippedParts`),
  `.db.gz` key, dual-extension `KEY_PATTERN` + prune semantics, `rawBytes` on
  receipt/result/audit/due-job payload, `planMultipartParts` removed.
- `test/r2-cold-snapshot.test.ts` — gzip round-trip verification against the
  mocked S3 wire (gunzip of concatenated parts equals the original backup),
  dual-extension prune cases including the exact `.db` -> `.db.gz` migration
  state, incompressible fixture data so multi-part paths stay exercised.
- `src/lib/scheduler.ts` — lane comment updated to `.db.gz`.
- `scripts/coolify-prod-start.sh` — boot-time litestream-runtime.log rotation
  (64 MB threshold, keep newest 16 MB, `.1` aside); also fixed one pre-existing
  non-ASCII em-dash (scripts must stay pure ASCII).
- `docs/litestream.md` — new sections: B2 lifecycle caps restore depth
  (hide-14d + delete-1d => ~15-day hard cap on B2 PITR depth), gzipped weekly
  cold snapshot + gunzip-first restore recipe, 2026-08-31 L1 suffix heal
  precedent (`scripts/litestream-l1-suffix-heal.py`), and the note that all
  three fleet apps run litestream in-container since the Aug 2026 rebuild.
- `docs/EFFORT-LOG.md` — in-place bracketed correction on the 2026-08-01 KIMI
  row: the host-level `litestream-congress` systemd unit is historical; CT runs
  litestream in-container now.  Plus this effort's row.
- `PLAN.md` — backup-remediation entry (approach change per the pre-commit
  protocol).
- `litestream.coolify.yml` — live cold-snapshots reference updated to `.db.gz`
  with the gunzip-first note.
- `STATUS.md`, `docs/rollouts/2026-08-31-backup-remediation.md` (this note).
- `test/console-decisions-index.test.tsx` — unrelated pre-existing test rot that
  blocked this PR's `verify`: the fixed fixture date `2026-08-01T12:00:00Z`
  crossed timeAgo()'s 30-day boundary at 2026-08-31T12:00 UTC, after which the
  age renders as an absolute date without "ago".  Fixture is now relative to
  runtime (one hour ago), deterministic forever.

## Decisions & Trade-offs

- No compression knob (task directive): gzip always, one code path.
- `uploadGzippedParts` buffers at most one part (default 100 MB) of compressed
  output; awaiting each `UploadPart` inside the async-iterator loop applies
  backpressure through the gzip pipe, so the ~10 GB raw file is never resident.
- A thrown part upload destroys both streams in a `finally` so the backup temp
  file's fd cannot leak into the cleanup path.
- Same-date `.db.gz` sorts lexically after its `.db` twin, i.e. the gzipped
  upload is treated as newer — this plus retain=1 is what deletes the legacy raw
  object on the first successful gzipped run.
- Log rotation keeps exactly one `.1` generation (bounded worst case: 64 MB
  threshold + 16 MB fresh seed) rather than a numbered series — the volume
  pressure was the problem, not log retention.
- Historical rollout notes describing the raw `.db` era were left as-is (they
  are dated history); only live docs were corrected.
- Codex round-2 hardening: the drain claimant is now unique per invocation (the
  completeDueJob/failDueJob `claimed_by` fence previously matched any invocation
  from the same PID, so a stale worker could clobber a reclaimer's job state)
  and the claim lease grew 45 min -> 2 h so a degraded uplink cannot let a
  second drain start a concurrent ~10 GB backup racing the same key.  Recovery-
  depth wording corrected: the R2 cold snapshot is second-provider DR at most
  ~7 days old (retain=1), not history deeper than B2's ~15-day window.

## Verification State

```bash
npm run lint                                   # 0 errors, 792 grandfathered warnings (exit 0)
npx tsc --noEmit                               # clean
npx vitest run test/r2-cold-snapshot.test.ts   # 26/26 passed
npx vitest run test/console-decisions-index.test.tsx  # 7/7 passed (after fixture un-rot)
bash -n scripts/coolify-prod-start.sh          # syntax OK
grep -nP '[^\x00-\x7F]' scripts/coolify-prod-start.sh  # no matches
bash scripts/land.sh                           # tsc + full vitest + next build, all green; opened PR #3135
```

Note: `scripts/land.sh` runs tsc -> vitest -> build but NOT lint, so lint was
run explicitly above; the hosted required `verify` check runs lint again.

## Next Steps & Blockers

- After the next Sunday 03:17 UTC run, verify in the R2 console (or via the
  audit row `r2_cold_snapshot.success`) that `app-<date>.db.gz` exists, its
  size is ~2.5-4 GB, and `app-2026-08-30.db` was pruned.
- First production boot after this deploy should log
  "rotating litestream runtime log" and shrink the 237 MB file.
- Optional follow-up: a scripted cold-snapshot restore drill including the
  gunzip step (the 2026-08-08 rollout already lists a restore drill follow-up).
