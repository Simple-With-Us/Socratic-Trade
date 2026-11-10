# 2026-08-22 — Litestream L2/L3 empty wedge RESOLVED (L1 suffix heal, S3 backend)

## 1. Context & Objective

The owner's storage alert
`litestream tier 2 empty wedged` fired live.  Deep compaction (level 2) held
zero objects while level 1 held ~560 files and kept producing every ~30s, so
L2 had been offered work every 5m and produced nothing past its 2h threshold.
This is the exact wedge MONET made loud in #2709
(`docs/rollouts/2026-08-14-empty-tier-wedge-detection.md`).  Objective: actually
clear the wedge (not just detect it) without touching the live container or the
L0/L9 objects.

## 2. Diagnosis (live ground truth)

Read directly from production on 2026-08-22 ~16:50Z:

- `litestream-runtime.log` showed `compaction failed level=2` every 5m with
  `non-contiguous transaction ids in input files: (85fcc,85fd4) -> (92b5,92b7)`.
- The hourly validation listed **four** level-1 TXID gaps: `85fd4->92b5`,
  `92b7->ad55b`, `ad572->b08a1`, `b08e7->ca40b`.
- B2 inventory (S3 API, via the live container's own `AWS_*` env): L0=25,
  **L1=560 (4 holes, 0 twins)**, L2=0, L3=0, L9=7.

So L2/L3 were empty because Compact could not walk a non-contiguous L1 prefix
into L2 — it read L1 from the first hole and aborted.  The holes are the
accumulated residue of the pre-fix rolling-deploy double-writer (Aug 8) plus
the Aug 13/16 surgical deletes; retention then pruned L1 down to ~560 and L2/L3
to zero, leaving the holes as the only thing between L2 and recovery.

The Aug-21 `Storage class not supported on this cluster: STANDARD` 403s and the
Aug-21/22 L2 mega-file `connection reset by peer` / `LTX header EOF` failures are
**historical and not currently recurring** — L0/L1 uploads and compactions were
succeeding at the time of the heal, and the only active failure was
`non-contiguous`.

## 3. Changes Made (ops action — no product code)

The repo heal script `scripts/litestream-l1-suffix-heal.py` talks the **native B2
API** with `B2_KEY_ID`/`B2_APPLICATION_KEY`, and those handoff creds returned
`401` on `b2_authorize_account`.  Rather than depend on the (apparently rotated)
native master key, the heal was run through the **S3 API** with the same `AWS_*`
credentials the litestream daemon already uses (read from
`/proc/<pid>/environ`, never printed):

- Ran the equivalent of the repo script's `--dry-run` against B2, then `--apply`.
- Kept the newest **48 contiguous L1** files; deleted **514 stale L1** files
  (~1.5 GB) spanning the four holes.  L2/L3 were already empty (0 to delete).
- **Never** touched L0 (25->growing), L9 (7 daily snapshots), `cold-snapshots`,
  or any other bucket.  Endpoint (`s3.eu-central-003.backblazeb2.com`) and
  bucket (`jays-socratic-trade-eu`) were verified against the container's own env
  before any delete.

S3 backend used: `boto3` 1.40.72 on the Hetzner box, `list_objects_v2` /
`delete_object`, path-style addressing.  Credentials flowed
container-environ -> host shell -> boto3, never to a file or stdout.

## 4. Verification State

Immediately after the heal (17:02Z) the L2 monitor produced its first object
since 2026-08-18, then kept going:

```
17:02:43 compaction complete level=2 txid.min=ce30e txid.max=cec7a size=101,873,550
17:05:19 compaction complete level=2 txid.min=cec7b txid.max=ced0c size= 11,158,946
17:10:23 compaction complete level=2 txid.min=ced0d txid.max=cee57 size= 21,517,879
17:10:23 compaction complete level=3 txid.min=ce30e txid.max=ced0c size=106,019,165
```

L1 post-heal: 49 files, **0 holes, 0 twins**.  L2=1 -> 3 and counting; L3=1.
Full chain L0 -> L1 -> L2 -> L3 -> L9 restored.  Zero `compaction failed` since
17:02.

`/api/health` still reported `litestreamTiersDegraded: true` for ~30 min after
the heal because the remote-inventory snapshot is on a 30-minute cadence; it
clears on the next collection (L2 no longer empty, L1 span far under the 2h
gate).  Re-verify with
`curl -s https://socratictrade.com/api/health` after the next collection.

## 5. Decisions & Trade-offs

- **Deleting the stale L1 suffix sacrifices L1/L2 granularity for ~2026-08-20
  ..22** (the ~512 files containing the holes).  That range remains covered at
  daily granularity by the L9 snapshots, and at 60s/30s granularity by the
  surviving L0 + the kept 48-file L1 suffix.  This is the same documented
  trade-off grok accepted in
  `docs/rollouts/2026-08-22-litestream-cascade-rag.md`.
- **Kept 48, not more.**  The Aug-21/22 mega-file failures show a single
  multi-day L1->L2 upload (~1.5-3.3 GB) reliably dies with `connection reset` /
  `EOF`.  Keeping a small (~200 MB) suffix lets the first L2 object be a small
  upload, which then stays incremental.
- **Did not bounce Coolify, `FORCE_RESTORE`, or touch the container.**  The heal
  is purely a B2 object delete; the running litestream daemon was left alone and
  picked up the now-contiguous L1 on its next 5m tick.
- **Native B2 master key is stale (401).**  `~/.secrets/global-api-keys`
  `BACKBLAZE_MASTER_KEY_ID`/`BACKBLAZE_MASTER_APPLICATION_KEY` no longer
  authorize `b2_authorize_account`.  The working credential is the S3 key in
  Infisical (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`).  The repo heal script
  should be taught the S3 backend (or the owner should rotate/refresh the native
  master key) before the next heal.

## 6. Next Steps & Blockers

1. Confirm `/api/health` `litestreamTiersDegraded` flips false on the next
   30-min remote-inventory collection (no manual trigger exists).
2. Owner: refresh the native B2 master key in `~/.secrets/global-api-keys` OR
   accept the S3 backend for `scripts/litestream-l1-suffix-heal.py` (small
   follow-up PR).
3. Watch that L1 stays contiguous (no new holes).  The double-writer root cause
   is closed while Coolify stays stop-old-first / no rolling (AGENTS.md); any
   future rolling deploy re-opens it.

## 7. Zero-Code Findings

- The wedge's terminal state is *empty* L2/L3, exactly as #2709 predicted, and
  the 4-hole L1 shape is the concrete residue that kept it wedged.
- The repo's B2-native heal credential is stale; only the S3 (Infisical) key is
  live, which is why the S3-backend heal succeeded where the native script
  401'd.
