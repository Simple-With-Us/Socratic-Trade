# 2026-08-13 — Surgical B2 L1 delete (ST Litestream)

Owner: use the Backblaze master key and delete the poison L1 objects.

## What was deleted

Bucket `jays-socratic-trade-eu`, prefix `trading-live/app.db/` only.

- **91 overlapping L1 files** (dual-writer same-MaxTXID twins).  Kept the longer left-aligned file in each cluster, including `000000000003a083-000000000003a0ad.ltx`.  Removed the email's poison pair `a083-a099` + `a09a-a0ad`.
- **Stale L2 and L3** at `0000000000039fe3-000000000003a03b.ltx`.  L2 could not advance: first remaining L1 starts at `a04b` (small hole `a03c-a04a`).  Removing L2/L3 lets them rebuild from the cleaned L1 chain.

## What was not touched

Live L0, both L9 snapshots, the rest of the L1 chain, every other bucket.

## After

Litestream will write new L2/L3 on its next compaction.  Health may still show the old L2 tip until the 30-minute remote inventory refresh.
