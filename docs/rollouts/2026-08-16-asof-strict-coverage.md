# 2026-08-16 — VECTOR_ASOF_STRICT coverage receipt

## 1. Context & Objective

Owner asked for a full report before deciding whether to flip `VECTOR_ASOF_STRICT`.  Fail-closed dated retrieval only (chat / live strategy omit `asOf`).  This is the fresh drop-count receipt.

## 2. Method

Dry-run of `scripts/backfill-asof-epoch.ts` against the live `socratic-trade` Pinecone index (`BACKFILL_DRY_RUN=1`, `BACKFILL_USER=local`, batch 200).  No metadata updates were written.

## 3. Result

```
scanned=13076
skippedHasEpoch=13076
skippedUndated=0
updated=0
errors=0
dryRun=true
```

Every listed vector already carries a finite `as_of_epoch_ms`.  Zero undated / un-epoch'd rows.  A flip of `VECTOR_ASOF_STRICT` would currently drop nothing on this index.

## 4. What a flip would change

- Live desk (chat, Autopilot propose) still omits `asOf` — **no change**.
- Dated paths (backtest, lookahead audit, replay) would fail-closed: undated chunks would be dropped if ingest later reintroduces them.

## 5. Recommendation

Safe to flip on current inventory.  Re-run this dry-run after large ingest bursts before treating the receipt as permanent.  Owner still owns the Infisical flip.

## 6. Next Steps

Owner decision only: set `VECTOR_ASOF_STRICT=on` in Infisical prod, or leave off.  No agent flip in this work.
