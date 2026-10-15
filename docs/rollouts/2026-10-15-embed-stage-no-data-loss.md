# embed_stage: staged data is never lost (ST-4540)

**Date:** 2026-10-15 · **Issue:** Linear ST-4540 (RAG improvement 3) · **Branch:** `cursor/embed-stage-no-data-loss`

## Problem

`embed_stage` is the durable "paid but not yet delivered" vector stage (2026-08-09 embed-once
directive). A row is money already spent on an OpenRouter/Voyage embed that has not yet landed in
the vector store. Three code paths could destroy those rows without ever checking whether the
vector had been delivered:

1. **Age sweep** — `sweepEmbedStage()` ran `DELETE FROM embed_stage WHERE created_at < ?`, so any row
   older than 35 days died regardless of delivery state. A month-long Pinecone quota outage (exactly
   the event the stage exists for) converts every staged row into a guaranteed re-embed bill.
2. **Size cap** — past 2 GiB the sweep deleted oldest-first in 500-row batches until the table fit.
   A stuck month could therefore lose a day of undelivered paid embeddings to a byte budget.
3. **Undecodable rows** — `getStagedEmbeddings()` deleted rows whose blob failed to decode
   ("self-heal"). That destroyed the evidence of a paid embed and turned a *recoverable* corruption
   into a *guaranteed* re-embed.

`sqlite-storage-hygiene.ts` had a second age delete over the same table (`created_at < ?`).

## Change

ST data is kept forever. Deletion of a staged vector now requires proof of durable delivery.

- **`deleteStagedEmbeddings(hashes, model, revision, receipt)`** takes a **required**
  `EmbedStageDeliveryReceipt` naming the store that acknowledged the upsert (`"pinecone" | "qdrant"`).
  It stamps `delivered_at`/`delivered_store`, then deletes only rows carrying that exact receipt, so
  a key concurrently re-staged (receipt cleared) can never be removed by an older delivery. No
  overload deletes without naming the store — losing a paid vector is unrepresentable.
  The stamp and the delete are **separate transactions**: a crash between them leaves a
  "delivered but stranded" row that the retention sweep reclaims, instead of rolling the evidence of
  delivery back.
- **Age sweep reclaims delivered rows only** (`delivered_at IS NOT NULL AND quarantined_at IS NULL`),
  in bounded 500-row batches. Undelivered rows past the window are counted, kept, and reported via a
  new `embed_stage_undelivered_backlog` audit row + Sentry warning.
- **The size cap deletes nothing.** It emits one `embed_stage_over_cap` audit row + Sentry warning
  with rows/undelivered/oldest-undelivered and sets `overCap: true`. An over-cap table means
  delivery is stuck and a human should look, not that bytes should be thrown away.
- **Undecodable rows are quarantined, not deleted** — marked `quarantined_at`/`quarantine_reason`
  (`undecodable_vector:dims=…:bytes=…`), reported as a miss so the caller re-embeds from source, and
  healed by that re-embed (`INSERT OR REPLACE` clears the marker). One `embed_stage_quarantine`
  audit row per lookup, never one per corrupt row. A quarantined row is exempt from both age
  deleters, since it is awaiting a re-embed that replaces it in place.
- **`sqlite-storage-hygiene.ts`** targets
  `delivered_at IS NOT NULL AND quarantined_at IS NULL AND created_at < ?`.

### Schema (additive)

New nullable columns on `embed_stage`: `delivered_at`, `delivered_store`, `quarantined_at`,
`quarantine_reason`, plus `idx_embed_stage_delivered`. Guarded `ALTER TABLE` migration for existing
databases. **Pre-existing rows default to `delivered_at = NULL`** — "never proven delivered", the
conservative reading, so a pre-migration row is re-verified on the next retry instead of assumed
safe to delete.

### Callers

`vector-db.ts` (both delete sites — plain per-batch, and managed two-phase after
`markCommitted`), `audit-prune.ts` (`AuditPruneResult` gains `embedStageUndeliveredRetained`;
`embedStageCapPruned` is retained as an always-0 field for accounting shape), `scheduler.ts`
(lane summary reports `undelivered=`), `sqlite-storage-hygiene.ts`.

## Tests

`test/embed-stage.test.ts` — rewritten retention/cap suite plus new suites: undelivered rows survive
the 35-day window, delivered rows are reclaimed, the over-cap path deletes zero rows and raises one
alarm audit, the audit-prune lanes report without deleting, the receipt is required (the old 3-arg
shape throws and keeps the row), re-staging clears a receipt, quarantine keeps + marks + heals
(including a delivered *and* quarantined row, which is held until the re-embed lands), and
`embedStageStats` reports the backlog. `test/sqlite-storage-hygiene.test.ts` — an undelivered
50-day-old row now survives the hygiene lane while a delivered one is reclaimed; a delivered,
quarantined row survives too.

Verified locally on Node 22: `npx tsc --noEmit` clean, `eslint` 0 errors on every touched file (only
pre-existing `any` warnings in `db.ts`/`vector-db.ts`), and the embed-stage, storage-hygiene,
`db-migration-old-schema`, `db-migration-busy`, `audit-hygiene`, `pinecone-wu-breaker`,
`vector-db-lease-fencing`, `corpus-reembed`(-adversarial), `scheduler-managed-vector-reconcile`,
`scheduler-lane-observability`, `r5-db-modules` and `embedding-space-isolation` suites green
(37 tests in `embed-stage` + `sqlite-storage-hygiene`). Full-repo CI is the authority.

## Note for dashboards

`embed_stage_cap_prune` no longer exists (nothing is cap-pruned). Alert on **`embed_stage_over_cap`**
and **`embed_stage_undelivered_backlog`** instead.