#!/usr/bin/env node
// OD-7 operational vector index prune: receipts report + operator-gated live delete.
//
// Default (no flags): prints the DRY-RUN COUNTS REPORT (receipt 1) as JSON:
//   - operationalPrune: the existing local-ledger junk planner (Form 4 XML vectors land in
//     its raw-html / junk / low-value classes), dry-run only;
//   - supersededLedger: committed vector_ingest_commits rows that are no longer the
//     document head (the generations whose provider vectors the live run retires);
//   - reconcileDryRun: provider-side reconcile dry-run WITH purgeSuperseded, so deleteIds
//     and invalidateCommitIds cover the superseded generations;
//   - thirteenF: provider-side inventory of doc_type 13f-holdings split by tickered /
//     empty-ticker, where empty-symbol rows are the A4b junk class.
// The two provider sections report "skipped" when QDRANT_URL is not configured rather
// than failing the report: the operator runs this on a host that CAN see the index.
//
// Live delete (receipt 2) requires --apply --confirm=prune-operational-junk (the SAME
// token every index deletion uses). The token is validated BEFORE any provider mutation
// and performs, in this order:
//   1. reconcileManagedVectorRecords({ dryRun: false, purgeSuperseded: true }) — deletes
//      superseded-generation provider vectors under the existing CAS claim + operation
//      lease fences;
//   2. runThirteenFVectorPrune({ dryRun: false }) — deletes empty-ticker 13F vectors by
//      exact id through purgeVectorRecordIds.
// Never deletes experience-memory, lessons, coach notes, or head-generation vectors.
// Does not flip RAG_PINECONE_WRITE_CLASS, does not charge Stripe, does not trade.

import { applyOperationalIndexPrune, PRUNE_CONFIRM_TOKEN } from "../src/lib/rag/operational-index-prune";
import { runThirteenFVectorPrune } from "../src/lib/rag/thirteen-f-vector-prune";
import { purgeVectorRecordIds, reconcileManagedVectorRecords } from "../src/lib/vector-db";
import { getDb } from "../src/lib/db";

function arg(name: string): string | undefined {
  const prefix = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

interface SupersededLedgerReceipt {
  committedCommits: number;
  supersededCommitted: number;
  supersededExpectedVectors: number;
  abortedCommits: number;
  pendingCommits: number;
}

function supersededLedgerCounts(): SupersededLedgerReceipt {
  const db = getDb();
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS committedCommits,
      SUM(CASE WHEN h.commit_id IS NULL THEN 1 ELSE 0 END) AS supersededCommitted,
      SUM(CASE WHEN h.commit_id IS NULL THEN c.expected_vectors ELSE 0 END) AS supersededExpectedVectors,
      SUM(CASE WHEN c.state = 'aborted' THEN 1 ELSE 0 END) AS abortedCommits,
      SUM(CASE WHEN c.state = 'pending' THEN 1 ELSE 0 END) AS pendingCommits
    FROM vector_ingest_commits c
    LEFT JOIN vector_document_heads h
      ON h.commit_id = c.id
      AND h.tenant_scope = c.tenant_scope
      AND h.source = c.source
      AND h.accession = c.document_key
    WHERE c.state IN ('committed','aborted','pending','receipts_persisted')
  `).get() as Record<string, number | null>;
  const num = (key: string) => Number(counts[key] ?? 0);
  return {
    committedCommits: num("committedCommits"),
    supersededCommitted: num("supersededCommitted"),
    supersededExpectedVectors: num("supersededExpectedVectors"),
    abortedCommits: num("abortedCommits"),
    pendingCommits: num("pendingCommits")
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const confirm = arg("--confirm");
  const providerReachable = Boolean(process.env.QDRANT_URL?.trim());

  // Refuse BEFORE any provider mutation, not after.
  if (apply && confirm !== PRUNE_CONFIRM_TOKEN) {
    console.error(`live delete refused: --confirm must equal ${PRUNE_CONFIRM_TOKEN}`);
    process.exitCode = 2;
    return;
  }

  const report: Record<string, unknown> = {
    mode: apply ? "live" : "dry-run",
    providerReachable
  };

  // Section 1: local-ledger operational prune (Form 4 XML / junk / raw-html / low-value).
  try {
    const operational = await applyOperationalIndexPrune({ dryRun: true });
    report.operationalPrune = {
      deleteCount: operational.deleteIds.length,
      keepCount: operational.keepIds.length,
      counts: operational.counts
    };
  } catch (err) {
    report.operationalPrune = { error: err instanceof Error ? err.message : String(err) };
  }

  // Section 2: local-ledger superseded-generation census. Fails open like every other
  // receipt section: a locked/missing DB must report a section error, not discard the receipt.
  try {
    report.supersededLedger = supersededLedgerCounts();
  } catch (err) {
    report.supersededLedger = { error: err instanceof Error ? err.message : String(err) };
  }

  // Section 3: provider-side reconcile dry-run (or live) with superseded purge.
  try {
    if (!providerReachable) {
      report.reconcile = { skipped: "QDRANT_URL not configured" };
    } else {
      const reconcile = await reconcileManagedVectorRecords({
        dryRun: !apply,
        purgeSuperseded: true
      });
      report.reconcile = {
        dryRun: reconcile.dryRun,
        promoted: reconcile.promoted,
        deleted: reconcile.deleted,
        deleteIds: reconcile.deleteIds.length,
        invalidateCommitIds: reconcile.invalidateCommitIds.length,
        repairCommitIds: reconcile.repairCommitIds.length,
        quarantineIds: reconcile.quarantineIds.length,
        ...(reconcile.skipped ? { skipped: true } : {})
      };
    }
  } catch (err) {
    report.reconcile = { error: err instanceof Error ? err.message : String(err) };
  }

  // Section 4: empty-ticker 13F provider inventory / prune.
  try {
    if (!providerReachable) {
      report.thirteenF = { skipped: "QDRANT_URL not configured" };
    } else {
      const thirteenF = await runThirteenFVectorPrune({
        dryRun: !apply,
        confirm,
        deleteIds: async (ids) => (await purgeVectorRecordIds({ ids })).deleted
      });
      report.thirteenF = {
        dryRun: thirteenF.dryRun,
        deleted: thirteenF.deleted,
        deleteCount: thirteenF.deleteIds.length,
        keepCount: thirteenF.keepIds.length,
        counts: thirteenF.counts,
        ...(thirteenF.inventoryError ? { inventoryError: thirteenF.inventoryError } : {})
      };
    }
  } catch (err) {
    report.thirteenF = { error: err instanceof Error ? err.message : String(err) };
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});