/**
 * Official ARK ETF daily holdings (assets.ark-funds.com CSVs, discovered via ark-funds.com).
 * Observe-only idea source — never auto-copies the book.
 */
import { createHash } from "crypto";
import {
  audit,
  getInternalSetting,
  setInternalSetting,
  upsertCusipTicker,
  replaceArkFundDay,
  listArkHoldingsForTicker,
  listArkHoldingsForFundAsOf,
  listLatestArkAsOfByFund,
  countArkHoldings
} from "../db";
import { normalizeSymbol } from "../money";
import { resolveSourceNumber } from "../source-settings";
import { retryBackoffMs } from "./congress";
import { BROWSER_UA, politeFetchText } from "./http";
import { arkWritePath, persistCorpusSnapshot } from "../rag/corpus-layout";
import type { WebSourceRefreshResult } from "./types";

const DATASET_KEY = "webSource:ark:dataset";
const ATTEMPT_KEY = "webSource:ark:lastAttempt";
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const ARK_SITE = "https://www.ark-funds.com";
const ARK_CSV_PREFIX = "https://assets.ark-funds.com/fund-documents/funds-etf-csv/";

export const ARK_FUNDS: readonly { ticker: string; fundId: number; fallbackCsv: string }[] = [
  { ticker: "ARKK", fundId: 1004, fallbackCsv: "ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv" },
  { ticker: "ARKQ", fundId: 1001, fallbackCsv: "ARK_AUTONOMOUS_TECH._&_ROBOTICS_ETF_ARKQ_HOLDINGS.csv" },
  { ticker: "ARKW", fundId: 1002, fallbackCsv: "ARK_NEXT_GENERATION_INTERNET_ETF_ARKW_HOLDINGS.csv" },
  { ticker: "ARKG", fundId: 1003, fallbackCsv: "ARK_GENOMIC_REVOLUTION_ETF_ARKG_HOLDINGS.csv" },
  { ticker: "ARKF", fundId: 1007, fallbackCsv: "ARK_BLOCKCHAIN_&_FINTECH_INNOVATION_ETF_ARKF_HOLDINGS.csv" },
  { ticker: "ARKX", fundId: 1008, fallbackCsv: "ARK_SPACE_&_DEFENSE_INNOVATION_ETF_ARKX_HOLDINGS.csv" }
];

export interface ParsedArkRow {
  asOf: string;
  fund: string;
  company: string;
  ticker: string;
  cusip: string;
  shares: number;
  marketValueUsd: number;
  weightPct: number;
}

export interface ArkSignal {
  bulletin: string;
  funds: string[];
  added: string[];
  exited: string[];
  asOf?: string;
}

export interface ArkDataset {
  fetchedAt: string;
  recordCount: number;
  asOf?: string;
}

export function arkTtlMs(): number {
  const v = resolveSourceNumber("WEB_SOURCE_ARK_TTL_MS");
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

export function getArkDataset(): ArkDataset | undefined {
  return getInternalSetting<ArkDataset>(DATASET_KEY);
}

export function isArkRefreshDue(now: number = Date.now()): boolean {
  const lastAttempt = getInternalSetting<string>(ATTEMPT_KEY);
  const dataset = getArkDataset();
  const empty = !dataset?.fetchedAt || (dataset.recordCount ?? 0) <= 0;
  if (lastAttempt) {
    const age = now - Date.parse(lastAttempt);
    // An empty book should not sit behind the 1h scrape backoff.
    const backoff = empty ? 2 * 60_000 : retryBackoffMs();
    if (age < backoff) return false;
  }
  if (empty) return true;
  return now - Date.parse(dataset.fetchedAt) >= arkTtlMs();
}

export async function resolveArkCsvUrl(
  fund: (typeof ARK_FUNDS)[number],
  fetchText: (url: string, options?: { headers?: Record<string, string>; timeoutMs?: number }) => Promise<string> = politeFetchText
): Promise<string> {
  const fallback = `${ARK_CSV_PREFIX}${fund.fallbackCsv}`;
  try {
    const docs = await fetchText(`${ARK_SITE}/api/fund/document-table/${fund.fundId}`, {
      headers: { accept: "text/html", "user-agent": BROWSER_UA },
      timeoutMs: 12_000
    });
    return extractArkCsvHref(docs) ?? fallback;
  } catch {
    return fallback;
  }
}

export function parseArkCsvDate(raw: string): string | undefined {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const month = m[1].padStart(2, "0");
  const day = m[2].padStart(2, "0");
  return `${m[3]}-${month}-${day}`;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function parseArkHoldingsCsv(csv: string): ParsedArkRow[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (name: string) => header.findIndex((h) => h.includes(name));
  const iDate = idx("date");
  const iFund = idx("fund");
  const iCompany = idx("company");
  const iTicker = idx("ticker");
  const iCusip = idx("cusip");
  const iShares = idx("shares");
  const iValue = header.findIndex((h) => h.includes("market value"));
  const iWeight = header.findIndex((h) => h.includes("weight"));
  const out: ParsedArkRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const ticker = normalizeSymbol(cols[iTicker] ?? "");
    if (!ticker || ticker === "CASH") continue;
    const asOf = parseArkCsvDate(cols[iDate] ?? "");
    if (!asOf) continue;
    const shares = Number((cols[iShares] ?? "").replace(/[,$]/g, ""));
    const value = Number((cols[iValue] ?? "").replace(/[$,]/g, ""));
    const weight = Number((cols[iWeight] ?? "").replace(/%/g, ""));
    if (!Number.isFinite(shares) || shares <= 0) continue;
    out.push({
      asOf,
      fund: (cols[iFund] ?? "").trim().toUpperCase() || "ARKK",
      company: cols[iCompany] ?? ticker,
      ticker,
      cusip: (cols[iCusip] ?? "").replace(/\s+/g, "").toUpperCase(),
      shares,
      marketValueUsd: Number.isFinite(value) ? value : 0,
      weightPct: Number.isFinite(weight) ? weight : 0
    });
  }
  return out;
}

export function extractArkCsvHref(html: string): string | undefined {
  const decoded = html.replace(/&amp;/g, "&");
  return decoded.match(/https:\/\/assets\.ark-funds\.com\/fund-documents\/funds-etf-csv\/[^"'<\s]+/i)?.[0];
}

export function previousArkAsOf(asOf: string, known: string[]): string | undefined {
  const older = known.filter((d) => d < asOf).sort();
  return older[older.length - 1];
}

export function formatArkEvidenceCard(ticker: string): string {
  const rows = listArkHoldingsForTicker(ticker, 18);
  if (rows.length === 0) return "";
  const lines = [`[ARK official daily holdings in ${ticker}]`];
  for (const r of rows.slice(0, 12)) {
    lines.push(
      `- ${r.asOf} ${r.fund}: ${r.weightPct.toFixed(2)}% / ${r.shares.toLocaleString()} sh / $${Math.round(r.marketValueUsd).toLocaleString()}`
    );
  }
  return lines.join("\n");
}

export function getArkSignals(symbols: string[]): Record<string, ArkSignal> {
  const wanted = new Set(symbols.map(normalizeSymbol).filter(Boolean));
  const latestByFund = listLatestArkAsOfByFund();
  const out: Record<string, ArkSignal> = {};
  for (const symbol of wanted) {
    const rows = listArkHoldingsForTicker(symbol, 40);
    if (rows.length === 0) continue;
    const funds = Array.from(new Set(rows.map((r) => r.fund)));
    const added: string[] = [];
    const exited: string[] = [];
    let asOf: string | undefined;
    for (const { fund, asOf: latest } of latestByFund) {
      const today = listArkHoldingsForFundAsOf(fund, latest);
      const todayHit = today.find((r) => r.ticker === symbol);
      const knownDates = Array.from(new Set(listArkHoldingsForTicker(symbol, 80).filter((r) => r.fund === fund).map((r) => r.asOf)));
      const priorDate = previousArkAsOf(latest, [
        ...knownDates,
        ...today.map((r) => r.asOf)
      ]);
      const prior = priorDate ? listArkHoldingsForFundAsOf(fund, priorDate).find((r) => r.ticker === symbol) : undefined;
      if (todayHit) {
        asOf = latest;
        if (!prior) added.push(fund);
      } else if (prior) {
        exited.push(fund);
        asOf = latest;
      }
    }
    const holdingFunds = latestByFund
      .filter(({ fund, asOf: d }) => listArkHoldingsForFundAsOf(fund, d).some((r) => r.ticker === symbol))
      .map((f) => f.fund);
    const bits: string[] = [];
    if (added.length) bits.push(`added in ${added.join(", ")}`);
    if (exited.length) bits.push(`exited ${exited.join(", ")}`);
    if (bits.length === 0 && holdingFunds.length > 0) {
      const top = rows.find((r) => r.asOf === (asOf ?? rows[0].asOf));
      bits.push(
        `held in ${holdingFunds.join(", ")}` +
          (top ? ` (${top.weightPct.toFixed(2)}% of ${top.fund})` : "")
      );
    }
    if (bits.length === 0) continue;
    out[symbol] = {
      bulletin: `ARK${asOf ? ` ${asOf}` : ""}: ${symbol} ${bits.join("; ")}.`,
      funds: holdingFunds.length ? holdingFunds : funds,
      added,
      exited,
      asOf
    };
  }
  return out;
}

export async function refreshArkHoldings(now: number = Date.now(), force = false): Promise<WebSourceRefreshResult> {
  if (!force && !isArkRefreshDue(now)) {
    const ds = getArkDataset();
    return {
      id: "ark",
      ok: true,
      recordCount: ds?.recordCount ?? countArkHoldings(),
      sources: ds ? ["ark-funds"] : [],
      fetchedAt: ds?.fetchedAt ?? "",
      skipped: true
    };
  }
  setInternalSetting(ATTEMPT_KEY, new Date(now).toISOString());
  const fetchedAt = new Date(now).toISOString();
  let warning: string | undefined;
  let freshRows = 0;
  let latestAsOf: string | undefined;

  for (const fund of ARK_FUNDS) {
    try {
      const csvUrl = await resolveArkCsvUrl(fund);
      const csv = await politeFetchText(csvUrl, {
        headers: { "user-agent": BROWSER_UA },
        timeoutMs: 20_000
      });
      const parsed = parseArkHoldingsCsv(csv);
      if (parsed.length === 0) continue;
      const asOf = parsed[0].asOf;
      latestAsOf = asOf;
      const rows = parsed.map((r) => {
        if (r.cusip) upsertCusipTicker(r.cusip, r.ticker, "ark-csv", fetchedAt);
        return {
          id: createHash("sha256").update(`${r.fund}:${r.asOf}:${r.ticker}`).digest("hex").slice(0, 32),
          asOf: r.asOf,
          fund: r.fund || fund.ticker,
          ticker: r.ticker,
          company: r.company,
          cusip: r.cusip,
          shares: r.shares,
          marketValueUsd: r.marketValueUsd,
          weightPct: r.weightPct,
          fetchedAt
        };
      });
      replaceArkFundDay(rows);
      persistCorpusSnapshot(
        arkWritePath(rows[0].fund, asOf),
        JSON.stringify({ fund: rows[0].fund, asOf, fetchedAt, holdings: rows })
      );
      freshRows += rows.length;
    } catch (error) {
      warning = error instanceof Error ? error.message : "ark fetch failed";
    }
  }

  const recordCount = countArkHoldings();
  const ok = freshRows > 0 || recordCount > 0;
  const prev = getArkDataset();
  const dataset: ArkDataset = {
    fetchedAt: freshRows > 0 ? fetchedAt : prev?.fetchedAt ?? "",
    recordCount,
    asOf: latestAsOf ?? prev?.asOf
  };
  setInternalSetting(DATASET_KEY, dataset);
  audit("web_source_refresh", { id: "ark", ok, recordCount, fresh: freshRows, warning });
  return { id: "ark", ok, recordCount, sources: ["ark-funds"], fetchedAt: dataset.fetchedAt, warning };
}
