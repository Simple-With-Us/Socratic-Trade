// Filesystem sidecar for the ROIC Individual archive.
//
// `earningscalls_transcripts` is the fetch-once-forever SQLite cache.  These files
// survive a DB restore mismatch the same way `data/sec-artifacts` does for EDGAR:
// a later walk hydrates SQLite from disk and never re-hits ROIC for that call.
//
// Layout: writes go to CORPUS_DIR/roic (default DATA_DIR/corpus/roic) so the
// corpus tree can bind-mount later.  Reads try that path first, then the
// legacy DATA_DIR/roic-artifacts tree so production files are not stranded.

import fs from "fs";
import path from "path";
import { normalizeSymbol } from "./money";
import { yieldEventLoop } from "./slow-sync-guard";
import {
  firstExistingPath,
  roicArtifactLegacyRoot,
  roicArtifactWriteRoot
} from "./rag/corpus-layout";

export const ROIC_ARTIFACT_DIRNAME = "roic-artifacts";
const TRANSCRIPT_FILE_RE = /^(\d{4})Q([1-4])\.json$/;

export interface RoicArtifactPeriod {
  year: number;
  quarter: number;
  date?: string;
}

export interface RoicTranscriptArtifact {
  symbol: string;
  year: number;
  quarter: number;
  date?: string;
  content: string;
  fetchedAt: string;
  accession: string;
  identifier?: string;
  provider: "roic";
}

export interface RoicCallIndexArtifact {
  symbol: string;
  identifier?: string;
  fetchedAt: string;
  calls: Array<RoicArtifactPeriod & { id?: string }>;
}

function dataRoot(): string {
  return process.env.DATA_DIR ?? "data";
}

/** Write root: CORPUS_DIR/roic or DATA_DIR/corpus/roic. */
export function roicArtifactRoot(root: string = dataRoot()): string {
  return roicArtifactWriteRoot(root);
}

export function roicSymbolArtifactDir(symbol: string, root: string = dataRoot()): string {
  return path.join(roicArtifactRoot(root), normalizeSymbol(symbol));
}

function roicSymbolLegacyDir(symbol: string, root: string = dataRoot()): string {
  return path.join(roicArtifactLegacyRoot(root), normalizeSymbol(symbol));
}

export function roicTranscriptArtifactPath(
  symbol: string,
  year: number,
  quarter: number,
  root: string = dataRoot()
): string {
  return path.join(roicSymbolArtifactDir(symbol, root), `${year}Q${quarter}.json`);
}

function roicTranscriptArtifactReadPaths(
  symbol: string,
  year: number,
  quarter: number,
  root: string = dataRoot()
): string[] {
  const name = `${year}Q${quarter}.json`;
  return [
    path.join(roicSymbolArtifactDir(symbol, root), name),
    path.join(roicSymbolLegacyDir(symbol, root), name)
  ];
}

export function roicCallIndexArtifactPath(symbol: string, root: string = dataRoot()): string {
  return path.join(roicSymbolArtifactDir(symbol, root), "index.json");
}

function roicCallIndexReadPaths(symbol: string, root: string = dataRoot()): string[] {
  return [
    roicCallIndexArtifactPath(symbol, root),
    path.join(roicSymbolLegacyDir(symbol, root), "index.json")
  ];
}

function readJsonFile(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (err) {
    console.warn(
      `[roic-artifacts] read failed for ${filePath}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return true;
  } catch (err) {
    console.warn(
      `[roic-artifacts] write failed for ${filePath}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

export function writeRoicTranscriptArtifact(artifact: RoicTranscriptArtifact): boolean {
  if (!artifact.content || artifact.content.length < 200) return false;
  const symbol = normalizeSymbol(artifact.symbol);
  if (!symbol) return false;
  return writeJsonFile(roicTranscriptArtifactPath(symbol, artifact.year, artifact.quarter), {
    ...artifact,
    symbol,
    provider: "roic"
  } satisfies RoicTranscriptArtifact);
}

export function readRoicTranscriptArtifact(
  symbol: string,
  year: number,
  quarter: number
): RoicTranscriptArtifact | null {
  const hit = firstExistingPath(roicTranscriptArtifactReadPaths(symbol, year, quarter));
  const raw = hit ? readJsonFile(hit) : null;
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const content = typeof row.content === "string" ? row.content : "";
  if (content.length < 200) return null;
  const parsedYear = typeof row.year === "number" ? row.year : year;
  const parsedQuarter = typeof row.quarter === "number" ? row.quarter : quarter;
  const normalized = normalizeSymbol(typeof row.symbol === "string" ? row.symbol : symbol);
  if (!normalized) return null;
  return {
    symbol: normalized,
    year: parsedYear,
    quarter: parsedQuarter,
    date: typeof row.date === "string" ? row.date : undefined,
    content,
    fetchedAt: typeof row.fetchedAt === "string" ? row.fetchedAt : new Date().toISOString(),
    accession: typeof row.accession === "string" ? row.accession : `roic:${normalized}:${parsedYear}Q${parsedQuarter}`,
    identifier: typeof row.identifier === "string" ? row.identifier : undefined,
    provider: "roic"
  };
}

export function listRoicTranscriptArtifacts(symbol: string): RoicArtifactPeriod[] {
  const dirs = [roicSymbolArtifactDir(symbol), roicSymbolLegacyDir(symbol)];
  const seen = new Set<string>();
  const out: RoicArtifactPeriod[] = [];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const match = TRANSCRIPT_FILE_RE.exec(name);
        if (!match) continue;
        const year = Number(match[1]);
        const quarter = Number(match[2]);
        const key = `${year}Q${quarter}`;
        if (seen.has(key)) continue;
        const artifact = readRoicTranscriptArtifact(symbol, year, quarter);
        if (!artifact) continue;
        seen.add(key);
        out.push({ year: artifact.year, quarter: artifact.quarter, date: artifact.date });
      }
    } catch {
      // skip unreadable symbol dir
    }
  }
  return out;
}

export function writeRoicCallIndexArtifact(artifact: RoicCallIndexArtifact): boolean {
  if (!artifact.calls.length) return false;
  const symbol = normalizeSymbol(artifact.symbol);
  if (!symbol) return false;
  return writeJsonFile(roicCallIndexArtifactPath(symbol), {
    ...artifact,
    symbol
  } satisfies RoicCallIndexArtifact);
}

export function readRoicCallIndexArtifact(symbol: string): RoicCallIndexArtifact | null {
  const hit = firstExistingPath(roicCallIndexReadPaths(symbol));
  const raw = hit ? readJsonFile(hit) : null;
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (!Array.isArray(row.calls)) return null;
  const calls: RoicCallIndexArtifact["calls"] = [];
  for (const item of row.calls) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const year = typeof rec.year === "number" ? rec.year : NaN;
    const quarter = typeof rec.quarter === "number" ? rec.quarter : NaN;
    if (!Number.isFinite(year) || !Number.isFinite(quarter) || quarter < 1 || quarter > 4) continue;
    calls.push({
      year,
      quarter,
      date: typeof rec.date === "string" ? rec.date : undefined,
      id: typeof rec.id === "string" ? rec.id : undefined
    });
  }
  if (calls.length === 0) return null;
  const normalized = normalizeSymbol(typeof row.symbol === "string" ? row.symbol : symbol);
  if (!normalized) return null;
  return {
    symbol: normalized,
    identifier: typeof row.identifier === "string" ? row.identifier : undefined,
    fetchedAt: typeof row.fetchedAt === "string" ? row.fetchedAt : "",
    calls
  };
}

function countTranscriptFilesUnder(base: string, seen: Set<string>): number {
  if (!fs.existsSync(base)) return 0;
  let count = 0;
  for (const symbolDir of fs.readdirSync(base)) {
    const full = path.join(base, symbolDir);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      for (const name of fs.readdirSync(full)) {
        if (!TRANSCRIPT_FILE_RE.test(name)) continue;
        const key = `${symbolDir}/${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        count += 1;
      }
    } catch {
      // skip unreadable symbol dir
    }
  }
  return count;
}

/** Count transcript JSON files (not index.json) under the corpus root, then legacy. */
export function countRoicTranscriptArtifactFiles(root: string = dataRoot()): number {
  const seen = new Set<string>();
  try {
    return (
      countTranscriptFilesUnder(roicArtifactWriteRoot(root), seen) +
      countTranscriptFilesUnder(roicArtifactLegacyRoot(root), seen)
    );
  } catch {
    return seen.size;
  }
}

const ARTIFACT_COUNT_TTL_MS = 10 * 60_000;
let cachedRoicArtifactFileCount: number | null = null;
let cachedRoicArtifactFileCountAt = 0;
let roicArtifactCountRefresh: Promise<number> | null = null;
let roicArtifactCountGeneration = 0;

/** Last yielding walk, or null if this process has not finished one. */
export function peekRoicArtifactFileCount(): number | null {
  return cachedRoicArtifactFileCount;
}

export function resetRoicArtifactFileCountCacheForTests(): void {
  roicArtifactCountGeneration += 1;
  cachedRoicArtifactFileCount = null;
  cachedRoicArtifactFileCountAt = 0;
  roicArtifactCountRefresh = null;
}

async function countTranscriptFilesUnderYielding(base: string, seen: Set<string>): Promise<void> {
  let symbolDirs: string[];
  try {
    symbolDirs = await fs.promises.readdir(base);
  } catch {
    return;
  }
  for (const symbolDir of symbolDirs) {
    // One directory per turn.  readdirSync of the whole archive pinned the serving
    // loop inside GET /api/ops/snapshot (stall profile 2026-10-05, quarter-json regexp).
    await yieldEventLoop();
    const full = path.join(base, symbolDir);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let names: string[];
    try {
      names = await fs.promises.readdir(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!TRANSCRIPT_FILE_RE.test(name)) continue;
      seen.add(`${symbolDir}/${name}`);
    }
  }
}

/** Recount transcript files without holding the serving loop across the tree.
 *  A fresh cache (10 min) is returned immediately.  Overlapping calls share one walk. */
export function refreshRoicArtifactFileCount(root: string = dataRoot()): Promise<number> {
  if (
    cachedRoicArtifactFileCount !== null &&
    Date.now() - cachedRoicArtifactFileCountAt < ARTIFACT_COUNT_TTL_MS
  ) {
    return Promise.resolve(cachedRoicArtifactFileCount);
  }
  if (roicArtifactCountRefresh) return roicArtifactCountRefresh;
  const generation = roicArtifactCountGeneration;
  const pending = (async () => {
    const seen = new Set<string>();
    try {
      await countTranscriptFilesUnderYielding(roicArtifactWriteRoot(root), seen);
      await countTranscriptFilesUnderYielding(roicArtifactLegacyRoot(root), seen);
    } catch {
      // partial count is still better than throwing into the snapshot
    }
    if (generation !== roicArtifactCountGeneration) return seen.size;
    cachedRoicArtifactFileCount = seen.size;
    cachedRoicArtifactFileCountAt = Date.now();
    return seen.size;
  })();
  roicArtifactCountRefresh = pending;
  void pending.finally(() => {
    if (roicArtifactCountRefresh === pending) roicArtifactCountRefresh = null;
  });
  return pending;
}
