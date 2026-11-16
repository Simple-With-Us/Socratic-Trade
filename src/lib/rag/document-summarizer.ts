// Document Summarizer Engine (Layer 3: Derived Abstracts & Summaries)
//
// Extracts structured abstracts and briefs from raw source chunks (10-K, 10-Q, 8-K, transcripts),
// links every extracted fact to source_chunk_ids, saves the structured summary into the relational DB
// `document_abstracts` table, and embeds the summary document into the RAG vector corpus.
//
// Design (owner 2026-08-05/06): for trading proposals the LLM needs BOTH full narrative (when
// retrieved) AND short highlights. Full bodies stay in their native doc_type; this path writes
// compact `document-summary` / `earnings-summary` vectors so retrieval can surface catalysts
// without stuffing multi-hundred-KB filings into every prompt.
//
// Highlights are ALWAYS extractive (section-aware scoring + diversity). No generative LLM on
// the ingest path. Embed/rerank use cheap BAAI/BGE-class models via OpenRouter/SiliconFlow.

import {
  insertDocumentAbstract,
  DocumentAbstract,
  getDb,
  deleteDocumentAbstractByAccessionAndSource,
  deleteDocumentChunkFtsBySourceAccession,
  insertDocumentChunkFts
} from "../db";
import { storeDocument } from "../vector-db";
import { jaccardSimilarity } from "./dedupe-similar";
import { tokenize } from "./hybrid";
import { chunkDocument, hashContent, type ChunkInput } from "./chunk";
import { parseItemCodeFromSection } from "./pinecone-write-class";
import { timeSync } from "../slow-sync-guard";

/** Bump when extractive algorithm changes so existing abstracts re-generate once. */
export const DOCUMENT_HIGHLIGHT_MODEL = "extractive-highlights-v2";

/** @deprecated observability alias — older rows used this label */
export const DOCUMENT_HIGHLIGHT_MODEL_V1 = "document-synthesizer-v1";

export type FormHint = "10-K" | "10-Q" | "8-K" | "earnings" | "generic";

export interface HighlightSection {
  itemCode?: string;
  itemTitle?: string;
  text: string;
}

export interface TradeHighlightOptions {
  maxChunks?: number;
  maxCharsPerChunk?: number;
  /** Structured SEC sections from parseFilingHtml when available. */
  sections?: HighlightSection[];
  formHint?: FormHint;
  /**
   * Max Jaccard (trigram shingles) similarity allowed vs an already-kept highlight.
   * Default 0.55. Set 1 to disable diversity.
   */
  diversityJaccard?: number;
  /** Soft prior for 8-K material item codes (e.g. ["2.02","5.02"]). */
  materialItems?: string[];
  /**
   * When the producer already chunked the filing, reuse those FTS content_hash
   * values on highlights so hydrateAccession can look them up.  Synthetic hl:
   * ids remain only when no matching source chunk is known.
   */
  sourceChunks?: Array<{ content_hash: string; text: string; itemCode?: string; section?: string }>;
}

export interface HighlightChunk {
  id: string;
  text: string;
  itemCode?: string;
  itemTitle?: string;
  score?: number;
}

export interface SummarizeDocumentInput {
  ticker: string;
  accessionOrEventId: string;
  sourceType: "10k-delta" | "10q-delta" | "earnings-summary" | "8k-brief" | string;
  headline: string;
  chunks: Array<{ id: string; text: string }>;
  publishedAt?: string;
  acceptanceDatetime?: string;
  /** Force re-write even when current model abstract exists. */
  force?: boolean;
}

export interface SummarizeDocumentResult {
  abstractId: string;
  skipped: boolean;
  error?: string;
  refreshed?: boolean;
}

// ── Lexicons & section priors (deterministic) ───────────────────────────────

const KEYWORD_WEIGHTS: Array<{ re: RegExp; w: number }> = [
  { re: /\bguidance\b/i, w: 3 },
  { re: /\boutlook\b/i, w: 3 },
  { re: /\brevenue\b/i, w: 2 },
  { re: /\bmargin(s)?\b/i, w: 2 },
  { re: /\beps\b/i, w: 3 },
  { re: /\bearnings\b/i, w: 2 },
  { re: /\bdemand\b/i, w: 2 },
  { re: /\bbacklog\b/i, w: 2 },
  { re: /\blawsuit|litigation|investigation\b/i, w: 3 },
  { re: /\bimpairment\b/i, w: 3 },
  { re: /\bgoodwill\b/i, w: 2 },
  { re: /\brestructuring\b/i, w: 2 },
  { re: /\bacquisition|acquire|merger|divest\b/i, w: 2 },
  { re: /\bceo\b|\bcfo\b/i, w: 1 },
  { re: /\brisk factor/i, w: 2 },
  { re: /\bmaterial\b/i, w: 1 },
  { re: /\byoy\b|year[- ]over[- ]year/i, w: 2 },
  { re: /\bsequential(ly)?\b/i, w: 2 },
  { re: /\bliquidity\b|\bcovenant\b|\bgoing concern\b/i, w: 3 },
  { re: /\bbuyback|repurchase|dividend\b/i, w: 2 },
  { re: /\bcybersecurity|data breach\b/i, w: 2 },
  { re: /\bitem\s*2\.02\b/i, w: 4 },
  { re: /\bitem\s*5\.02\b/i, w: 4 },
  { re: /\bitem\s*1\.01\b/i, w: 3 },
  { re: /\bitem\s*1\.02\b/i, w: 3 },
  { re: /\bitem\s*8\.01\b/i, w: 3 },
  { re: /\bitem\s*4\.0[12]\b/i, w: 3 },
  { re: /\bcapex\b|capital expenditure/i, w: 2 },
  { re: /\boperating income\b|\bebitda\b/i, w: 2 }
];

function sectionPrior(formHint: FormHint, itemCode: string | undefined): number {
  if (!itemCode) return 0;
  const code = itemCode.replace(/^Item\s*/i, "").trim().toUpperCase();
  // Standalone section slugs from parseFilingHtml (no "Item N" heading)
  if (/RISK[- ]?FACTOR/i.test(code) || code === "1A") return 5;
  if (/MDA|MD&A|DISCUSSION/i.test(code) || code === "7") return 5;
  if (/FINANCIAL[- ]?STATEMENT/i.test(code) || code === "8") return 3;
  if (/MARKET[- ]?RISK|7A/i.test(code)) return 3;
  if (/LEGAL|PROCEEDING/i.test(code) || code === "3") return 2;
  if (/CONTROL/i.test(code) || code === "9A") return 1;

  if (formHint === "10-Q") {
    if (code === "1" || /PART\s*I.*ITEM\s*1/i.test(code)) return 3;
    if (code === "2" || /PART\s*I.*ITEM\s*2/i.test(code)) return 5;
    if (code === "1A" || code === "3") return 3;
    if (code === "4") return 1;
  }
  if (formHint === "10-K") {
    if (code === "1A") return 5;
    if (code === "1" || code === "1B" || code === "1C") return 2;
    if (code === "7") return 5;
    if (code === "7A") return 3;
    if (code === "8") return 3;
    if (code === "3") return 2;
    if (code === "9A") return 1;
  }
  if (formHint === "8-K") {
    if (/^2\.02/.test(code)) return 5;
    if (/^5\.02/.test(code)) return 4;
    if (/^1\.0[123]/.test(code)) return 3;
    if (/^4\.0[12]/.test(code)) return 3;
    if (/^8\.01/.test(code)) return 3;
    if (/^2\.01/.test(code)) return 3;
  }
  return 0;
}

function keywordScore(text: string): number {
  let score = 0;
  for (const { re, w } of KEYWORD_WEIGHTS) {
    if (re.test(text)) score += w;
  }
  return score;
}

function numericSignalScore(text: string): number {
  let score = 0;
  if (/\$[\d,.]+|\d+(\.\d+)?\s*%|\d+\s*bp\b/i.test(text)) score += 2;
  if (/\b(million|billion|basis points)\b/i.test(text)) score += 1;
  // Cap so tables don't dominate purely by digit density
  const digitRatio = (text.replace(/\D/g, "").length / Math.max(1, text.length));
  if (digitRatio > 0.15 && digitRatio < 0.45) score += 1;
  return score;
}

interface Candidate {
  text: string;
  itemCode?: string;
  itemTitle?: string;
  sectionKey: string;
  index: number;
  score: number;
  contentHash?: string;
}

function splitParagraphs(text: string, minLen = 60): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= minLen);
}

/**
 * Split 8-K (or similar) body text on "Item X.XX" headings into pseudo-sections.
 * Pure regex — no HTML required.
 */
export function splitTextBySecItems(text: string): HighlightSection[] {
  const cleaned = text.replace(/\r/g, "").trim();
  if (!cleaned) return [];
  const re = /(?:^|\n)\s*((?:ITEM|Item)\s+(\d+\.\d{2})[^\n]*)/g;
  const matches: Array<{ title: string; code: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    matches.push({ title: m[1].trim(), code: m[2], index: m.index + (m[0].startsWith("\n") ? 1 : 0) });
  }
  if (matches.length === 0) {
    return [{ text: cleaned }];
  }
  const sections: HighlightSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : cleaned.length;
    const body = cleaned.slice(start, end).trim();
    if (body.length < 40) continue;
    sections.push({
      itemCode: matches[i].code,
      itemTitle: matches[i].title.replace(/^ITEM\s+/i, "Item "),
      text: body
    });
  }
  return sections.length > 0 ? sections : [{ text: cleaned }];
}

/**
 * Earnings-call soft split: prepared remarks vs Q&A when headings exist.
 */
export function splitEarningsTranscript(text: string): HighlightSection[] {
  const cleaned = text.replace(/\r/g, "").trim();
  if (!cleaned) return [];
  const qaMatch = cleaned.search(
    /\n\s*(question[- ]and[- ]answer|q\s*&\s*a|questions and answers)\s*\n/i
  );
  if (qaMatch < 0) return [{ text: cleaned, itemTitle: "Prepared remarks" }];
  const prepared = cleaned.slice(0, qaMatch).trim();
  const qa = cleaned.slice(qaMatch).trim();
  const out: HighlightSection[] = [];
  if (prepared.length >= 60) out.push({ itemCode: "prepared", itemTitle: "Prepared remarks", text: prepared });
  if (qa.length >= 60) out.push({ itemCode: "qa", itemTitle: "Q&A", text: qa });
  return out.length > 0 ? out : [{ text: cleaned }];
}

function buildCandidates(
  text: string,
  opts: TradeHighlightOptions
): Candidate[] {
  const formHint = opts.formHint ?? "generic";
  let sections = opts.sections?.filter((s) => s.text?.trim()) ?? [];
  if (sections.length === 0) {
    if (formHint === "8-K") sections = splitTextBySecItems(text);
    else if (formHint === "earnings") sections = splitEarningsTranscript(text);
    else sections = [{ text }];
  }

  // Accept bare "2.02", "Item 2.02", or full EDGAR strings "Item 2.02 Results of …"
  const material = new Set(
    (opts.materialItems ?? [])
      .map((c) => {
        const m = String(c).match(/(\d+\.\d{2})/);
        return m ? m[1] : String(c).replace(/^Item\s*/i, "").trim();
      })
      .filter(Boolean)
  );

  const candidates: Candidate[] = [];
  let globalIndex = 0;
  for (const section of sections) {
    const paras = splitParagraphs(section.text);
    const pool = paras.length > 0 ? paras : [section.text.replace(/\s+/g, " ").trim()].filter((p) => p.length >= 40);
    const sectionKey =
      (section.itemCode ?? section.itemTitle ?? "body").toString().toUpperCase();
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      let score = keywordScore(p) + numericSignalScore(p);
      score += sectionPrior(formHint, section.itemCode);
      // Within-section position: slightly prefer earlier paras (Lead-N bias)
      score += Math.max(0, 2 - Math.floor(i / 2));
      // Soft prior when caller knows material 8-K items
      if (section.itemCode && material.has(section.itemCode)) score += 3;
      // Downweight pure boilerplate signatures
      if (/\b(forward[- ]looking statements|safe harbor|exhibits?\s+furnished)\b/i.test(p)) {
        score -= 2;
      }
      candidates.push({
        text: p,
        itemCode: section.itemCode,
        itemTitle: section.itemTitle,
        sectionKey,
        index: globalIndex++,
        score
      });
    }
  }
  return candidates;
}

function shingleSet(text: string): Set<string> {
  const tokens = tokenize(text);
  if (tokens.length === 0) return new Set();
  if (tokens.length < 3) return new Set([tokens.join(" ")]);
  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - 3; i++) {
    out.add(tokens.slice(i, i + 3).join(" "));
  }
  return out;
}

/**
 * Split long filing/transcript text into short trade-relevant pseudo-chunks (extractive,
 * no LLM spend). Section-aware when `sections` or formHint splitting is available;
 * diversity via Jaccard shingles; expanded keyword/numeric scoring.
 */
export function tradeHighlightChunksFromText(
  text: string,
  opts: TradeHighlightOptions = {}
): HighlightChunk[] {
  return timeSync(
    "tradeHighlightChunksFromText",
    `${Math.round(text.length / 1024)}KB text`,
    () => tradeHighlightChunksFromTextImpl(text, opts)
  );
}

function tradeHighlightChunksFromTextImpl(
  text: string,
  opts: TradeHighlightOptions = {}
): HighlightChunk[] {
  const maxChunks = opts.maxChunks ?? 8;
  const maxChars = opts.maxCharsPerChunk ?? 1_800;
  const diversity = opts.diversityJaccard ?? 0.55;
  const cleaned = text.replace(/\r/g, "").trim();
  if (!cleaned) return [];

  const candidates = buildCandidates(cleaned, opts);
  if (candidates.length === 0) return [];

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);

  const kept: Candidate[] = [];
  const keptShingles: Set<string>[] = [];

  // Round-robin: ensure diversity across section buckets when we have room
  if (maxChunks >= 4) {
    const bySection = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const list = bySection.get(c.sectionKey) ?? [];
      list.push(c);
      bySection.set(c.sectionKey, list);
    }
    const sectionOrder = [...bySection.entries()]
      .map(([key, list]) => ({ key, best: list[0]?.score ?? 0 }))
      .sort((a, b) => b.best - a.best)
      .map((x) => x.key);

    for (const key of sectionOrder) {
      if (kept.length >= Math.min(maxChunks, sectionOrder.length)) break;
      const pick = bySection.get(key)?.[0];
      if (!pick) continue;
      const sh = shingleSet(pick.text);
      if (
        diversity < 1 &&
        keptShingles.some((k) => jaccardSimilarity(sh, k) >= diversity)
      ) {
        continue;
      }
      kept.push(pick);
      keptShingles.push(sh);
    }
  }

  for (const c of candidates) {
    if (kept.length >= maxChunks) break;
    if (kept.includes(c)) continue;
    const sh = shingleSet(c.text);
    if (
      diversity < 1 &&
      keptShingles.some((k) => jaccardSimilarity(sh, k) >= diversity)
    ) {
      continue;
    }
    kept.push(c);
    keptShingles.push(sh);
  }

  // Preserve score order in final output (not round-robin order)
  kept.sort((a, b) => b.score - a.score || a.index - b.index);

  return kept.slice(0, maxChunks).map((row, idx) => {
    const label =
      row.itemCode || row.itemTitle
        ? `[${row.itemTitle ?? `Item ${row.itemCode}`}] `
        : "";
    const body = row.text.slice(0, maxChars);
    const textOut = (label + body).slice(0, maxChars);
    const knownHash = row.contentHash || knownSourceChunkHash(row, opts.sourceChunks);
    const hashedBody = knownHash ?? (opts.sections && opts.sections.length > 0 ? hashContent(row.text) : null);
    const idCore = (row.itemCode ?? "body").toString().replace(/\s+/g, "");
    return {
      id: hashedBody ?? `hl:${idCore}:${idx}`,
      text: textOut,
      itemCode: row.itemCode,
      itemTitle: row.itemTitle,
      score: row.score
    };
  });
}

function knownSourceChunkHash(
  row: Candidate,
  sourceChunks: TradeHighlightOptions["sourceChunks"]
): string | undefined {
  if (!sourceChunks?.length) return undefined;
  const needle = row.text.trim();
  if (!needle) return undefined;
  const rowCode = String(row.itemCode ?? "").trim().toLowerCase();
  for (const chunk of sourceChunks) {
    const hash = String(chunk.content_hash ?? "").trim();
    if (!hash) continue;
    const body = String(chunk.text ?? "");
    if (body.includes(needle) || needle.includes(body.trim())) return hash;
    const chunkCode = (
      chunk.itemCode ?? parseItemCodeFromSection(chunk.section)
    )
      .trim()
      .toLowerCase();
    if (rowCode && chunkCode && rowCode === chunkCode && body.includes(needle.slice(0, 80))) {
      return hash;
    }
  }
  return undefined;
}

/**
 * Generates a cited summary abstract for a document, saves it to `document_abstracts`,
 * and embeds it into the RAG vector store with `doc_type: "document-summary"` or `"earnings-summary"`.
 *
 * Re-generates when an older `model_used` is present so algorithm upgrades land on existing
 * accessions without requiring a full corpus re-embed job.
 */
/** True when no abstract exists yet, or it was written by an older extractive model. */
export function abstractNeedsUpgrade(
  accessionOrEventId: string,
  sourceType: string
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT model_used FROM document_abstracts WHERE accession_or_event_id = ? AND source_type = ?"
    )
    .get(accessionOrEventId, sourceType) as { model_used: string } | undefined;
  if (!row) return true;
  return row.model_used !== DOCUMENT_HIGHLIGHT_MODEL;
}

export async function generateAndStoreDocumentAbstract(
  input: SummarizeDocumentInput
): Promise<SummarizeDocumentResult> {
  const db = getDb();

  const existing = db
    .prepare(
      "SELECT id, model_used FROM document_abstracts WHERE accession_or_event_id = ? AND source_type = ?"
    )
    .get(input.accessionOrEventId, input.sourceType) as
    | { id: string; model_used: string }
    | undefined;

  const abstractId = `abstract:${input.sourceType}:${input.ticker}:${input.accessionOrEventId}`;
  const chunkIds = input.chunks.map((c) => c.id);

  const summaryText = input.chunks
    .map((c) => c.text.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8)
    .join("\n\n");

  // Validate BEFORE deleting any existing row so a short/failed upgrade cannot
  // wipe a previously good abstract.
  if (!summaryText || summaryText.length < 80) {
    return { abstractId, skipped: true, error: "summary_too_short" };
  }

  let refreshed = false;
  if (existing) {
    const currentEnough =
      !input.force && existing.model_used === DOCUMENT_HIGHLIGHT_MODEL;
    if (currentEnough) {
      return { abstractId: existing.id, skipped: true };
    }
    deleteDocumentAbstractByAccessionAndSource(
      input.accessionOrEventId,
      input.sourceType
    );
    // Drop stale FTS rows and their index keys together. Leaving the index
    // behind lets a later same-hash remirror DELETE a reused FTS5 rowid that
    // now belongs to another filing.
    try {
      deleteDocumentChunkFtsBySourceAccession("document-summarizer", abstractId);
    } catch {
      // FTS table may be absent in very old test DBs
    }
    refreshed = true;
  }

  const abstractRecord: DocumentAbstract = {
    id: abstractId,
    sourceType: input.sourceType,
    ticker: input.ticker.toUpperCase(),
    accessionOrEventId: input.accessionOrEventId,
    headline: input.headline,
    summaryText,
    sourceChunkIds: chunkIds,
    createdAt: new Date().toISOString(),
    modelUsed: DOCUMENT_HIGHLIGHT_MODEL
  };

  insertDocumentAbstract(abstractRecord);

  const docType =
    input.sourceType === "earnings-summary" ? "earnings-summary" : "document-summary";
  const vectorText = `${input.headline}\n\n${summaryText}`;
  try {
    const storeResult = await storeDocument(
      {
        text: vectorText,
        ticker: input.ticker.toUpperCase(),
        title: input.headline,
        doc_id: abstractId,
        doc_type: docType,
        published_at: input.publishedAt || new Date().toISOString(),
        acceptance_datetime: input.acceptanceDatetime || new Date().toISOString(),
        source: "document-summarizer",
        url: `abstract://${input.ticker}/${input.accessionOrEventId}`
      },
      "local"
    );

    // Best-effort FTS mirror so corpus-wide lexical can hit highlights (dense still primary).
    try {
      const chunkInput: ChunkInput = {
        text: vectorText,
        ticker: input.ticker.toUpperCase(),
        title: input.headline,
        doc_id: abstractId,
        doc_type: docType,
        published_at: input.publishedAt || new Date().toISOString(),
        acceptance_datetime: input.acceptanceDatetime || new Date().toISOString(),
        source: "document-summarizer",
        url: `abstract://${input.ticker}/${input.accessionOrEventId}`
      };
      for (const chunk of chunkDocument(chunkInput, {})) {
        insertDocumentChunkFts(
          chunk.content_hash,
          input.ticker.toUpperCase(),
          "document-summarizer",
          abstractId,
          chunk.text
        );
      }
    } catch (ftsErr) {
      console.warn(
        `[document-summarizer] FTS mirror warning for ${abstractId}:`,
        ftsErr instanceof Error ? ftsErr.message : String(ftsErr)
      );
    }

    if (storeResult?.error) {
      console.warn(
        `[document-summarizer] Vector store reported error for ${abstractId}:`,
        storeResult.error
      );
    }
  } catch (err) {
    console.warn(
      `[document-summarizer] Vector store document embedding warning for ${abstractId}:`,
      err
    );
  }

  return { abstractId, skipped: false, refreshed };
}
