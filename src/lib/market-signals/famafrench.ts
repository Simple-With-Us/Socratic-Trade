import zlib from "zlib";

/**
 * Kenneth French Data Library — daily equity-factor returns (free, no API key).
 * Tells the agent which style factors are working lately: market (Mkt-RF), size (SMB),
 * value (HML), and momentum (Mom). We report the trailing ~1-month cumulative return per
 * factor so the agent can read the current factor regime (e.g. "value leading, momentum
 * fading"). Source files are single-CSV ZIPs; we extract with zlib (no extra dependency).
 *
 * Honesty: if a file is unreachable or unparseable, the factor is simply omitted — never
 * fabricated.
 */

const FF_BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp";

export interface FamaFrenchFactors {
  /** Trailing ~21-trading-day cumulative factor returns, in percent. */
  factors1m?: Partial<Record<"mktRf" | "smb" | "hml" | "mom", number>>;
  asOf?: string; // ISO date of the latest observation
}

interface ParsedFactors {
  columns: string[];
  rows: Array<{ date: string; values: number[] }>;
}

/** Extract the first file from a single-entry ZIP buffer (stored or deflated). Pure. */
export function unzipSingleFile(buf: Buffer): string {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error("not a zip");
  const method = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;
  // When the size is recorded in the local header (the common case), slice exactly; otherwise
  // (size deferred to a data descriptor) inflate from the data start and let zlib stop at the stream end.
  const comp = compSize > 0 ? buf.subarray(dataStart, dataStart + compSize) : buf.subarray(dataStart);
  if (method === 0) return comp.toString("utf8");
  if (method === 8) return zlib.inflateRawSync(comp).toString("utf8");
  throw new Error(`unsupported zip compression method ${method}`);
}

/** Parse a Ken French daily CSV (preamble, a `,Col1,Col2,...` header, then `YYYYMMDD,...` rows). Pure. */
export function parseFamaFrenchDaily(csv: string): ParsedFactors {
  const lines = csv.split(/\r?\n/);
  const headerLine = lines.find((l) => /^\s*,/.test(l) && /(Mkt-RF|SMB|HML|Mom)/i.test(l));
  const columns = headerLine ? headerLine.split(",").slice(1).map((s) => s.trim()).filter(Boolean) : [];
  const rows: ParsedFactors["rows"] = [];
  for (const line of lines) {
    if (!/^\s*\d{8}\s*,/.test(line)) continue;
    const parts = line.split(",").map((s) => s.trim());
    rows.push({ date: parts[0], values: parts.slice(1).map(Number) });
  }
  return { columns, rows };
}

/** Sum the trailing `n` daily values for a named column (≈ cumulative return). Pure. */
export function trailingSum(parsed: ParsedFactors, column: string, n: number): number | undefined {
  const idx = parsed.columns.indexOf(column);
  if (idx < 0) return undefined;
  const tail = parsed.rows.slice(-n);
  if (tail.length < n) return undefined;
  const sum = tail.reduce((acc, r) => acc + (Number.isFinite(r.values[idx]) ? r.values[idx] : 0), 0);
  return Math.round(sum * 100) / 100;
}

async function fetchFFFile(file: string): Promise<ParsedFactors | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${FF_BASE}/${file}`, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return parseFamaFrenchDaily(unzipSingleFile(buf));
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

const TRAILING_DAYS = 21; // ≈ one trading month

export async function fetchFamaFrenchFactors(): Promise<FamaFrenchFactors> {
  const main = await fetchFFFile("F-F_Research_Data_Factors_daily_CSV.zip"); // Mkt-RF, SMB, HML, RF
  if (!main || main.rows.length === 0) return {};
  const mom = await fetchFFFile("F-F_Momentum_Factor_daily_CSV.zip"); // Mom

  const factors1m: NonNullable<FamaFrenchFactors["factors1m"]> = {};
  const mkt = trailingSum(main, "Mkt-RF", TRAILING_DAYS);
  const smb = trailingSum(main, "SMB", TRAILING_DAYS);
  const hml = trailingSum(main, "HML", TRAILING_DAYS);
  if (mkt !== undefined) factors1m.mktRf = mkt;
  if (smb !== undefined) factors1m.smb = smb;
  if (hml !== undefined) factors1m.hml = hml;
  if (mom) {
    const m = trailingSum(mom, "Mom", TRAILING_DAYS);
    if (m !== undefined) factors1m.mom = m;
  }

  const latest = main.rows[main.rows.length - 1]?.date;
  const asOf = latest && latest.length === 8 ? `${latest.slice(0, 4)}-${latest.slice(4, 6)}-${latest.slice(6, 8)}` : undefined;
  return {
    factors1m: Object.keys(factors1m).length > 0 ? factors1m : undefined,
    asOf
  };
}
