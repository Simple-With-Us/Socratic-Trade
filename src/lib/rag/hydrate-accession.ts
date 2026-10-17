// Local-only money-path hydrate (PR B).  No EDGAR, no fetch, fail-open.
// Order: worker chunks.json -> local artifact/sections.json -> eight-k sidecar
// -> FTS on the bare SEC accession (filter then limit) -> earningscalls / ROIC.

import fs from "fs";
import path from "path";
import { z } from "zod";
import { databasePath, getDb } from "../db";
import { readRoicTranscriptArtifact } from "../roic-archive-artifacts";
import {
  eightKReadPaths,
  listSecAccessionDirs,
  padCik10,
  readFirstExistingSync,
  secArtifactReadPaths
} from "./corpus-layout";
import { bareSecAccession, parseItemCodeFromSection } from "./pinecone-write-class";
import { sqliteAllOffLoop } from "./sqlite-all-offloop";
import { decodeTextPayload } from "../text-payload-codec";

export const HYDRATE_WALL_MS = 150;

export type HydrateMissReason =
  | "missing_local_copy"
  | "hydrate_budget"
  | "empty_text"
  | "invalid_accession";

export type HydrateSource = "chunks.json" | "artifact" | "eight-k" | "fts" | "transcript";

export interface HydrateAccessionInput {
  accession: string;
  content_hash?: string;
  itemCode?: string;
  symbol?: string;
  /** Injected clock for tests. */
  nowMs?: () => number;
  wallMs?: number;
}

export interface HydrateAccessionResult {
  text: string;
  missedReason?: HydrateMissReason;
  source?: HydrateSource;
  contentHash?: string;
  itemCode?: string;
}

const TRANSCRIPT_ACC_RE = /^(?:earningscalls|roic):([A-Z0-9.]+):(\d{4})Q([1-4])$/i;
const HEX32_RE = /^[a-f0-9]{32}$/i;

type LocalChunk = {
  text?: string;
  parent_text?: string;
  content_hash?: string;
  section?: string;
  itemCode?: string;
};

function nowFn(input: HydrateAccessionInput): () => number {
  return input.nowMs ?? Date.now;
}

function timedOut(started: number, input: HydrateAccessionInput): boolean {
  return nowFn(input)() - started >= (input.wallMs ?? HYDRATE_WALL_MS);
}

function miss(reason: HydrateMissReason): HydrateAccessionResult {
  return { text: "", missedReason: reason };
}

function hit(text: string, source: HydrateSource, extra?: Partial<HydrateAccessionResult>): HydrateAccessionResult {
  const trimmed = text.trim();
  if (!trimmed) return miss("empty_text");
  return { text: trimmed, source, ...extra };
}

function wantedItemCode(itemCode: string | undefined): string {
  return String(itemCode ?? "")
    .trim()
    .replace(/^item\s+/i, "")
    .replace(/\.$/, "");
}

function chunkItemCode(chunk: LocalChunk): string {
  const fromField = String(chunk.itemCode ?? "").trim();
  if (fromField) return fromField.replace(/^item\s+/i, "");
  return parseItemCodeFromSection(chunk.section);
}

function chunkBody(chunk: LocalChunk): string {
  const parent = String(chunk.parent_text ?? "").trim();
  if (parent) return parent;
  return String(chunk.text ?? "").trim();
}

function pickFromLocalChunks(
  chunks: LocalChunk[],
  input: HydrateAccessionInput
): { text: string; contentHash?: string; itemCode?: string } | null {
  if (chunks.length === 0) return null;
  const hash = String(input.content_hash ?? "").trim();
  if (hash) {
    const byHash = chunks.find((chunk) => String(chunk.content_hash ?? "").trim() === hash);
    if (byHash) {
      const text = chunkBody(byHash);
      if (text) return { text, contentHash: hash, itemCode: chunkItemCode(byHash) };
    }
  }
  const item = wantedItemCode(input.itemCode);
  if (item) {
    const matched = chunks.filter((chunk) => {
      const code = chunkItemCode(chunk);
      return code.toLowerCase() === item.toLowerCase();
    });
    if (matched.length > 0) {
      const text = matched.map(chunkBody).filter(Boolean).join("\n\n");
      if (text) return { text, itemCode: item, contentHash: matched[0]?.content_hash };
    }
  }
  const oneA = chunks.filter((chunk) => chunkItemCode(chunk).toUpperCase() === "1A");
  if (oneA.length > 0) {
    const text = oneA.map(chunkBody).filter(Boolean).join("\n\n");
    if (text) return { text, itemCode: "1A", contentHash: oneA[0]?.content_hash };
  }
  const first = chunks[0];
  const text = chunkBody(first);
  if (text) return { text, contentHash: first.content_hash, itemCode: chunkItemCode(first) };
  return null;
}

function parseChunksJson(raw: string): LocalChunk[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => row && typeof row === "object") as LocalChunk[];
  } catch {
    return [];
  }
}

function parseSectionsJson(raw: string): LocalChunk[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Record<string, unknown>>).map((row) => ({
      itemCode: typeof row.itemCode === "string" ? row.itemCode : undefined,
      section:
        typeof row.itemCode === "string" && typeof row.itemTitle === "string"
          ? `${row.itemCode}. ${row.itemTitle}`
          : typeof row.itemTitle === "string"
            ? row.itemTitle
            : undefined,
      text: typeof row.text === "string" ? row.text : "",
      parent_text: typeof row.text === "string" ? row.text : ""
    }));
  } catch {
    return [];
  }
}

function lookupCik(accession: string, symbol?: string): string | null {
  try {
    const db = getDb();
    const byAcc = db
      .prepare("SELECT cik FROM sec_filings WHERE accession = ? LIMIT 1")
      .get(accession) as { cik?: string } | undefined;
    if (byAcc?.cik) return padCik10(byAcc.cik);
    const ticker = String(symbol ?? "").trim().toUpperCase();
    if (ticker) {
      const byTick = db
        .prepare("SELECT cik FROM sec_filings WHERE ticker = ? LIMIT 1")
        .get(ticker) as { cik?: string } | undefined;
      if (byTick?.cik) return padCik10(byTick.cik);
    }
  } catch {
    // schema may be absent in lightweight tests
  }
  return null;
}

function collectNamedJsonFromAccessionDirs(accession: string, suffix: string, exactName: string): string[] {
  const found: string[] = [];
  for (const dir of listSecAccessionDirs(accession)) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(suffix) || name === exactName) {
          found.push(path.join(dir, name));
        }
      }
    } catch {
      // skip
    }
  }
  return found;
}

function loadChunksJson(accession: string, cik: string | null): string | null {
  const candidates: string[] = [];
  if (cik) {
    // Known CIK: only the deterministic corpus/legacy paths.  Do not walk every CIK dir.
    candidates.push(...secArtifactReadPaths(cik, accession, 1, "chunks.json"));
  } else {
    candidates.push(...collectNamedJsonFromAccessionDirs(accession, "-chunks.json", "chunks.json"));
  }
  return readFirstExistingSync(candidates);
}

function loadSectionsJson(accession: string, cik: string | null): string | null {
  const candidates: string[] = [];
  if (cik) {
    candidates.push(...secArtifactReadPaths(cik, accession, 1, "sections.json"));
  } else {
    candidates.push(...collectNamedJsonFromAccessionDirs(accession, "-sections.json", "sections.json"));
  }
  return readFirstExistingSync(candidates);
}

function loadEightKSidecar(accession: string): string | null {
  return readFirstExistingSync(eightKReadPaths(accession, "main.txt"));
}

// ST-4542: the two statements below are unindexed scans (a GLOB over an FTS5 table and a LIKE
// over earningscalls_transcripts.source_meta).  Run on the serving connection they were 39-51 s
// native stalls in the 2026-10-15 profiles (hydrate-accession.ts, release 49a76da).  They are
// read-only, so they go to the readonly worker pool, same SQL and same row handling.
const FtsHydrateRowSchema = z.object({ content_hash: z.string().nullable(), text: z.string().nullable() });
const TranscriptContentRowSchema = z.object({ content: z.string().nullable() });

async function hydrateFromFts(
  accession: string,
  input: HydrateAccessionInput
): Promise<HydrateAccessionResult | null> {
  try {
    const hash = String(input.content_hash ?? "").trim();
    const item = wantedItemCode(input.itemCode);
    const params: string[] = [accession, accession, accession];
    let sql = `
      SELECT content_hash, text FROM document_chunks_fts
      WHERE (accession = ?
         OR accession GLOB ('*:' || ? || ':*')
         OR accession GLOB (? || ':*'))
    `;
    if (hash && HEX32_RE.test(hash)) {
      sql += " AND content_hash = ?";
      params.push(hash);
    }
    if (item) {
      // Filter item in SQL before LIMIT so a flood of other items cannot displace the hit.
      sql += " AND (text LIKE ? OR text LIKE ? OR text LIKE ?)";
      params.push(`%item ${item}%`);
      params.push(`%item${item}%`);
      params.push(`[${item}%`);
    }
    if (hash && HEX32_RE.test(hash) && !item) {
      sql += " ORDER BY content_hash";
    }
    sql += " LIMIT 8";
    const rows = (await sqliteAllOffLoop(sql, params, databasePath(), FtsHydrateRowSchema)).map((row) => ({
      content_hash: row.content_hash ?? undefined,
      text: row.text ?? undefined
    }));
    const texts = rows.map((row) => String(row.text ?? "").trim()).filter(Boolean);
    if (texts.length === 0) return null;
    return hit(texts.join("\n\n"), "fts", {
      contentHash: hash || rows[0]?.content_hash,
      itemCode: item || input.itemCode
    });
  } catch {
    return null;
  }
}

/** Plaintext transcript body. Stored bytes may be gz1:/raw1:. Length is checked
 *  after decode so a compressed long transcript is not dropped by length(content). */
function decodeTranscriptBody(stored: string): string | null {
  try {
    const text = decodeTextPayload(stored).trim();
    return text.length > 80 ? text : null;
  } catch {
    return null;
  }
}

async function hydrateTranscript(accession: string, input: HydrateAccessionInput): Promise<HydrateAccessionResult | null> {
  const match = TRANSCRIPT_ACC_RE.exec(accession);
  const symbolFromAcc = match?.[1]?.toUpperCase();
  const year = match ? Number(match[2]) : NaN;
  const quarter = match ? Number(match[3]) : NaN;
  const symbol = String(input.symbol ?? symbolFromAcc ?? "").trim().toUpperCase();

  try {
    const db = getDb();
    if (symbol && Number.isFinite(year) && Number.isFinite(quarter)) {
      const row = db
        .prepare(
          `SELECT content FROM earningscalls_transcripts
           WHERE symbol = ? AND fiscal_year = ? AND fiscal_quarter = ?
             AND content IS NOT NULL
           LIMIT 1`
        )
        .get(symbol, year, quarter) as { content?: string } | undefined;
      const decoded = row?.content ? decodeTranscriptBody(row.content) : null;
      if (decoded) return hit(decoded, "transcript");
    }
    const like = `%${accession}%`;
    const byMetaRows = await sqliteAllOffLoop(
      `SELECT content FROM earningscalls_transcripts
         WHERE content IS NOT NULL
           AND (source_meta LIKE ? OR lower(symbol) = lower(?))
         ORDER BY fiscal_year DESC, fiscal_quarter DESC
         LIMIT 1`,
      [like, symbol || accession],
      databasePath(),
      TranscriptContentRowSchema
    );
    const byMeta = byMetaRows[0] ? { content: byMetaRows[0].content ?? undefined } : undefined;
    const decodedMeta = byMeta?.content ? decodeTranscriptBody(byMeta.content) : null;
    if (decodedMeta) return hit(decodedMeta, "transcript");
  } catch {
    // table may be absent
  }

  if (symbol && Number.isFinite(year) && Number.isFinite(quarter)) {
    const artifact = readRoicTranscriptArtifact(symbol, year, quarter);
    if (artifact?.content) return hit(artifact.content, "transcript");
  }
  return null;
}

export function normalizeHydrateAccession(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  if (TRANSCRIPT_ACC_RE.test(trimmed)) return trimmed;
  return bareSecAccession(trimmed) ?? trimmed;
}

export async function hydrateAccession(input: HydrateAccessionInput): Promise<HydrateAccessionResult> {
  const started = nowFn(input)();
  try {
    const accession = normalizeHydrateAccession(input.accession);
    if (!accession) return miss("invalid_accession");

    if (TRANSCRIPT_ACC_RE.test(accession)) {
      const transcript = await hydrateTranscript(accession, input);
      if (transcript) return transcript;
      if (timedOut(started, input)) return miss("hydrate_budget");
      return miss("missing_local_copy");
    }

    if (timedOut(started, input)) return miss("hydrate_budget");
    const cik = lookupCik(accession, input.symbol);

    if (timedOut(started, input)) return miss("hydrate_budget");
    const chunksRaw = loadChunksJson(accession, cik);
    if (chunksRaw) {
      const picked = pickFromLocalChunks(parseChunksJson(chunksRaw), input);
      if (picked?.text) return hit(picked.text, "chunks.json", picked);
    }

    if (timedOut(started, input)) return miss("hydrate_budget");
    const sectionsRaw = loadSectionsJson(accession, cik);
    if (sectionsRaw) {
      const picked = pickFromLocalChunks(parseSectionsJson(sectionsRaw), input);
      if (picked?.text) return hit(picked.text, "artifact", picked);
    }

    if (timedOut(started, input)) return miss("hydrate_budget");
    const eightKRaw = loadEightKSidecar(accession);
    if (eightKRaw) {
      const eightKHit = hit(eightKRaw, "eight-k");
      if (!eightKHit.missedReason) return eightKHit;
    }

    if (timedOut(started, input)) return miss("hydrate_budget");
    const fts = await hydrateFromFts(accession, input);
    if (fts) return fts;

    if (timedOut(started, input)) return miss("hydrate_budget");
    const transcript = await hydrateTranscript(accession, input);
    if (transcript) return transcript;

    return miss("missing_local_copy");
  } catch {
    return miss("missing_local_copy");
  }
}
