/**
 * US Treasury daily par-yield curve (free, keyless, public domain) — home.treasury.gov's legacy
 * Atom/XML feed. This is the KEYLESS fallback for the yield-curve fields (3-month / 2-year / 10-year)
 * that otherwise require a FRED API key: without one, macro.ts's no-key fallback only gets a live VIX
 * reading and every rate field stays blank. Wiring this in extends that keyless floor to the yield
 * curve too — the same "at least SOMETHING real, never a fabricated placeholder" pattern the VIX
 * cascade already uses.
 *
 * NOT on the machine-readable fiscaldata.treasury.gov REST API — that endpoint 404s for this dataset
 * (verified 2026-08-01/02 research pass) — only this legacy XML feed carries it. The feed requires a
 * browser-like User-Agent (a bare `curl`-default UA times out); it needs no API key or auth.
 */

import { BROWSER_UA } from "../web-sources/http";

const TREASURY_XML_BASE = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml";

export interface TreasuryYieldCurve {
  /** 3-month par yield, % (BC_3MONTH). */
  y3mo?: number;
  /** 2-year par yield, % (BC_2YEAR). */
  y2?: number;
  /** 10-year par yield, % (BC_10YEAR). */
  y10?: number;
  /** Publication date of the row actually used, YYYY-MM-DD. */
  asOf?: string;
}

interface YieldCurveRow {
  date: string;
  y3mo?: number;
  y2?: number;
  y10?: number;
}

function extractTag(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<d:${tag}[^>]*>([^<]*)<\\/d:${tag}>`));
  return m ? m[1] : undefined;
}

function extractNumber(block: string, tag: string): number | undefined {
  const raw = extractTag(block, tag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse the feed's `<entry>` blocks into dated rows. Pure / unit-tested. Rows arrive chronologically
 *  ascending within a month (verified live 2026-08-02), so the last row is the latest published date. */
export function parseTreasuryYieldCurveXml(xml: string): YieldCurveRow[] {
  const rows: YieldCurveRow[] = [];
  for (const block of xml.split("<entry>").slice(1)) {
    const dateRaw = extractTag(block, "NEW_DATE");
    if (!dateRaw) continue;
    const date = dateRaw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    rows.push({
      date,
      y3mo: extractNumber(block, "BC_3MONTH"),
      y2: extractNumber(block, "BC_2YEAR"),
      y10: extractNumber(block, "BC_10YEAR")
    });
  }
  return rows;
}

async function fetchYieldCurveMonth(yyyymm: string): Promise<YieldCurveRow[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${TREASURY_XML_BASE}?data=daily_treasury_yield_curve&field_tdr_date_value_month=${yyyymm}`;
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "user-agent": BROWSER_UA, accept: "application/xml" }
    });
    if (!res.ok) return [];
    return parseTreasuryYieldCurveXml(await res.text());
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Latest available par-yield row, trying the current calendar month first and falling back one month
 * (the first few days of a new month have no rows yet — verified live: 2026-08 was empty on 2026-08-02
 * while 2026-07 had the full month through 07-31). Returns null when every field is unusable — never a
 * fabricated reading, matching the keyless VIX cascade's convention.
 */
export async function fetchTreasuryYieldCurve(now: number = Date.now()): Promise<TreasuryYieldCurve | null> {
  const d = new Date(now);
  const monthKey = (year: number, monthIndex0: number) => `${year}${String(monthIndex0 + 1).padStart(2, "0")}`;

  let rows = await fetchYieldCurveMonth(monthKey(d.getUTCFullYear(), d.getUTCMonth()));
  if (rows.length === 0) {
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    rows = await fetchYieldCurveMonth(monthKey(prev.getUTCFullYear(), prev.getUTCMonth()));
  }
  if (rows.length === 0) return null;

  const latest = rows[rows.length - 1];
  const out: TreasuryYieldCurve = { asOf: latest.date };
  if (latest.y3mo !== undefined) out.y3mo = latest.y3mo;
  if (latest.y2 !== undefined) out.y2 = latest.y2;
  if (latest.y10 !== undefined) out.y10 = latest.y10;
  // asOf alone (no usable rate) isn't worth publishing — treat it the same as "nothing came back".
  return out.y3mo !== undefined || out.y2 !== undefined || out.y10 !== undefined ? out : null;
}
