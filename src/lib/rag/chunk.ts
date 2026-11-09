// Structure-aware document chunking for RAG ingestion. Ported from the Atlas BFF
// (reference/atlas-public-src/bff/rag/chunk.mjs) into TypeScript with no external deps:
// headings set section metadata, tables are kept atomic, long prose is split with overlap, and
// each chunk carries a deterministic context header plus a point-in-time `acceptance_datetime`.

import { createHash, randomUUID } from "crypto";
import { timeSync } from "../slow-sync-guard";

export const DEFAULT_MAX_TOKENS = 480;
const DEFAULT_OVERLAP_RATIO = 0.12;

/**
 * Rough chars-per-token ceiling used to size a downstream char cap from a token budget. English
 * prose averages ~5–6 chars/token; markdown tables (pipe-delimited, kept atomic by chunkDocument)
 * run longer per token because of `|`/whitespace padding. 8 is a deliberately generous upper bound
 * so a legitimately atomic, already-token-bounded chunk is never truncated downstream — it only
 * needs to cover the worst case, not be a tight estimate.
 */
export const CHARS_PER_TOKEN_CEILING = 8;

/**
 * Hash chunk text with SHA-256 for dedup (cheaper than re-embedding via Voyage).
 *
 * Widened to 128 bits (first 32 hex chars) as of 2026-07-04 (composite review "content-hash dedup
 * default-on + widen to 128 bits"): the prior 64-bit (16 hex char) truncation made a content_hash
 * collision between two genuinely-distinct chunks a real (if small) risk, and `document_chunks` is
 * keyed on `content_hash` ALONE — a collision would silently drop a distinct chunk from ever being
 * embedded. `document_chunks.content_hash` is a plain TEXT primary key (no fixed-length schema
 * change needed); `INSERT OR IGNORE` tolerates the one-time re-embed of any pre-existing 16-char
 * hash rows once this widens (they simply won't match a newly-computed 32-char hash, so that one
 * chunk re-embeds once — cheap and harmless, never a correctness issue).
 */
export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

export interface ChunkInput {
  text: string;
  doc_id?: string;
  title?: string;
  ticker?: string | string[];
  /**
   * Required, not optional: chunkDocument throws synchronously ("doc.published_at is required
   * for provenance") when this is missing, so leaving it optional on the type let a caller
   * compile clean and then crash at runtime. Every production call site (sec-filings.ts,
   * sec-ingest-worker.ts, sec8k.ts, fmp-transcripts.ts, earningscalls-transcripts.ts,
   * corpus-reembed.ts) already always supplies it — the runtime guard was defensive, not load
   * -bearing for real callers. Making the field required moves that guarantee to compile time.
   */
  published_at: string | number | Date;
  acceptance_datetime?: string | number | Date;
  doc_type?: string;
  source?: string;
  url?: string;
  sections?: Array<{ itemCode: string; itemTitle: string; text: string }>;
}

export interface DocumentChunk {
  doc_id: string;
  chunk_id: string;
  title: string;
  text: string;
  parent_text: string;
  /** SHA-256 hex (first 16 chars) of chunk text for re-embed dedup. */
  content_hash: string;
  context_header: string;
  ticker: string[];
  doc_type: string;
  section: string;
  published_at: string;
  acceptance_datetime: string;
  source: string;
  url: string;
  is_table: boolean;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlapRatio?: number;
}

type Block = { type: "heading" | "paragraph" | "table"; text: string };

/** Uppercase and strip to a bare ticker symbol (`A-Z` and `.`). */
export function canonicalTicker(value: string): string {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z.]/g, "");
}

function normalizeTickerList(ticker: string | string[] | undefined): string[] {
  const raw = Array.isArray(ticker) ? ticker : String(ticker ?? "").split(",");
  return raw.map((t) => canonicalTicker(t)).filter(Boolean);
}

function normalizeDate(value: string | number | Date | undefined): string {
  if (!value) throw new Error("A deterministic date value is required for provenance.");
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date value: ${value}`);
  return d.toISOString();
}

/** Token count helper using calibrated character-level ratio. */
export function countTokens(text: string, isTable: boolean = false): number {
  const ratio = isTable ? 3.5 : 4.5;
  return Math.ceil(text.length / ratio);
}

function tailOverlap(text: string, count: number): string {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  let i = words.length - 1;
  while (i >= 0) {
    const proposed = words.slice(i).join(" ");
    if (countTokens(proposed, false) >= count) return proposed;
    i--;
  }
  return text;
}

function makeHeader(meta: {
  ticker: string[];
  doc_type: string;
  section: string;
  source: string;
  acceptance_datetime: string;
  title: string;
}): string {
  const tStr = meta.ticker.length > 0 ? meta.ticker.join(",") : "N/A";
  const dateStr = String(meta.acceptance_datetime).split("T")[0] || "N/A";
  return `[Filing: ${meta.title} | Symbol: ${tStr} | Section: ${meta.section} | Date: ${dateStr} | Source: ${meta.source}]`;
}

function* splitLongProse(text: string, maxTokens: number, overlapTokens: number): Generator<string> {
  const sentences = text.split(/(?<=[.?!])\s+/);
  let current: string[] = [];
  
  for (const s of sentences) {
    const clean = s.trim();
    if (!clean) continue;

    const currentText = current.join(" ");
    const currentTokens = countTokens(currentText, false);
    const sTokens = countTokens(clean, false);

    if (currentTokens + sTokens <= maxTokens) {
      current.push(clean);
    } else {
      if (current.length > 0) {
        yield current.join(" ");
      }
      if (sTokens > maxTokens) {
        // Hard-split extremely long sentences by word counts
        const words = clean.split(/\s+/);
        let wordChunk: string[] = [];
        for (const w of words) {
          wordChunk.push(w);
          if (countTokens(wordChunk.join(" "), false) >= maxTokens) {
            yield wordChunk.join(" ");
            // Carry overlap of words
            const overlapCount = Math.min(wordChunk.length - 1, Math.max(0, Math.floor(overlapTokens)));
            wordChunk = overlapCount > 0 ? wordChunk.slice(-overlapCount) : [];
          }
        }
        if (wordChunk.length > 0) {
          current = [wordChunk.join(" ")];
        } else {
          current = [];
        }
      } else {
        // Start next chunk carrying overlap
        if (current.length > 0) {
          const tail = tailOverlap(current.join(" "), overlapTokens);
          if (tail && countTokens(tail + " " + clean, false) <= maxTokens) {
            current = [tail, clean];
          } else {
            if (tail) {
              yield tail;
            }
            current = [clean];
          }
        } else {
          current = [clean];
        }
      }
    }
  }

  if (current.length > 0) {
    yield current.join(" ");
  }
}

function blockDocument(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let tablePending: string[] = [];
  let prosePending: string[] = [];

  const flushProse = () => {
    const p = prosePending.join("\n").trim();
    if (p) blocks.push({ type: "paragraph", text: p });
    prosePending = [];
  };

  const flushTable = () => {
    const t = tablePending.join("\n").trim();
    if (t) blocks.push({ type: "table", text: t });
    tablePending = [];
  };

  for (const line of lines) {
    const clean = line.trim();
    if (!clean) {
      flushProse();
      flushTable();
      continue;
    }

    const isTableHeader = clean.startsWith("|") && clean.endsWith("|");
    if (isTableHeader) {
      flushProse();
      tablePending.push(line);
      continue;
    }

    if (tablePending.length > 0) {
      if (clean.startsWith("|") || clean.includes("|")) {
        tablePending.push(line);
        continue;
      } else {
        flushTable();
      }
    }

    let isHeading = false;
    let headingText = clean;

    const mdHeaderMatch = clean.match(/^#{1,6}\s+(.+)$/);
    if (mdHeaderMatch) {
      isHeading = true;
      headingText = mdHeaderMatch[1].trim();
    } else if (clean.length < 120 && (
      /^(?:Item|Part|Note|Section)\s+\d+/i.test(clean) ||
      /^[A-Z\s,.:()-]+$/.test(clean)
    )) {
      isHeading = true;
    }

    if (isHeading) {
      flushProse();
      blocks.push({ type: "heading", text: headingText });
    } else {
      prosePending.push(line);
    }
  }

  flushProse();
  flushTable();
  return blocks;
}

/**
 * Split a document into structure-aware chunks. Headings update the running `section`; tables are
 * emitted atomically; oversize prose is windowed with overlap. Each chunk carries a deterministic
 * `context_header` and `acceptance_datetime` for citation + point-in-time retrieval.
 */
export function chunkDocument(doc: ChunkInput, options: ChunkOptions = {}): DocumentChunk[] {
  if (!doc?.text || typeof doc.text !== "string") throw new Error("doc.text required");
  return timeSync(
    "chunkDocument",
    `${doc.doc_id || "no-id"} ${Math.round(doc.text.length / 1024)}KB`,
    () => chunkDocumentImpl(doc, options)
  );
}

function chunkDocumentImpl(doc: ChunkInput, options: ChunkOptions = {}): DocumentChunk[] {
  // Enforce bounds to prevent mutable payload-unbound eligibility
  const maxTokens = Math.min(options.maxTokens ?? DEFAULT_MAX_TOKENS, 2048);
  const childMaxTokens = Math.max(80, Math.floor(maxTokens / 3)); // target child size: ~120-130 tokens
  const overlapRatio = Math.max(0, Math.min(options.overlapRatio ?? DEFAULT_OVERLAP_RATIO, 0.5));

  const doc_id = doc.doc_id || randomUUID();
  const title = doc.title || doc_id;
  const ticker = normalizeTickerList(doc.ticker);
  
  if (!doc.published_at) throw new Error("doc.published_at is required for provenance");
  const published_at = normalizeDate(doc.published_at);
  const acceptance_datetime = normalizeDate(doc.acceptance_datetime ?? doc.published_at);
  
  const doc_type = doc.doc_type || "note";
  const source = doc.source || "sec-edgar";
  const url = doc.url || "";

  const parentBlocks: Array<{ text: string; section: string; isTable: boolean }> = [];
  let section = title;
  let pending: string[] = [];

  const pushParentBlock = (text: string, isTable: boolean = false) => {
    const clean = String(text).trim();
    if (!clean) return;
    parentBlocks.push({ text: clean, section, isTable });
  };

  const flushParent = (carryOverlap = true) => {
    const text = pending.join("\n\n").trim();
    if (!text) {
      pending = [];
      return;
    }
    pushParentBlock(text, false);
    const parentOverlapTokens = Math.max(0, Math.floor(maxTokens * overlapRatio));
    pending = carryOverlap && parentOverlapTokens ? [tailOverlap(text, parentOverlapTokens)] : [];
  };

  if (doc.sections && doc.sections.length > 0) {
    for (const sec of doc.sections) {
      section = `${sec.itemCode}. ${sec.itemTitle}`;
      pending = [];

      const parts = sec.text.split("\n\n");
      for (const part of parts) {
        const cleanPart = part.trim();
        if (!cleanPart) continue;

        const isTable = cleanPart.startsWith("|") && cleanPart.endsWith("|");
        if (isTable) {
          flushParent(false);
          pushParentBlock(cleanPart, true);
          pending = [];
          continue;
        }

        const partTokens = countTokens(cleanPart, false);
        if (partTokens > maxTokens) {
          flushParent(true);
          const parentOverlapTokens = Math.max(0, Math.floor(maxTokens * overlapRatio));
          for (const segment of splitLongProse(cleanPart, maxTokens, parentOverlapTokens)) {
            pushParentBlock(segment, false);
          }
          pending = [];
          continue;
        }

        const proposed = [...pending, cleanPart].join("\n\n");
        if (pending.length && countTokens(proposed, false) > maxTokens) {
          flushParent(true);
          // Re-check the carried overlap tail: a nearly-full part after a flush would otherwise
          // become overlap + part and exceed the parent token cap. Drop the overlap rather than
          // emitting an oversize parent block.
          if (pending.length && countTokens([...pending, cleanPart].join("\n\n"), false) > maxTokens) {
            pending = [];
          }
        }
        pending.push(cleanPart);
      }
      flushParent(false); // Do not carry overlap across sections
    }
  } else {
    for (const block of blockDocument(doc.text)) {
      if (block.type === "heading") {
        flushParent(false);
        section = block.text;
        continue;
      }
      if (block.type === "table") {
        flushParent(false);
        pushParentBlock(block.text, true);
        pending = [];
        continue;
      }
      if (countTokens(block.text, false) > maxTokens) {
        flushParent(true);
        const parentOverlapTokens = Math.max(0, Math.floor(maxTokens * overlapRatio));
        for (const segment of splitLongProse(block.text, maxTokens, parentOverlapTokens)) {
          pushParentBlock(segment, false);
        }
        pending = [];
        continue;
      }

      const proposed = [...pending, block.text].join("\n\n");
      if (pending.length && countTokens(proposed, false) > maxTokens) {
        flushParent(true);
        // Same overlap re-check as the section-aware path above.
        if (pending.length && countTokens([...pending, block.text].join("\n\n"), false) > maxTokens) {
          pending = [];
        }
      }
      pending.push(block.text);
    }
    flushParent(false);
  }

  const chunks: DocumentChunk[] = [];
  for (const parent of parentBlocks) {
    if (parent.isTable || countTokens(parent.text, false) <= childMaxTokens) {
      const n = chunks.length + 1;
      section = parent.section;
      const context_header = makeHeader({ ticker, doc_type, section, source, acceptance_datetime, title });
      chunks.push({
        doc_id,
        chunk_id: `${doc_id}#c${String(n).padStart(3, "0")}`,
        title,
        text: parent.text,
        parent_text: parent.text,
        content_hash: hashContent(parent.text),
        context_header,
        ticker,
        doc_type,
        section,
        published_at,
        acceptance_datetime,
        source,
        url,
        is_table: parent.isTable
      });
    } else {
      const childOverlapTokens = Math.max(0, Math.floor(childMaxTokens * overlapRatio));
      const childSegments = splitLongProse(parent.text, childMaxTokens, childOverlapTokens);
      for (const segment of childSegments) {
        const n = chunks.length + 1;
        section = parent.section;
        const context_header = makeHeader({ ticker, doc_type, section, source, acceptance_datetime, title });
        chunks.push({
          doc_id,
          chunk_id: `${doc_id}#c${String(n).padStart(3, "0")}`,
          title,
          text: segment,
          parent_text: parent.text,
          content_hash: hashContent(segment),
          context_header,
          ticker,
          doc_type,
          section,
          published_at,
          acceptance_datetime,
          source,
          url,
          is_table: false
        });
      }
    }
  }

  return chunks;
}
