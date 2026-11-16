// Receipt-safe prune of junk / raw-HTML / duplicate / low-value Pinecone vectors.
// Never deletes experience-memory, lessons, or useful full-body vectors that are
// the only copy of that document.  Dry-run by default.

import { audit, getDb } from "../db";
import { hasLocalFilingCopy } from "./persist-local-complete";
import {
  bareSecAccession,
  isDoNotTouchDocType,
  isProcessedDocType,
  itemCodeOfChunk,
  parseItemCodeFromSection
} from "./pinecone-write-class";

export const PRUNE_CONFIRM_TOKEN = "prune-operational-junk";

export type PruneReason =
  | "raw-html"
  | "duplicate"
  | "low-value"
  | "junk"
  | "keep-do-not-touch"
  | "keep-processed"
  | "keep-signal"
  | "keep-useful-body"
  | "keep-only-copy";

export interface OperationalVectorRow {
  id: string;
  text?: string;
  metadata: Record<string, unknown>;
}

export interface PruneDecision {
  id: string;
  action: "delete" | "keep";
  reason: PruneReason;
  accession: string | null;
  docType: string;
}

export interface OperationalPrunePlan {
  deleteIds: string[];
  keepIds: string[];
  decisions: PruneDecision[];
  counts: Record<PruneReason, number>;
}

const LOW_VALUE_SECTION =
  /\b(exhibit\s+\d+|signatures?|certifications?|index to (?:consolidated )?financial|xml document)\b/i;

export function looksLikeRawHtml(text: string | undefined): boolean {
  const sample = String(text ?? "").slice(0, 4_000);
  if (!sample.trim()) return false;
  if (/<!DOCTYPE\s+html/i.test(sample) || /<html[\s>]/i.test(sample)) return true;
  if (/xmlns:ix=|<xbrl[\s>]|<ix:nonNumeric/i.test(sample)) return true;
  const tags = sample.match(/<\/?[a-zA-Z][^>]{0,80}>/g) ?? [];
  if (tags.length < 8) return false;
  const tagChars = tags.join("").length;
  return tagChars / sample.length > 0.12;
}

export function isLowValueSection(section: string | undefined, itemCode?: string): boolean {
  const code = (itemCode || parseItemCodeFromSection(section)).trim().toLowerCase();
  if (code === "8" || code === "15" || code === "operator" || code === "0") return true;
  const hay = `${section ?? ""} ${itemCode ?? ""}`;
  return LOW_VALUE_SECTION.test(hay);
}

export function isJunkText(text: string | undefined): boolean {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 40) return true;
  if (/^(page \d+ of \d+|table of contents)$/i.test(cleaned)) return true;
  return false;
}

export function accessionOfVector(row: OperationalVectorRow): string | null {
  const meta = row.metadata;
  const candidates = [
    meta.accession,
    meta.doc_id,
    meta.document_key,
    row.id
  ];
  for (const value of candidates) {
    const bare = bareSecAccession(String(value ?? ""));
    if (bare) return bare;
  }
  const raw = String(meta.accession ?? meta.doc_id ?? "").trim();
  return raw || null;
}

export function classifyOperationalVector(row: OperationalVectorRow): {
  action: "delete" | "keep";
  reason: Exclude<PruneReason, "duplicate" | "keep-only-copy">;
} {
  const docType = String(row.metadata.doc_type ?? "").trim().toLowerCase();
  if (isDoNotTouchDocType(docType)) {
    return { action: "keep", reason: "keep-do-not-touch" };
  }
  if (isProcessedDocType(docType)) {
    return { action: "keep", reason: "keep-processed" };
  }
  const text = row.text ?? String(row.metadata.text ?? row.metadata.parent_text ?? "");
  if (looksLikeRawHtml(text)) {
    return { action: "delete", reason: "raw-html" };
  }
  if (isJunkText(text)) {
    return { action: "delete", reason: "junk" };
  }
  const section = String(row.metadata.section ?? "");
  const itemCode = itemCodeOfChunk({
    itemCode: typeof row.metadata.itemCode === "string" ? row.metadata.itemCode : undefined,
    section
  });
  const documentKey = String(row.metadata.document_key ?? row.metadata.doc_id ?? row.id);
  if (documentKey.includes(":section:")) {
    return { action: "keep", reason: "keep-signal" };
  }
  if (isLowValueSection(section, itemCode)) {
    return { action: "delete", reason: "low-value" };
  }
  return { action: "keep", reason: "keep-useful-body" };
}

function emptyCounts(): Record<PruneReason, number> {
  return {
    "raw-html": 0,
    duplicate: 0,
    "low-value": 0,
    junk: 0,
    "keep-do-not-touch": 0,
    "keep-processed": 0,
    "keep-signal": 0,
    "keep-useful-body": 0,
    "keep-only-copy": 0
  };
}

export function planOperationalIndexPrune(
  rows: readonly OperationalVectorRow[],
  localCopy?: (accession: string) => boolean
): OperationalPrunePlan {
  const hasCopy = localCopy ?? hasLocalFilingCopy;
  const decisions: PruneDecision[] = [];
  const seenHash = new Map<string, string>();

  for (const row of rows) {
    const first = classifyOperationalVector(row);
    const accession = accessionOfVector(row);
    const docType = String(row.metadata.doc_type ?? "").trim().toLowerCase();
    const hash = String(row.metadata.content_hash ?? "").trim();
    if (first.action === "keep" && hash) {
      const prior = seenHash.get(hash);
      if (prior) {
        decisions.push({
          id: row.id,
          action: "delete",
          reason: "duplicate",
          accession,
          docType
        });
        continue;
      }
      seenHash.set(hash, row.id);
    }
    decisions.push({
      id: row.id,
      action: first.action,
      reason: first.reason,
      accession,
      docType
    });
  }

  const usefulByAccession = new Map<string, number>();
  for (const decision of decisions) {
    if (!decision.accession) continue;
    if (decision.action === "keep" && (
      decision.reason === "keep-useful-body" ||
      decision.reason === "keep-processed" ||
      decision.reason === "keep-signal"
    )) {
      usefulByAccession.set(decision.accession, (usefulByAccession.get(decision.accession) ?? 0) + 1);
    }
  }

  for (const decision of decisions) {
    if (decision.action !== "delete") continue;
    if (decision.reason === "raw-html" || decision.reason === "junk" || decision.reason === "duplicate") {
      continue;
    }
    if (decision.reason !== "low-value") continue;
    const accession = decision.accession;
    if (!accession) {
      decision.action = "keep";
      decision.reason = "keep-only-copy";
      continue;
    }
    const useful = usefulByAccession.get(accession) ?? 0;
    if (useful === 0 && !hasCopy(accession)) {
      decision.action = "keep";
      decision.reason = "keep-only-copy";
    }
  }

  const counts = emptyCounts();
  const deleteIds: string[] = [];
  const keepIds: string[] = [];
  for (const decision of decisions) {
    counts[decision.reason] += 1;
    if (decision.action === "delete") deleteIds.push(decision.id);
    else keepIds.push(decision.id);
  }

  return { deleteIds, keepIds, decisions, counts };
}

export function inventoryPruneCandidatesFromLocal(limit = 20_000): OperationalVectorRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      o.vector_id AS id,
      o.accession AS accession,
      o.section AS section,
      o.content_hash AS content_hash,
      o.source AS source,
      f.text AS text,
      sf.form AS form
    FROM chunk_occurrences o
    LEFT JOIN document_chunks_fts f
      ON f.content_hash = o.content_hash
      AND f.symbol = o.symbol
      AND f.source = o.source
    LEFT JOIN sec_filings sf
      ON sf.accession = o.accession
      OR o.accession GLOB ('*:' || sf.accession || ':*')
      OR o.accession GLOB (sf.accession || ':*')
    WHERE o.source IN ('sec-edgar', 'sec-8k')
    LIMIT ?
  `).all(limit) as Array<{
    id: string;
    accession: string;
    section: string;
    content_hash: string;
    source: string;
    text: string | null;
    form: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    text: row.text ?? undefined,
    metadata: {
      accession: row.accession,
      section: row.section,
      content_hash: row.content_hash,
      source: row.source,
      doc_type: (row.form ?? "").toLowerCase()
    }
  }));
}

export async function applyOperationalIndexPrune(options: {
  dryRun?: boolean;
  confirm?: string;
  rows?: OperationalVectorRow[];
  userId?: string;
  deleteIds?: (ids: string[]) => Promise<number>;
}): Promise<OperationalPrunePlan & { deleted: number; dryRun: boolean }> {
  const dryRun = options.dryRun !== false;
  const rows = options.rows ?? inventoryPruneCandidatesFromLocal();
  const plan = planOperationalIndexPrune(rows);
  if (dryRun || plan.deleteIds.length === 0) {
    audit("operational_index_prune", {
      dryRun: true,
      deleteCount: plan.deleteIds.length,
      keepCount: plan.keepIds.length,
      counts: plan.counts
    });
    return { ...plan, deleted: 0, dryRun: true };
  }
  if (options.confirm !== PRUNE_CONFIRM_TOKEN) {
    throw new Error(`Refusing live prune: confirm must be ${PRUNE_CONFIRM_TOKEN}`);
  }
  const deleted = options.deleteIds
    ? await options.deleteIds(plan.deleteIds)
    : 0;
  audit("operational_index_prune", {
    dryRun: false,
    deleteCount: plan.deleteIds.length,
    deleted,
    keepCount: plan.keepIds.length,
    counts: plan.counts
  });
  return { ...plan, deleted, dryRun: false };
}
