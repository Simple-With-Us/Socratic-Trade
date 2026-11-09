// FINRA daily short-sale volume ingestion.
//
// FINRA publishes a free, no-key daily file of consolidated (CNMS) short-sale
// volume per symbol: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market.
// The short-volume RATIO (ShortVolume / TotalVolume) is a daily short-pressure read
// that complements Yahoo's biweekly short-interest (% of float): a high ratio means
// a large share of the day's prints were short-marked. Authoritative and updated
// each trading day. Like the other web sources, this is a low-frequency bulk job
// that degrades to nothing on failure (never fabricated).

import { audit, getInternalSetting, setInternalSetting } from "../db";
import { normalizeSymbol } from "../money";
import { retryBackoffMs } from "./congress";
import { politeFetchText } from "./http";

const DATASET_KEY = "webSource:finra:dataset";
const ATTEMPT_KEY = "webSource:finra:lastAttempt";
const DEFAULT_TTL_MS = 24 * 60 * 60_000; // daily file
const BASE = "https://cdn.finra.org/equity/regsho/daily";
const UA = "SocraticTrade/1.0 (contact: admin@localhost)";
/** Short-volume ratio above this (% of the day's volume) is flagged as elevated short pressure. */
const ELEVATED_PCT = 55;

export interface FinraDataset {
  ratios: Record<string, number>; // symbol -> short volume as % of total volume (1 decimal)
  asOf?: string; // ISO date of the data
  fetchedAt: string;
  recordCount: number;
}

export function finraTtlMs(): number {
  const v = Number(process.env.WEB_SOURCE_FINRA_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

export function getFinraDataset(): FinraDataset | undefined {
  return getInternalSetting<FinraDataset>(DATASET_KEY);
}

// ── Pure parser (unit-tested) ────────────────────────────────────────────────

/** Parse a FINRA CNMSshvol file into per-symbol short-volume ratios (% of total volume). */
export function parseFinraShortVolume(text: string): { asOf?: string; ratios: Record<string, number> } {
  const ratios: Record<string, number> = {};
  let asOf: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split("|");
    if (parts.length < 5) continue;
    const [date, symbolRaw, shortVolRaw, , totalVolRaw] = parts;
    if (!/^\d{8}$/.test(date)) continue; // skips the header and any footer line
    if (!asOf) asOf = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const symbol = normalizeSymbol(symbolRaw);
    const shortVol = Number(shortVolRaw);
    const totalVol = Number(totalVolRaw);
    if (!symbol || !Number.isFinite(shortVol) || !Number.isFinite(totalVol) || totalVol <= 0) continue;
    ratios[symbol] = Math.round((shortVol / totalVol) * 1000) / 10;
  }
  return { asOf, ratios };
}

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// ── Read API ─────────────────────────────────────────────────────────────────

export interface ShortVolumeSignal {
  shortVolumeRatio: number; // % of the day's volume that was short
  elevated: boolean;
  asOf?: string;
  bulletin?: string;
}

export function getShortVolumeSignals(symbols: string[]): Record<string, ShortVolumeSignal> {
  const dataset = getFinraDataset();
  if (!dataset?.ratios) return {};
  const out: Record<string, ShortVolumeSignal> = {};
  for (const raw of symbols) {
    const symbol = normalizeSymbol(raw);
    const ratio = dataset.ratios[symbol];
    if (typeof ratio !== "number") continue;
    const elevated = ratio >= ELEVATED_PCT;
    out[symbol] = {
      shortVolumeRatio: ratio,
      elevated,
      asOf: dataset.asOf,
      bulletin: elevated ? `Short pressure: ${ratio}% of ${symbol}'s daily volume was short-sold (elevated).` : undefined
    };
  }
  return out;
}

// ── Refresh ──────────────────────────────────────────────────────────────────

export function isFinraRefreshDue(now: number = Date.now()): boolean {
  const lastAttempt = getInternalSetting<string>(ATTEMPT_KEY);
  if (lastAttempt && now - Date.parse(lastAttempt) < retryBackoffMs()) return false;
  const dataset = getFinraDataset();
  if (!dataset?.fetchedAt) return true;
  return now - Date.parse(dataset.fetchedAt) >= finraTtlMs();
}

/** Fetch the most recent available daily file (markets are closed on weekends/holidays). */
async function fetchLatestFile(now: number): Promise<{ text: string } | null> {
  for (let i = 0; i <= 6; i++) {
    try {
      const text = await politeFetchText(`${BASE}/CNMSshvol${ymd(new Date(now - i * 24 * 60 * 60_000))}.txt`, {
        headers: { "user-agent": UA }
      });
      if (text.includes("|")) return { text };
    } catch {
      /* try the prior day */
    }
  }
  return null;
}

export async function refreshFinra(now: number = Date.now(), force = false): Promise<import("./types").WebSourceRefreshResult> {
  if (!force && !isFinraRefreshDue(now)) {
    const ds = getFinraDataset();
    return { id: "finra", ok: true, recordCount: ds?.recordCount ?? 0, sources: ds ? ["finra"] : [], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }
  setInternalSetting(ATTEMPT_KEY, new Date(now).toISOString());

  const file = await fetchLatestFile(now);
  if (!file) {
    const prior = getFinraDataset();
    audit("web_source_refresh", { id: "finra", ok: false, recordCount: 0 });
    return { id: "finra", ok: false, recordCount: prior?.recordCount ?? 0, sources: [], fetchedAt: prior?.fetchedAt ?? "", warning: "no file available" };
  }

  const { asOf, ratios } = parseFinraShortVolume(file.text);
  const recordCount = Object.keys(ratios).length;
  if (recordCount === 0) {
    audit("web_source_refresh", { id: "finra", ok: false, recordCount: 0, warning: "empty parse" });
    return { id: "finra", ok: false, recordCount: 0, sources: [], fetchedAt: getFinraDataset()?.fetchedAt ?? "", warning: "empty parse" };
  }

  const fetchedAt = new Date(now).toISOString();
  const dataset: FinraDataset = { ratios, asOf, fetchedAt, recordCount };
  setInternalSetting(DATASET_KEY, dataset);
  audit("web_source_refresh", { id: "finra", ok: true, recordCount, asOf });
  return { id: "finra", ok: true, recordCount, sources: ["finra"], fetchedAt };
}
