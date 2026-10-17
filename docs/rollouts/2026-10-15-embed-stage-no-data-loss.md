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

While this was in review, #4722 ("keep strategy runs and logs forever") landed on main and made the
age window and size cap no-ops outright. This branch is rebased on that decision rather than
reversing it: the sweep keeps no deletes at all, and keeps the part #4722 did not do — the
delivery receipt gate, quarantine instead of delete, and the loud alarms.

## Change

ST data is kept forever. Deletion of a staged vector now requires proof of durable delivery.

- **`deleteStagedEmbeddings(hashes, model, revision, receipt)`** takes a **required**
  `EmbedStageDeliveryReceipt` naming the store that acknowledged the upsert (`"pinecone" | "qdrant"`).
  It stamps `delivered_at`/`delivered_store`, then deletes only rows carrying that exact receipt, so
  a key concurrently re-staged (receipt cleared) can never be removed by an older delivery. No
  overload deletes without naming the store — losing a paid vector is unrepresentable.
  The stamp and the delete are **separate transactions**: a crash between them leaves a
  "delivered but stranded" row that carries a durable receipt, instead of rolling the evidence of
  delivery back.
- **`sweepEmbedStage` is a read-only observer — it issues no DELETE at all.** Rows clear only
  through `deleteStagedEmbeddings`, by key, after a receipt. This also keeps
  `test/forever-retention-no-age-delete.test.ts` (added by #4722 on 2026-10-15) green. Undelivered
  rows past the 35-day window are counted and reported via a new `embed_stage_undelivered_backlog`
  audit row + Sentry warning.
- **The size cap deletes nothing.** It emits one `embed_stage_over_cap` audit row + Sentry warning
  with rows/undelivered/oldest-undelivered and sets `overCap: true`. An over-cap table means
  delivery is stuck and a human should look, not that bytes should be thrown away.
- **Undecodable rows are quarantined, not deleted** — marked `quarantined_at`/`quarantine_reason`
  (`undecodable_vector:dims=…:bytes=…`), reported as a miss so the caller re-embeds from source, and
  healed by that re-embed (`INSERT OR REPLACE` clears the marker). One `embed_stage_quarantine`
  audit row per lookup, never one per corrupt row. A quarantined row is kept until that re-embed
  lands.
- **`sqlite-storage-hygiene.ts`** no longer carries an `embed_stage` retention target at all
  (per #4722), so no hygiene statement can touch a staged vector.

### Schema (additive)

New nullable columns on `embed_stage`: `delivered_at`, `delivered_store`, `quarantined_at`,
`quarantine_reason`, plus `idx_embed_stage_delivered`. Guarded `ALTER TABLE` migration for existing
databases. **Pre-existing rows default to `delivered_at = NULL`** — "never proven delivered", the
conservative reading, so a pre-migration row is re-verified on the next retry instead of assumed
safe to delete.

### Callers

`vector-db.ts` (both delete sites — plain per-batch, and managed two-phase after
`markCommitted`, each passing the backend that acknowledged the upsert), `audit-prune.ts`
(the lane's only remaining work is the read-only observer; `AuditPruneResult` gains
`embedStageUndeliveredRetained`, and `expired`/`capPruned` are now structurally zero),
`scheduler.ts` (lane summary reports `embed_stage_undelivered=`), `sqlite-storage-hygiene.ts`
(checked — no `embed_stage` deleter remains after #4722).

## Decisions & Trade-offs

- **Forever retention wins over reclaiming stranded rows.**  #4722 made ST data keep-forever and added
  `test/forever-retention-no-age-delete.test.ts`, so the sweep issues no delete at all.  A row can
  therefore end up "delivered but stranded": the store acknowledged the vector and the receipt was
  stamped, but the by-key delete threw or the process died between the two transactions.  Such a row
  is kept, and no sweep removes it.  Only a later by-key `deleteStagedEmbeddings` call for the same
  content hash can.  The code comments in `vector-db.ts` and `db-embed-stage.ts` said a "retention
  lane" reclaims these rows; that was stale after #4722 and is corrected here.
- **Stranded rows are bounded but not separately counted.**  A stranded row carries `delivered_at`,
  so it is not in `undelivered`.  It is visible only as `rows - undelivered` from `embedStageStats()`
  and in the byte total behind the `embed_stage_over_cap` alarm.  A dedicated counter or a
  receipt-scoped cleanup (never a `created_at` predicate) is a separate decision that would also
  need `test/forever-retention-no-age-delete.test.ts` amended, so it is left as a follow-up.
- **The observer is one scan.**  `sweepEmbedStage` reads the table once (`embedStageStats(cutoff)`),
  because `SUM(LENGTH(vector))` reads every blob and the table can no longer shrink on its own.
- **Held for the owner.**  The diff touches `src/lib/scheduler.ts`, a CODEOWNERS money path (a
  change to the audit-prune lane summary string only, no scheduling or order logic), so this PR
  is merged by the owner and not by an agent.

## Tests

`test/embed-stage.test.ts` — the sweep suites plus new ones: every aged row survives whether
delivered or not, the backlog audit fires once per sweep, the over-cap path deletes zero rows and
raises exactly one alarm, the audit-prune lanes report without deleting, the receipt is required
(the old 3-arg shape throws and keeps the row), re-staging clears a receipt, quarantine keeps +
marks + heals on re-embed, and `embedStageStats` reports the backlog.
`test/sqlite-storage-hygiene.test.ts` — a delivered 50-day-old staged row survives the hygiene lane.
`test/audit-hygiene.test.ts` — updated for the new result field.
`test/db-migration-old-schema.test.ts` — regression for the baseline-DDL index ordering bug below.

## Migration ordering bug caught in review

The first cut of this branch created `idx_embed_stage_delivered` inside the baseline DDL block,
right after `CREATE TABLE IF NOT EXISTS embed_stage`. On a pre-ST-4540 database that CREATE TABLE
is a no-op — the table already exists *without* `delivered_at` — so the index statement aborted the
whole migration with `no such column: delivered_at` on every boot. CI would never have caught it,
because CI starts from a fresh database where the baseline CREATE TABLE does include the column.

This is the same failure mode `test/db-migration-old-schema.test.ts` already documents for the
2026-07-02 `chat_turns` boot crash (#333), and the general rule is the reusable part: **an additive
column added to baseline DDL must not be indexed in that same block** — create the index in the
guarded `ALTER TABLE` block, after the column is known to exist. A migration regression test needs a
hand-built pre-migration fixture; a fresh-DB test can never reach that code path.

## Note for dashboards

`embed_stage_cap_prune` no longer exists (nothing is cap-pruned). Alert on **`embed_stage_over_cap`**
and **`embed_stage_undelivered_backlog`** instead.

## Verification State

Run in `claude-pr4742-sweep` (a Socratic-Trade lane) on the branch tip after merging `origin/main`,
2026-10-16, in the order AGENTS.md prescribes:

```bash
npm run lint       # exit 0 (0 errors; the grandfathered warning backlog is unchanged)
npx tsc --noEmit   # exit 0
npm test           # 845 files passed, 2 failed;  9494 tests passed, 2 failed (see below)
npm run build      # exit 0
```

The two `npm test` failures are wall-clock tests that do not touch `embed_stage` or any file in this PR:

- `test/sqlite-all-offloop.test.ts` ("reclaims a wedged slot after caller abort ...") failed under
  full-suite load and **passed** when the file was re-run alone.
- `test/event-loop-stall-hot-path.test.ts` ("pruneTaskJournal no-op stays under 100ms ...") failed
  here, and failed again when re-run alone, because inserting its 2,000,000 fixture rows takes about
  250s on this Mac (the lane is on an external volume) and blows its time budget.  The same test
  failed in GitHub CI on the previous push (run 38997824198) with `expected 99 to be greater than or
  equal to 100`, a scan-time threshold, after passing on the head before it.

The five suites this PR owns are inside that run and all passed: `test/embed-stage.test.ts`,
`test/db-migration-old-schema.test.ts`, `test/sqlite-storage-hygiene.test.ts`,
`test/audit-hygiene.test.ts` and `test/forever-retention-no-age-delete.test.ts` (58 tests).
GitHub CI on the pushed head is the authority for the gate; this note does not claim its result.

## Next Steps & Blockers

- **Blocker:** the owner reviews and merges, because the diff touches the CODEOWNERS money path
  `src/lib/scheduler.ts`.  Auto-merge was disarmed for that reason.
- Wire `embed_stage_over_cap` and `embed_stage_undelivered_backlog` into the alerting dashboard so
  the new alarms page a human and do not stay Sentry noise.
- Decide whether stranded delivered rows need their own counter or a receipt-scoped cleanup (see
  Decisions); file a Linear issue if so.
- Watch quarantine healing on the first real `undecodable_vector` event and check the reason format.

## Recall

```bash
recall contribute "When a stage table represents work already paid for but not yet durably delivered (e.g., an embed awaiting vector-store acknowledgement), deletion must require a delivery receipt from the backend that acknowledged it — age windows and size caps should observe and alarm rather than delete, and undecodable rows should be quarantined with a marker so a re-run from source heals them instead of destroying the evidence of the paid work." --category lesson --app socratic-trade
```

Separately, when adding a column to baseline DDL, never index it in that same block: index it in the
guarded ALTER TABLE migration, and back it with a pre-migration fixture test, because a fresh-DB CI
run cannot reach the broken path.
