// Pinecone write-class + form-aware signal matcher (corpus-storage PR A).
//
// `RAG_PINECONE_WRITE_CLASS` defaults to `full-body` and stays there until PR B
// (money-path hydrate) is on main.  Do not flip the env in this change.
// Producers honor `highlight+signal` when set; the operational path also writes
// extractive highlights + signal sections as their own complete storeDocuments
// while the default remains full-body.

export type PineconeWriteClass = "full-body" | "highlight+signal" | "highlight-only";

/** Match against parsed itemCode, not raw `chunk.section === "7"`. */
export const PINECONE_SIGNAL_ITEM_CODES: Readonly<Record<string, readonly string[]>> = {
  "10-k": ["1A", "7", "7A"],
  "10-q": ["2", "1A", "3"],
  "8-k": ["2.02", "5.02", "1.01", "8.01"],
  "earnings-transcript": ["management"]
};

export const PROCESSED_DOC_TYPES = new Set([
  "document-summary",
  "earnings-summary",
  "8k-brief"
]);

/** Experience / coaching / lessons — never summarize, never prune. */
export const DO_NOT_TOUCH_DOC_TYPES = new Set([
  "socratic-decision",
  "coach-note",
  "lesson",
  "experience-memory",
  "user-memory",
  "fundamentals"
]);

export const SIGNAL_MAX_CHUNKS = 12;
export const SIGNAL_MAX_SOURCE_CHARS = 20_000;
export const TRANSCRIPT_QA_SIGNAL_TURNS = 8;

const SEC_ACCESSION_RE = /\d{10}-\d{2}-\d{6}/;

export function pineconeWriteClass(
  env: Record<string, string | undefined> = process.env
): PineconeWriteClass {
  const raw = String(env.RAG_PINECONE_WRITE_CLASS ?? "").trim().toLowerCase();
  if (raw === "highlight+signal" || raw === "highlight-signal") return "highlight+signal";
  if (raw === "highlight-only") return "highlight-only";
  return "full-body";
}

export function writesFullBodyToPinecone(
  env: Record<string, string | undefined> = process.env
): boolean {
  return pineconeWriteClass(env) === "full-body";
}

export function writesProcessedToPinecone(
  env: Record<string, string | undefined> = process.env
): boolean {
  const writeClass = pineconeWriteClass(env);
  return writeClass === "highlight+signal" || writeClass === "highlight-only" || writeClass === "full-body";
}

export function normalizeFormHint(formHint: string | undefined): string {
  const raw = String(formHint ?? "").trim().toLowerCase();
  if (raw === "10k" || raw === "10-k" || raw === "10k-delta") return "10-k";
  if (raw === "10q" || raw === "10-q" || raw === "10q-delta") return "10-q";
  if (raw === "8k" || raw === "8-k" || raw === "8-k-body") return "8-k";
  if (raw.includes("transcript") || raw === "earnings" || raw === "earnings-summary") {
    return "earnings-transcript";
  }
  return raw;
}

/** `chunkDocument` sets `section = \`${itemCode}. ${itemTitle}\``.  Do not `=== "7"`. */
export function parseItemCodeFromSection(section: string | undefined): string {
  if (!section) return "";
  const trimmed = section.trim();
  if (!trimmed) return "";
  const withoutItem = trimmed.replace(/^item\s+/i, "");
  const dot = withoutItem.indexOf(". ");
  const code = (dot >= 0 ? withoutItem.slice(0, dot) : withoutItem).trim();
  return code.replace(/^item\s+/i, "").trim();
}

export function itemCodeOfChunk(chunk: {
  itemCode?: string;
  section?: string;
}): string {
  const fromField = String(chunk.itemCode ?? "").trim();
  if (fromField) return fromField;
  return parseItemCodeFromSection(chunk.section);
}

export function bareSecAccession(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(SEC_ACCESSION_RE);
  return match ? match[0] : null;
}

export function sectionDocumentKey(args: {
  ticker: string;
  accession: string;
  form: string;
  itemCode: string;
}): string {
  const bare = bareSecAccession(args.accession) ?? args.accession;
  const form = String(args.form || "10-K").replace(/:/g, "");
  const item = String(args.itemCode || "body").replace(/[\s:]+/g, "");
  return `${args.ticker.toUpperCase()}:${bare}:${form}:section:${item}`;
}

export function isDoNotTouchDocType(docType: string | undefined): boolean {
  return DO_NOT_TOUCH_DOC_TYPES.has(String(docType ?? "").trim().toLowerCase());
}

export function isProcessedDocType(docType: string | undefined): boolean {
  return PROCESSED_DOC_TYPES.has(String(docType ?? "").trim().toLowerCase());
}

export function isTranscriptRoleCode(code: string): boolean {
  const folded = code.trim().toLowerCase();
  return folded === "management" || folded === "analyst" || folded === "operator" || folded === "qa" || folded === "transcript";
}

function codesMatch(parsed: string, wanted: readonly string[], prefix: boolean): boolean {
  const a = parsed.trim().toLowerCase();
  if (!a) return false;
  for (const raw of wanted) {
    const b = raw.trim().toLowerCase();
    if (!b) continue;
    if (prefix) {
      if (a === b || a.startsWith(`${b}.`) || a.startsWith(`${b} `)) return true;
    } else if (a === b) {
      return true;
    }
  }
  return false;
}

export interface SignalChunkLike {
  itemCode?: string;
  section?: string;
  text?: string;
  is_table?: boolean;
}

/**
 * Keep the high-signal slice Green/Red can actually consume (8/1 + 24k).
 * Item 8 tables stay local (FTS / hydrate).  Transcripts use ROIC roles, not "prepared".
 */
export function selectSignalChunks<T extends SignalChunkLike>(
  chunks: readonly T[],
  formHint: string,
  opts?: { maxChunks?: number; maxSourceChars?: number; qaTurns?: number }
): T[] {
  const form = normalizeFormHint(formHint);
  const maxChunks = opts?.maxChunks ?? SIGNAL_MAX_CHUNKS;
  const maxChars = opts?.maxSourceChars ?? SIGNAL_MAX_SOURCE_CHARS;
  const qaCap = opts?.qaTurns ?? TRANSCRIPT_QA_SIGNAL_TURNS;
  const wanted = PINECONE_SIGNAL_ITEM_CODES[form] ?? [];
  const prefix = form === "8-k";

  if (form === "earnings-transcript") {
    const management: T[] = [];
    const qa: T[] = [];
    for (const chunk of chunks) {
      const code = itemCodeOfChunk(chunk).toLowerCase();
      if (code === "management") management.push(chunk);
      else if (code === "qa" || code === "analyst") qa.push(chunk);
    }
    return capSignalChunks([...management, ...qa.slice(0, qaCap)], maxChunks, maxChars);
  }

  const kept: T[] = [];
  for (const chunk of chunks) {
    const code = itemCodeOfChunk(chunk);
    if (form === "10-k" && code.trim().toLowerCase() === "8") continue;
    if (!codesMatch(code, wanted, prefix)) continue;
    kept.push(chunk);
  }
  return capSignalChunks(kept, maxChunks, maxChars);
}

function capSignalChunks<T extends SignalChunkLike>(
  chunks: readonly T[],
  maxChunks: number,
  maxChars: number
): T[] {
  const out: T[] = [];
  let chars = 0;
  for (const chunk of chunks) {
    if (out.length >= maxChunks) break;
    const text = String(chunk.text ?? "");
    if (chars + text.length > maxChars && out.length > 0) break;
    out.push(chunk);
    chars += text.length;
  }
  return out;
}

export function filingTextFromParsedSections(
  sections: ReadonlyArray<{ text?: string }> | undefined,
  fallback: string
): string {
  const joined = (sections ?? [])
    .map((section) => String(section.text ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  return joined.length >= 100 ? joined : fallback;
}

export function groupChunksByItemCode<T extends SignalChunkLike>(
  chunks: readonly T[]
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const chunk of chunks) {
    const code = itemCodeOfChunk(chunk) || "body";
    const list = groups.get(code) ?? [];
    list.push(chunk);
    groups.set(code, list);
  }
  return groups;
}
