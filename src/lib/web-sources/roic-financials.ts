// ROIC.ai multi-year financial statement modeling & RAG document generator.
//
// Fetches multi-year Income Statements, Balance Sheets, and Cash Flow Statements from ROIC.ai (/v2/financials/{symbol}),
// computes multi-year financial trends (3-year revenue CAGR, margin trajectories, ROIC, FCF conversion),
// and formats structured financial summaries for strategy reasoning and RAG vector store ingestion.

import { fetchWithRetry } from "../data-providers";
import { resolveApiKeyWithSource } from "../db-api-keys";
import { normalizeSymbol } from "../money";
import { storeDocument } from "../vector-db";

export const ROIC_FINANCIALS_DOC_TYPE = "financial-statement";
export const ROIC_FINANCIALS_SOURCE = "roic-multiyear-financials";

const ROIC_BASE = "https://api.roic.ai/v2";

export interface AnnualFinancialRow {
  year: number;
  revenue?: number;
  grossProfit?: number;
  operatingIncome?: number;
  netIncome?: number;
  operatingCashFlow?: number;
  freeCashFlow?: number;
  totalDebt?: number;
  cashAndEquivalents?: number;
  totalAssets?: number;
  totalEquity?: number;
}

export interface MultiYearFinancialMetrics {
  symbol: string;
  years: AnnualFinancialRow[];
  revenueCagr3Y?: number;
  grossMarginTrajectory?: "expanding" | "compressing" | "stable";
  operatingMarginTrajectory?: "expanding" | "compressing" | "stable";
  latestRoic?: number;
  latestFcfConversion?: number;
  latestNetDebtToEbitda?: number;
}

function safeNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const parsed = parseFloat(v.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function parseRoicFinancialStatements(json: unknown, symbol: string): MultiYearFinancialMetrics | null {
  const normSymbol = normalizeSymbol(symbol);
  if (!normSymbol || !json || typeof json !== "object") return null;

  const root = json as Record<string, unknown>;
  const rawYears = Array.isArray(root.financials)
    ? root.financials
    : Array.isArray(root.years)
    ? root.years
    : Array.isArray(json)
    ? json
    : [];

  if (rawYears.length === 0) return null;

  const years: AnnualFinancialRow[] = [];
  for (const item of rawYears) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const year = safeNumber(row.year ?? row.fiscal_year ?? row.date?.toString().slice(0, 4));
    if (!year || year < 1990 || year > 2030) continue;

    years.push({
      year: Math.round(year),
      revenue: safeNumber(row.revenue ?? row.total_revenue),
      grossProfit: safeNumber(row.gross_profit ?? row.grossProfit),
      operatingIncome: safeNumber(row.operating_income ?? row.operatingIncome),
      netIncome: safeNumber(row.net_income ?? row.netIncome),
      operatingCashFlow: safeNumber(row.operating_cash_flow ?? row.operatingCashFlow),
      freeCashFlow: safeNumber(row.free_cash_flow ?? row.freeCashFlow),
      totalDebt: safeNumber(row.total_debt ?? row.totalDebt),
      cashAndEquivalents: safeNumber(row.cash_and_equivalents ?? row.cashAndEquivalents),
      totalAssets: safeNumber(row.total_assets ?? row.totalAssets),
      totalEquity: safeNumber(row.total_equity ?? row.totalEquity)
    });
  }

  if (years.length === 0) return null;
  years.sort((a, b) => a.year - b.year); // ascending by year

  // Calculate 3-year revenue CAGR
  let revenueCagr3Y: number | undefined;
  if (years.length >= 4) {
    const latestRev = years[years.length - 1].revenue;
    const startRev = years[years.length - 4].revenue;
    if (latestRev && startRev && startRev > 0 && latestRev > 0) {
      revenueCagr3Y = (Math.pow(latestRev / startRev, 1 / 3) - 1) * 100;
    }
  }

  // Calculate margin trajectories over the last 3 years
  let grossMarginTrajectory: "expanding" | "compressing" | "stable" | undefined;
  let operatingMarginTrajectory: "expanding" | "compressing" | "stable" | undefined;

  if (years.length >= 3) {
    const yRecent = years[years.length - 1];
    const yOlder = years[years.length - 3];

    if (yRecent.grossProfit && yRecent.revenue && yOlder.grossProfit && yOlder.revenue) {
      const recentGm = yRecent.grossProfit / yRecent.revenue;
      const olderGm = yOlder.grossProfit / yOlder.revenue;
      const diff = recentGm - olderGm;
      grossMarginTrajectory = diff > 0.015 ? "expanding" : diff < -0.015 ? "compressing" : "stable";
    }

    if (yRecent.operatingIncome && yRecent.revenue && yOlder.operatingIncome && yOlder.revenue) {
      const recentOm = yRecent.operatingIncome / yRecent.revenue;
      const olderOm = yOlder.operatingIncome / yOlder.revenue;
      const diff = recentOm - olderOm;
      operatingMarginTrajectory = diff > 0.015 ? "expanding" : diff < -0.015 ? "compressing" : "stable";
    }
  }

  // Latest FCF conversion
  const latest = years[years.length - 1];
  let latestFcfConversion: number | undefined;
  if (latest.freeCashFlow !== undefined && latest.netIncome && latest.netIncome > 0) {
    latestFcfConversion = (latest.freeCashFlow / latest.netIncome) * 100;
  }

  // Latest ROIC estimate (Operating Income * (1 - 21%) / (Total Equity + Total Debt - Cash))
  let latestRoic: number | undefined;
  if (latest.operatingIncome && latest.totalEquity) {
    const debt = latest.totalDebt ?? 0;
    const cash = latest.cashAndEquivalents ?? 0;
    const investedCapital = latest.totalEquity + debt - cash;
    if (investedCapital > 0) {
      const nopat = latest.operatingIncome * 0.79;
      latestRoic = (nopat / investedCapital) * 100;
    }
  }

  return {
    symbol: normSymbol,
    years,
    ...(revenueCagr3Y !== undefined && { revenueCagr3Y: Math.round(revenueCagr3Y * 100) / 100 }),
    ...(grossMarginTrajectory !== undefined && { grossMarginTrajectory }),
    ...(operatingMarginTrajectory !== undefined && { operatingMarginTrajectory }),
    ...(latestRoic !== undefined && { latestRoic: Math.round(latestRoic * 100) / 100 }),
    ...(latestFcfConversion !== undefined && { latestFcfConversion: Math.round(latestFcfConversion * 100) / 100 })
  };
}

export async function fetchRoicFinancials(symbol: string, userId?: string): Promise<MultiYearFinancialMetrics | null> {
  const normSymbol = normalizeSymbol(symbol);
  if (!normSymbol) return null;

  const keyInfo = resolveApiKeyWithSource("roic", userId);
  if (!keyInfo.key) return null;

  const url = `${ROIC_BASE}/financials/${encodeURIComponent(normSymbol)}?apikey=${encodeURIComponent(keyInfo.key)}`;
  try {
    const res = await fetchWithRetry(
      url,
      {},
      { service: "roic", keySource: keyInfo.source, userId, suppressHealthStatuses: [404, 429] }
    );
    if (!res || !res.ok) return null;
    const json = await res.json();
    return parseRoicFinancialStatements(json, normSymbol);
  } catch (err) {
    console.warn(`[roic-financials] failed to fetch financials for ${normSymbol}:`, err);
    return null;
  }
}

export function formatMultiYearFinancialDoc(metrics: MultiYearFinancialMetrics): string {
  const lines: string[] = [
    `# ${metrics.symbol} Multi-Year Financial Analysis Summary`,
    `Symbol: ${metrics.symbol}`,
    `Reporting History: ${metrics.years.length} annual periods`
  ];

  if (metrics.revenueCagr3Y !== undefined) {
    lines.push(`3-Year Revenue CAGR: ${metrics.revenueCagr3Y}%`);
  }
  if (metrics.grossMarginTrajectory) {
    lines.push(`Gross Margin Trajectory (3Y): ${metrics.grossMarginTrajectory.toUpperCase()}`);
  }
  if (metrics.operatingMarginTrajectory) {
    lines.push(`Operating Margin Trajectory (3Y): ${metrics.operatingMarginTrajectory.toUpperCase()}`);
  }
  if (metrics.latestRoic !== undefined) {
    lines.push(`Return on Invested Capital (ROIC): ${metrics.latestRoic}%`);
  }
  if (metrics.latestFcfConversion !== undefined) {
    lines.push(`Free Cash Flow Conversion Ratio: ${metrics.latestFcfConversion}%`);
  }

  lines.push("\n## Annual Financial Performance Trend:");
  lines.push("Year | Revenue ($M) | Operating Income ($M) | Free Cash Flow ($M)");
  lines.push("-----|--------------|-----------------------|--------------------");

  for (const y of metrics.years) {
    const rev = y.revenue ? (y.revenue / 1_000_000).toFixed(1) : "N/A";
    const opInc = y.operatingIncome ? (y.operatingIncome / 1_000_000).toFixed(1) : "N/A";
    const fcf = y.freeCashFlow ? (y.freeCashFlow / 1_000_000).toFixed(1) : "N/A";
    lines.push(`${y.year} | ${rev} | ${opInc} | ${fcf}`);
  }

  return lines.join("\n");
}

export async function ingestRoicFinancialsToRag(metrics: MultiYearFinancialMetrics, userId?: string): Promise<boolean> {
  const content = formatMultiYearFinancialDoc(metrics);
  const doc_id = `roic-financials-${metrics.symbol.toLowerCase()}`;
  const title = `${metrics.symbol} Multi-Year Financial Statements & Trends Summary`;

  try {
    const result = await storeDocument(
      {
        doc_id,
        title,
        doc_type: ROIC_FINANCIALS_DOC_TYPE,
        source: ROIC_FINANCIALS_SOURCE,
        text: content,
        ticker: metrics.symbol,
        published_at: new Date().toISOString().split("T")[0]
      },
      userId ?? "local"
    );
    return !result.error && (result.indexed > 0 || result.attempted > 0);
  } catch (err) {
    console.error(`[roic-financials] failed to ingest RAG document for ${doc_id}:`, err);
    return false;
  }
}
