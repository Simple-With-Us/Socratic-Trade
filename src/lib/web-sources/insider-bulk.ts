// Quarterly SEC Form 4 insider-transactions datasets (free, no key).
//
// The current-filings atom feed only carries the latest page of Form 4s, so a
// ~150-symbol universe stays partial. The DERA quarterly ZIPs cover every issuer.
// We keep open-market P/S rows inside the sentiment window and cache them by
// symbol on the insider dataset. Downloads use the shared SEC User-Agent and
// the .sec.gov limiter inside politeFetch.

import zlib from "zlib";
import { z } from "zod";
import { normalizeSymbol } from "../money";
import { politeFetch, secUserAgent } from "./http";

/** One open-market Form 4 collapsed from a quarterly ZIP.  Built here, then parsed before return. */
export const BulkInsiderFilingSchema = z
  .object({
    symbol: z.string().regex(/^[A-Z][A-Z.\-]{0,5}$/),
    owner: z.string().min(1),
    buyTx: z.number().int().nonnegative(),
    sellTx: z.number().int().nonnegative(),
    buyShares: z.number().nonnegative(),
    sellShares: z.number().nonnegative(),
    buyValue: z.number().nonnegative(),
    sellValue: z.number().nonnegative(),
    filedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    accession: z.string().min(1)
  })
  .strict();
export type BulkInsiderFiling = z.infer<typeof BulkInsiderFilingSchema>;

const MONTHS: Record<string, string> = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12"
};

/** Current quarter plus the quarter that contains `now - 90d` (the score window). */
export function insiderBulkQuarterKeys(now: number = Date.now()): string[] {
  const keys = new Set<string>();
  for (const ms of [now, now - 90 * 24 * 60 * 60_000]) {
    const d = new Date(ms);
    const q = Math.floor(d.getUTCMonth() / 3) + 1;
    keys.add(`${d.getUTCFullYear()}q${q}`);
  }
  return [...keys];
}

export function insiderBulkZipUrls(quarterKey: string): string[] {
  return [
    `https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/${quarterKey}_form345.zip`,
    `https://www.sec.gov/files/dera/data/form-345/${quarterKey}_form345.zip`
  ];
}

/** Extract named members from a ZIP (store or deflate). Names are basenames. */
export function unzipNamedFiles(buf: Buffer): Map<string, string> {
  if (buf.length < 22) throw new Error("zip too small");
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== 0x02014b50) break;
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const localOff = buf.readUInt32LE(cd + 42);
    const name = buf.subarray(cd + 46, cd + 46 + nameLen).toString("utf8");
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error("zip local header missing");
    }
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let text: string;
    if (method === 0) text = comp.toString("utf8");
    else if (method === 8) text = zlib.inflateRawSync(comp).toString("utf8");
    else throw new Error(`unsupported zip compression method ${method}`);
    const base = name.split("/").pop() || name;
    out.set(base, text);
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("zip end of central directory not found");
}

function parseTsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split("\t").map((cell) => cell.trim().toUpperCase());
  const rows: Array<Record<string, string>> = [];
  for (const line of lines.slice(1)) {
    const cols = line.split("\t");
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      if (!header[i]) continue;
      row[header[i]] = (cols[i] ?? "").trim();
    }
    rows.push(row);
  }
  return rows;
}

function pickTable(files: Map<string, string>, token: string): string | undefined {
  const want = token.toUpperCase();
  for (const [name, body] of files) {
    const base = name.split("/").pop()?.toUpperCase() ?? "";
    if (base.includes(want)) return body;
  }
  return undefined;
}

/** SEC dates arrive as YYYY-MM-DD or DD-MON-YYYY. */
export function normalizeSecDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const mon = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!mon) return undefined;
  const mm = MONTHS[mon[2].toUpperCase()];
  if (!mm) return undefined;
  return `${mon[3]}-${mm}-${mon[1].padStart(2, "0")}`;
}

function inWindow(iso: string, now: number, windowDays: number): boolean {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return false;
  const today = new Date(now).toISOString().slice(0, 10);
  if (iso > today) return false;
  return ts >= now - windowDays * 24 * 60 * 60_000;
}

function finiteNumber(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

const optionalCell = z.string().min(1).optional();

const BulkSubmissionRowSchema = z
  .object({
    ACCESSION_NUMBER: z.string().min(1),
    ISSUERTRADINGSYMBOL: z.string().min(1)
  })
  .passthrough();

const BulkOwnerRowSchema = z
  .object({
    ACCESSION_NUMBER: z.string().min(1),
    RPTOWNERNAME: optionalCell,
    RPT_OWNER_NAME: optionalCell
  })
  .passthrough();

const BulkTransRowSchema = z
  .object({
    ACCESSION_NUMBER: z.string().min(1),
    TRANS_CODE: z.enum(["P", "S"]),
    TRANS_DATE: optionalCell,
    PERIOD_OF_REPORT: optionalCell,
    TRANS_SHARES: optionalCell,
    TRANS_PRICEPERSHARE: optionalCell
  })
  .passthrough();

function cell(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Collapse SUBMISSION + NONDERIV_TRANS (+ optional REPORTINGOWNER) into one
 * filing per accession. Only open-market P and S inside the window count.
 * Dollar value is shares times price. Unpriced rows still count shares.
 */
export function parseInsiderBulkTables(
  files: Map<string, string>,
  now: number = Date.now(),
  windowDays = 90
): BulkInsiderFiling[] {
  const submission = parseTsv(pickTable(files, "SUBMISSION") ?? "");
  const trans = parseTsv(pickTable(files, "NONDERIV_TRANS") ?? "");
  const owners = parseTsv(pickTable(files, "REPORTINGOWNER") ?? "");
  if (submission.length === 0 || trans.length === 0) return [];

  const symbolByAccession = new Map<string, string>();
  for (const row of submission) {
    const parsed = BulkSubmissionRowSchema.safeParse(row);
    if (!parsed.success) continue;
    const accession = parsed.data.ACCESSION_NUMBER;
    const symbol = normalizeSymbol(parsed.data.ISSUERTRADINGSYMBOL);
    if (!/^[A-Z][A-Z.\-]{0,5}$/.test(symbol)) continue;
    symbolByAccession.set(accession, symbol);
  }
  const ownerByAccession = new Map<string, string>();
  for (const row of owners) {
    const parsed = BulkOwnerRowSchema.safeParse({
      ACCESSION_NUMBER: cell(row.ACCESSION_NUMBER),
      RPTOWNERNAME: cell(row.RPTOWNERNAME),
      RPT_OWNER_NAME: cell(row.RPT_OWNER_NAME)
    });
    if (!parsed.success) continue;
    const name = (parsed.data.RPTOWNERNAME || parsed.data.RPT_OWNER_NAME || "").replace(/\s+/g, " ").trim();
    if (name && !ownerByAccession.has(parsed.data.ACCESSION_NUMBER)) {
      ownerByAccession.set(parsed.data.ACCESSION_NUMBER, name);
    }
  }

  const byAccession = new Map<string, BulkInsiderFiling>();
  for (const row of trans) {
    const parsedRow = BulkTransRowSchema.safeParse({
      ACCESSION_NUMBER: cell(row.ACCESSION_NUMBER),
      TRANS_CODE: cell(row.TRANS_CODE)?.toUpperCase(),
      TRANS_DATE: cell(row.TRANS_DATE),
      PERIOD_OF_REPORT: cell(row.PERIOD_OF_REPORT),
      TRANS_SHARES: cell(row.TRANS_SHARES),
      TRANS_PRICEPERSHARE: cell(row.TRANS_PRICEPERSHARE)
    });
    if (!parsedRow.success) continue;
    const accession = parsedRow.data.ACCESSION_NUMBER;
    const symbol = symbolByAccession.get(accession);
    if (!symbol) continue;
    const code = parsedRow.data.TRANS_CODE;
    const when = normalizeSecDate(parsedRow.data.TRANS_DATE) ?? normalizeSecDate(parsedRow.data.PERIOD_OF_REPORT);
    if (!when || !inWindow(when, now, windowDays)) continue;
    const shares = finiteNumber(parsedRow.data.TRANS_SHARES);
    const price = finiteNumber(parsedRow.data.TRANS_PRICEPERSHARE);
    const value = shares > 0 && price > 0 ? shares * price : 0;
    const filing = byAccession.get(accession) ?? {
      symbol,
      owner: ownerByAccession.get(accession) || "Insider",
      buyTx: 0,
      sellTx: 0,
      buyShares: 0,
      sellShares: 0,
      buyValue: 0,
      sellValue: 0,
      filedAt: when,
      accession
    };
    if (when > filing.filedAt) filing.filedAt = when;
    if (code === "P") {
      filing.buyTx += 1;
      filing.buyShares += shares;
      filing.buyValue += value;
    } else {
      filing.sellTx += 1;
      filing.sellShares += shares;
      filing.sellValue += value;
    }
    byAccession.set(accession, filing);
  }
  const filings: BulkInsiderFiling[] = [];
  for (const filing of byAccession.values()) {
    const parsed = BulkInsiderFilingSchema.safeParse(filing);
    if (parsed.success) filings.push(parsed.data);
  }
  return filings;
}

async function downloadQuarter(quarterKey: string): Promise<Map<string, string> | null> {
  const ua = secUserAgent();
  for (const url of insiderBulkZipUrls(quarterKey)) {
    try {
      const res = await politeFetch(url, {
        headers: { "user-agent": ua, accept: "application/zip,application/octet-stream" },
        timeoutMs: 60_000
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const files = unzipNamedFiles(buf);
      if (files.size > 0) return files;
    } catch {
      // Try the alternate quarterly URL. A 404 must not wipe the XML delta.
    }
  }
  return null;
}

export interface InsiderBulkLoad {
  filings: BulkInsiderFiling[];
  /** True only when the quarter that contains `now` downloaded.  A prior quarter is not coverage. */
  currentQuarterLoaded: boolean;
}

/** Download the quarters that cover the score window.  A missing ZIP leaves that quarter unloaded. */
export async function fetchInsiderBulkFilings(now: number = Date.now(), windowDays = 90): Promise<InsiderBulkLoad> {
  const merged = new Map<string, BulkInsiderFiling>();
  const keys = insiderBulkQuarterKeys(now);
  const currentKey = keys[0];
  let currentQuarterLoaded = false;
  for (const key of keys) {
    const files = await downloadQuarter(key);
    if (!files) continue;
    if (key === currentKey) currentQuarterLoaded = true;
    for (const filing of parseInsiderBulkTables(files, now, windowDays)) {
      merged.set(filing.accession, filing);
    }
  }
  return { filings: [...merged.values()], currentQuarterLoaded };
}
