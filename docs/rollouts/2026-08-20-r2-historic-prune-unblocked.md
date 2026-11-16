# 2026-08-20 — B2 restore proven: the historic R2 replica is now prunable

## Context & Objective
The owner asked why R2 storage is larger than a one-week snapshot should account for.  Answer: it is not storing one week of anything.  `socratic-trade-bucket` holds **two unrelated object sets**, and only one of them is current.

Documentation-only change.  **No objects were deleted by this change** — it records that the documented precondition for deleting them is now met, and leaves the deletion itself to a human with working credentials.

## What is actually in R2
| Prefix | What it is | Status |
|---|---|---|
| `cold-snapshots/app-<ISO-date>.db` | Weekly second-provider DR snapshot of the live SQLite DB (`src/lib/r2-cold-snapshot.ts`), `R2_COLD_SNAPSHOT_DEFAULT_RETAIN = 1`, DB ≈ 4.2 GB | **LIVE — keep** |
| `trading-live/**` | The entire pre-cutover litestream replica, from before active replication moved to Backblaze B2 on 2026-08-07.  `litestream.coolify.yml` notes an ~90k-object L1 backlog. | **DEAD — prunable as of today** |

So the surprise is the second row: months of abandoned replica objects, retained deliberately, not a week of snapshots.

## What changed today
`litestream.coolify.yml` said: *"do not delete R2 until B2 restore is proven."*  The owner confirmed in conversation on 2026-08-20 that **the B2 restore has been proven**, so that blocker is lifted.  The config comment now records this, along with the prune boundary and the footgun below.

## FOOTGUN — the reason this note exists
**Both replicas use the identical object path `trading-live/app.db`.**  Only the bucket and endpoint distinguish them:

- **R2 — dead, prunable:** bucket `socratic-trade-bucket`, endpoint `*.r2.cloudflarestorage.com`
- **B2 — live, do not touch:** bucket `jays-socratic-trade-eu`, endpoint `s3.eu-central-003.backblazeb2.com`

A prune of `trading-live/**` executed against the wrong endpoint **destroys the active backup of a real-money trading system**.  Echo and eyeball the endpoint and bucket before any delete.  Prune only R2, and only the `trading-live/` prefix — `cold-snapshots/` must survive.

## Why this agent did not execute the prune
- No object-level R2 delete tooling: the available Cloudflare MCP exposes bucket-level delete only, which would take `cold-snapshots/` with it.
- Object-level deletion needs S3 credentials, which are not hunted for per the standing secret-handling rule.
- Deleting backup data is a destructive, hard-to-reverse action that belongs with an explicit human decision, not inferred from a status answer.

## Suggested execution (for whoever has credentials)
1. Confirm the endpoint resolves to R2, not B2 — print it before anything else.
2. List `trading-live/` in `socratic-trade-bucket` and record the object count and total bytes **before** deleting, so the reclaimed amount is a measured number rather than an estimate.
3. Delete only `trading-live/**` in that bucket.
4. Re-list `cold-snapshots/` afterwards to prove the DR lane is intact.
5. Record measured before/after bytes here.

## Related open item
`sre-14` from the 2026-08-18 review ("three backup layers, zero restore drills") is partially answered by the proven B2 restore.  Worth recording HOW it was proven — date, method, what was restored and verified — so the next agent does not have to ask again.
