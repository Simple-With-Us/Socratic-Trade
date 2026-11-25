// thirteen-f-vector-prune.ts — OD-7 receipt-safe prune of EMPTY-TICKER 13F holdings vectors.
//
// 2026-09-27 (B-3) wired `storeThirteenFHoldingsDocument` so 13F positions became
// retrievable; every one of those documents was written with `ticker: ""`, so each child
// vector carries `symbol: ""` metadata. An empty-symbol vector can never match a
// symbol-scoped query and bloats the payloads the index stores for nothing; that is the
// A4b junk class the owner approved for deletion.
//
// This module is purely provider-side: the local `chunk_occurrences` inventory cannot see
// the `13f-holdings` doc type (the local receipt rows inherit the sec-filings form code,
// not the storeDocument doc type), so classification reads the provider metadata via the
// shared inventory. Dry-run by default; a live delete requires the SAME confirm token the
// operational prune script uses, so one operator gesture, one token, one audit trail for
// every index deletion.

import { audit } from "../db";
import { inventoryVectorRecordsByMetadata } from "../vector-db";
import type { VectorMetadataInventoryRow } from "../vector-db";
import { PRUNE_CONFIRM_TOKEN } from "./operational-index-prune";

export const THIRTEEN_F_DOC_TYPE = "13f-holdings";

export type ThirteenFPruneReason =
  | "empty-ticker"
  | "keep-tickered"
  | "keep-wrong-doc-type";

export interface ThirteenFPruneDecision {
  id: string;
  action: "delete" | "keep";
  reason: ThirteenFPruneReason;
  symbol: string | undefined;
}

export interface ThirteenFPrunePlan {
  deleteIds: string[];
  keepIds: string[];
  decisions: ThirteenFPruneDecision[];
  counts: Record<ThirteenFPruneReason, number>;
}

function emptyTicker(symbol: unknown): boolean {
  if (typeof symbol !== "string") return true;
  return symbol.trim() === "";
}

/** Pure classification of one provider row. Exported for tests. */
export function classifyThirteenFVector(row: VectorMetadataInventoryRow): ThirteenFPruneDecision {
  const docType = String(row.metadata.doc_type ?? "").trim().toLowerCase();
  const symbol = typeof row.metadata.symbol === "string" ? row.metadata.symbol : undefined;
  if (docType !== THIRTEEN_F_DOC_TYPE) {
    return { id: row.id, action: "keep", reason: "keep-wrong-doc-type", symbol };
  }
  if (emptyTicker(symbol)) return { id: row.id, action: "delete", reason: "empty-ticker", symbol };
  return { id: row.id, action: "keep", reason: "keep-tickered", symbol };
}

export function planThirteenFVectorPrune(
  rows: readonly VectorMetadataInventoryRow[]
): ThirteenFPrunePlan {
  const decisions = rows.map(classifyThirteenFVector);
  const counts: Record<ThirteenFPruneReason, number> = {
    "empty-ticker": 0,
    "keep-tickered": 0,
    "keep-wrong-doc-type": 0
  };
  const deleteIds: string[] = [];
  const keepIds: string[] = [];
  for (const decision of decisions) {
    counts[decision.reason] += 1;
    if (decision.action === "delete") deleteIds.push(decision.id);
    else keepIds.push(decision.id);
  }
  return { deleteIds: deleteIds.sort(), keepIds: keepIds.sort(), decisions, counts };
}

export async function inventoryThirteenFHolderRows(options: {
  signal?: AbortSignal;
} = {}): Promise<VectorMetadataInventoryRow[]> {
  // 13F documents are plain `storeDocument` writes: they live in the default (empty)
  // namespace, matching the purge/erasure paths' namespace resolution.
  return inventoryVectorRecordsByMetadata({
    docType: THIRTEEN_F_DOC_TYPE,
    namespace: "default",
    signal: options.signal
  });
}

export async function runThirteenFVectorPrune(options: {
  dryRun?: boolean;
  confirm?: string;
  rows?: VectorMetadataInventoryRow[];
  deleteIds?: (ids: string[]) => Promise<number>;
} = {}): Promise<ThirteenFPrunePlan & { deleted: number; dryRun: boolean; inventoryError?: string }> {
  const dryRun = options.dryRun !== false;
  let rows: VectorMetadataInventoryRow[];
  try {
    rows = options.rows ?? (await inventoryThirteenFHolderRows());
  } catch (err) {
    // A provider outage must not masquerade as an all-clear. Report the zero-delete plan
    // with the inventory error named, and never advance to the delete clause.
    const message = err instanceof Error ? err.message : String(err);
    audit("od7_thirteen_f_prune", { dryRun: true, inventory_error: message });
    return {
      deleteIds: [],
      keepIds: [],
      decisions: [],
      counts: { "empty-ticker": 0, "keep-tickered": 0, "keep-wrong-doc-type": 0 },
      deleted: 0,
      dryRun: true,
      inventoryError: message
    };
  }
  const plan = planThirteenFVectorPrune(rows);
  if (dryRun || plan.deleteIds.length === 0) {
    audit("od7_thirteen_f_prune", {
      dryRun: true,
      scanned: rows.length,
      deleteCount: plan.deleteIds.length,
      keepCount: plan.keepIds.length,
      counts: plan.counts
    });
    return { ...plan, deleted: 0, dryRun: true };
  }
  if (options.confirm !== PRUNE_CONFIRM_TOKEN) {
    throw new Error(`Refusing live prune: confirm must be ${PRUNE_CONFIRM_TOKEN}`);
  }
  const deleted = options.deleteIds ? await options.deleteIds(plan.deleteIds) : 0;
  audit("od7_thirteen_f_prune", {
    dryRun: false,
    scanned: rows.length,
    deleteCount: plan.deleteIds.length,
    deleted,
    keepCount: plan.keepIds.length,
    counts: plan.counts
  });
  return { ...plan, deleted, dryRun: false };
}