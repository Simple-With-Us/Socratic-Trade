/**
 * Live completeness scores layered on the static data-catalog.
 *
 * - Numerical / table fields: fill rate from durable symbol_field_latest (or last cascade report).
 * - RAG / non-numeric: fraction of universe tickers that have ≥1 chunk or accession per doc type,
 *   plus a per-ticker partial score (share of expected doc types present).
 *
 * Completeness is NEVER claimed 100% just because some mega-caps have many 10-Ks —
 * excess filings do not inflate the score past 1.0 per ticker×docType.
 */

import { getChunkCoverage, getDb } from "./db";
import {
  CATALOG_FIELDS,
  CATALOG_SOURCES,
  CATEGORY_LABELS,
  catalogCategories,
  catalogFieldsByCategory,
  type CatalogField,
  type DataCategory
} from "./data-catalog";
import { resolveEnrichmentCoverageReport } from "./db-enrichment-coverage";
import { getSymbolFieldLatestBySymbol } from "./db-fundamentals";
import { normalizeSymbol } from "./money";

/** Doc types we score for RAG completeness (normalized lower-case). */
export const RAG_SCORE_DOC_TYPES = ["10-k", "10-q", "8-k", "earnings-transcript"] as const;
export type RagScoreDocType = (typeof RAG_SCORE_DOC_TYPES)[number];

export interface FieldCompletenessRow {
  fieldId: string;
  label: string;
  category: DataCategory;
  valueKind: CatalogField["valueKind"];
  /** 0–1 fill rate across the universe (or cascade sample). */
  completeness: number;
  filledCount: number;
  universeCount: number;
  method: "durable_store" | "cascade_report" | "rag_accession" | "rag_chunks" | "unknown";
  /** Provenance requirement always true in catalog; listed for admin UI. */
  provenanceRequired: true;
  sourceIds: string[];
  notes?: string;
}

export interface CategoryCompleteness {
  category: DataCategory;
  label: string;
  /** Mean of field completeness in this category (equal weight). */
  completeness: number;
  fields: FieldCompletenessRow[];
}

export interface RagTickerPartial {
  symbol: string;
  /** 0–1: share of RAG_SCORE_DOC_TYPES with ≥1 document. */
  partial: number;
  present: RagScoreDocType[];
  missing: RagScoreDocType[];
  chunkCount: number;
}

export interface DataCompletenessReport {
  asOf: string;
  universeSize: number;
  universeSource: string;
  /** Equal-weight mean of all catalog fields that have a live method. */
  overallCompleteness: number;
  /** Mean of non-rag_corpus fields. */
  numericalCompleteness: number;
  /** Mean of rag_corpus fields + mean ticker partial. */
  ragCompleteness: number;
  categories: CategoryCompleteness[];
  rag: {
    /** Symbols with any accession or chunk. */
    tickersWithAnyCorpus: number;
    /** Mean over universe of per-ticker partial (doc types present / expected). */
    meanTickerPartial: number;
    /** Per doc type: tickers with ≥1 / universe. */
    byDocType: Record<string, { completeness: number; tickersWith: number }>;
    /** Worst partials (missing most doc types). */
    weakestTickers: RagTickerPartial[];
    llmNote: string;
  };
  llmPresentation: {
    structuredScan: string;
    ragContext: string;
  };
}

function tableExists(name: string): boolean {
  try {
    const row = getDb()
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}

/** Resolve a reasonable universe: explicit symbols, else tickers seen in store/filings/chunks. */
export function resolveCompletenessUniverse(explicit?: string[]): {
  symbols: string[];
  source: string;
} {
  if (explicit && explicit.length > 0) {
    return {
      symbols: Array.from(new Set(explicit.map(normalizeSymbol).filter(Boolean))).sort(),
      source: "explicit"
    };
  }

  const set = new Set<string>();
  try {
    if (tableExists("symbol_field_latest")) {
      const rows = getDb().prepare("SELECT DISTINCT symbol FROM symbol_field_latest").all() as {
        symbol: string;
      }[];
      for (const r of rows) if (r.symbol) set.add(normalizeSymbol(r.symbol));
    }
  } catch {
    /* ignore */
  }
  try {
    if (tableExists("ingested_accessions")) {
      const rows = getDb().prepare("SELECT DISTINCT ticker FROM ingested_accessions").all() as {
        ticker: string;
      }[];
      for (const r of rows) if (r.ticker) set.add(normalizeSymbol(r.ticker));
    }
  } catch {
    /* ignore */
  }
  try {
    if (tableExists("sec_filings")) {
      const rows = getDb().prepare("SELECT DISTINCT ticker FROM sec_filings").all() as {
        ticker: string;
      }[];
      for (const r of rows) if (r.ticker) set.add(normalizeSymbol(r.ticker));
    }
  } catch {
    /* ignore */
  }

  const symbols = Array.from(set).filter(Boolean).sort();
  return {
    symbols,
    source: symbols.length ? "store+filings+accessions" : "empty"
  };
}

function numericalFieldIds(): Set<string> {
  return new Set(
    CATALOG_FIELDS.filter((f) => f.category !== "rag_corpus" && !f.id.startsWith("rag:")).map(
      (f) => f.id
    )
  );
}

/** Map catalog field id → durable store / enrichment field key. */
function storeKeyForField(fieldId: string): string | null {
  if (fieldId.startsWith("rag:")) return null;
  if (fieldId.startsWith("derived:")) return null;
  return fieldId;
}

function ragDocTypeForField(fieldId: string): RagScoreDocType | null {
  if (fieldId === "rag:10-k") return "10-k";
  if (fieldId === "rag:10-q") return "10-q";
  if (fieldId === "rag:8-k") return "8-k";
  if (fieldId === "rag:earnings-transcript") return "earnings-transcript";
  return null;
}

/**
 * Load accession counts by ticker and normalized doc_type.
 * Handles 10-K vs 10-k casing.
 */
export function loadRagAccessionIndex(): Map<string, Map<string, number>> {
  const byTicker = new Map<string, Map<string, number>>();
  if (!tableExists("ingested_accessions")) return byTicker;
  try {
    const rows = getDb()
      .prepare(
        `SELECT UPPER(ticker) AS ticker, LOWER(doc_type) AS doc_type, COUNT(*) AS n
         FROM ingested_accessions
         GROUP BY UPPER(ticker), LOWER(doc_type)`
      )
      .all() as Array<{ ticker: string; doc_type: string; n: number }>;
    for (const row of rows) {
      const sym = normalizeSymbol(row.ticker);
      if (!sym) continue;
      let m = byTicker.get(sym);
      if (!m) {
        m = new Map();
        byTicker.set(sym, m);
      }
      // Normalize aliases
      let dt = row.doc_type;
      if (dt === "10k") dt = "10-k";
      if (dt === "10q") dt = "10-q";
      if (dt === "8k") dt = "8-k";
      if (dt.includes("transcript")) dt = "earnings-transcript";
      m.set(dt, (m.get(dt) ?? 0) + row.n);
    }
  } catch {
    /* ignore */
  }
  return byTicker;
}

export function loadChunkCountsBySymbol(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    for (const row of getChunkCoverage()) {
      const s = normalizeSymbol(row.symbol);
      if (s) out.set(s, row.chunkCount);
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function buildDataCompletenessReport(explicitUniverse?: string[]): DataCompletenessReport {
  const { symbols: universe, source: universeSource } = resolveCompletenessUniverse(explicitUniverse);
  const universeCount = universe.length;
  const accessionIndex = loadRagAccessionIndex();
  const chunkCounts = loadChunkCountsBySymbol();
  const cascade = resolveEnrichmentCoverageReport();
  const durable = universeCount > 0 ? getSymbolFieldLatestBySymbol(universe) : {};

  const fieldRows: FieldCompletenessRow[] = [];

  for (const field of CATALOG_FIELDS) {
    const sourceIds = field.sources.map((s) => s.sourceId);
    const ragType = ragDocTypeForField(field.id);
    if (ragType) {
      let tickersWith = 0;
      if (universeCount > 0) {
        for (const sym of universe) {
          const n = accessionIndex.get(sym)?.get(ragType) ?? 0;
          if (n > 0) tickersWith += 1;
        }
      }
      const completeness = universeCount === 0 ? 0 : tickersWith / universeCount;
      fieldRows.push({
        fieldId: field.id,
        label: field.label,
        category: field.category,
        valueKind: field.valueKind,
        completeness,
        filledCount: tickersWith,
        universeCount,
        method: "rag_accession",
        provenanceRequired: true,
        sourceIds,
        notes:
          universeCount === 0
            ? "Empty universe — no symbols in durable store or filing ledgers yet."
            : `${tickersWith}/${universeCount} tickers have ≥1 ${ragType} (extra filings on one name do not raise score above 1).`
      });
      continue;
    }

    const storeKey = storeKeyForField(field.id);
    if (storeKey && universeCount > 0) {
      let filled = 0;
      for (const sym of universe) {
        const row = durable[sym]?.[storeKey];
        if (row && row.value !== undefined && row.value !== null && row.value !== "") filled += 1;
      }
      // Prefer durable store when any hits; else fall back to cascade report fill rate.
      if (filled > 0 || !cascade) {
        fieldRows.push({
          fieldId: field.id,
          label: field.label,
          category: field.category,
          valueKind: field.valueKind,
          completeness: filled / universeCount,
          filledCount: filled,
          universeCount,
          method: "durable_store",
          provenanceRequired: true,
          sourceIds,
          notes: `Durable symbol_field_latest: ${filled}/${universeCount} symbols have a latest value (each with its own as_of/fetched_at).`
        });
        continue;
      }
    }

    if (cascade) {
      const cov = cascade.fields.find((f) => f.field === storeKey);
      const hl = field.id === "headlines" ? cascade.headlines : undefined;
      const row = cov ?? (hl ? { filledCount: hl.filledCount, totalSymbols: hl.totalSymbols, fillRate: hl.fillRate } : undefined);
      if (row) {
        fieldRows.push({
          fieldId: field.id,
          label: field.label,
          category: field.category,
          valueKind: field.valueKind,
          completeness: row.fillRate,
          filledCount: row.filledCount,
          universeCount: row.totalSymbols,
          method: "cascade_report",
          provenanceRequired: true,
          sourceIds,
          notes: "From last cascade coverage report (durable store or in-memory from current process)."
        });
        continue;
      }
    }

    fieldRows.push({
      fieldId: field.id,
      label: field.label,
      category: field.category,
      valueKind: field.valueKind,
      completeness: 0,
      filledCount: 0,
      universeCount,
      method: "unknown",
      provenanceRequired: true,
      sourceIds,
      notes: "No durable or cascade sample yet."
    });
  }

  // Category rollups
  const byCat = new Map<DataCategory, FieldCompletenessRow[]>();
  for (const row of fieldRows) {
    const list = byCat.get(row.category) ?? [];
    list.push(row);
    byCat.set(row.category, list);
  }
  const categories: CategoryCompleteness[] = [];
  for (const [category, fields] of byCat) {
    const completeness =
      fields.length === 0 ? 0 : fields.reduce((s, f) => s + f.completeness, 0) / fields.length;
    categories.push({
      category,
      label: CATEGORY_LABELS[category],
      completeness,
      fields
    });
  }
  categories.sort((a, b) => a.label.localeCompare(b.label));

  // Per-ticker RAG partial
  const tickerPartials: RagTickerPartial[] = [];
  const byDocType: Record<string, { completeness: number; tickersWith: number }> = {};
  for (const dt of RAG_SCORE_DOC_TYPES) {
    let tickersWith = 0;
    for (const sym of universe) {
      if ((accessionIndex.get(sym)?.get(dt) ?? 0) > 0) tickersWith += 1;
    }
    byDocType[dt] = {
      tickersWith,
      completeness: universeCount === 0 ? 0 : tickersWith / universeCount
    };
  }

  for (const sym of universe) {
    const present: RagScoreDocType[] = [];
    const missing: RagScoreDocType[] = [];
    for (const dt of RAG_SCORE_DOC_TYPES) {
      if ((accessionIndex.get(sym)?.get(dt) ?? 0) > 0) present.push(dt);
      else missing.push(dt);
    }
    tickerPartials.push({
      symbol: sym,
      partial: present.length / RAG_SCORE_DOC_TYPES.length,
      present,
      missing,
      chunkCount: chunkCounts.get(sym) ?? 0
    });
  }
  const meanTickerPartial =
    tickerPartials.length === 0
      ? 0
      : tickerPartials.reduce((s, t) => s + t.partial, 0) / tickerPartials.length;
  const weakestTickers = [...tickerPartials].sort((a, b) => a.partial - b.partial).slice(0, 40);

  const numFields = fieldRows.filter((f) => f.category !== "rag_corpus");
  const ragFields = fieldRows.filter((f) => f.category === "rag_corpus");
  const numericalCompleteness =
    numFields.length === 0 ? 0 : numFields.reduce((s, f) => s + f.completeness, 0) / numFields.length;
  const ragFieldMean =
    ragFields.length === 0 ? 0 : ragFields.reduce((s, f) => s + f.completeness, 0) / ragFields.length;
  // Blend accession-by-type mean with per-ticker partial (both 0–1).
  const ragCompleteness = (ragFieldMean + meanTickerPartial) / 2;
  const overallCompleteness =
    fieldRows.length === 0
      ? 0
      : fieldRows.reduce((s, f) => s + f.completeness, 0) / fieldRows.length;

  const tickersWithAnyCorpus = tickerPartials.filter(
    (t) => t.present.length > 0 || t.chunkCount > 0
  ).length;

  return {
    asOf: new Date().toISOString(),
    universeSize: universeCount,
    universeSource,
    overallCompleteness,
    numericalCompleteness,
    ragCompleteness,
    categories,
    rag: {
      tickersWithAnyCorpus,
      meanTickerPartial,
      byDocType,
      weakestTickers,
      llmNote:
        "Strategy presents RAG as retrievedFinancialContext: deep pass (~8 chunks) for top-3 candidates + held names; scout (~1 chunk) for other scan candidates. Full corpus is never dumped into the prompt. Empty doc types emit a corpus-coverage safety receipt."
    },
    llmPresentation: {
      structuredScan:
        "marketScan.topCandidates compact fields (px, pe, epsGr, div, news, rating, …) — missing keys omitted, not blank.",
      ragContext:
        "retrievedFinancialContext from vector retrieval with provenance lines; not a completeness guarantee."
    }
  };
}

/** Static catalog payload for admin UI (no DB). */
export function buildCatalogPayload() {
  return {
    sources: CATALOG_SOURCES,
    categories: catalogCategories().map((c) => ({
      id: c,
      label: CATEGORY_LABELS[c],
      fields: catalogFieldsByCategory()[c] ?? []
    })),
    provenancePolicy:
      "Every observation should carry source + as_of + fetched_at. Durable store symbol_field_latest enforces per-field stamps; RAG chunks carry doc_type/source metadata at write time."
  };
}
