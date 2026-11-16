/**
 * Official eToro Public API client for CopyTrader intelligence.
 * Base: https://public-api.etoro.com
 * Auth: x-request-id + x-api-key + x-user-key (never invent keys).
 *
 * Used for rankings + other-people live portfolios + optional owner-initiated
 * copy start/close.  Scoring / follow gates live in copy-intel.ts.
 */

import { randomUUID } from "crypto";
import type { CopyLivePosition, CopyRankRow } from "./copy-intel";

export const ETORO_API_BASE = "https://public-api.etoro.com";

export interface EToroCredentials {
  apiKey: string;
  userKey: string;
}

export interface EToroRankingQuery {
  period: string;
  sort?: string;
  page?: number;
  pageSize?: number;
  popularInvestor?: boolean;
  country?: string;
  riskScoreMax?: number;
  copiersMin?: number;
}

export function etoroHeaders(creds: EToroCredentials, requestId: string = randomUUID()): Record<string, string> {
  return {
    "x-request-id": requestId,
    "x-api-key": creds.apiKey,
    "x-user-key": creds.userKey,
    Accept: "application/json"
  };
}

export function mapEToroRankItem(raw: Record<string, unknown>): CopyRankRow {
  return {
    username: String(raw.username ?? ""),
    cid: typeof raw.cid === "number" ? raw.cid : undefined,
    type: typeof raw.type === "string" ? raw.type : undefined,
    subType: typeof raw.subType === "string" ? raw.subType : null,
    gain: num(raw.gain),
    annualizedReturn: num(raw.annualizedReturn),
    riskScore: num(raw.riskScore),
    copiers: num(raw.copiers),
    winRatio: num(raw.winRatio),
    peakToValley: num(raw.peakToValley),
    profitableMonthsPct: num(raw.profitableMonthsPct),
    trades: num(raw.trades),
    copyInvestmentPct: num(raw.copyInvestmentPct),
    highLeveragePct: num(raw.highLeveragePct),
    activeWeeks: num(raw.activeWeeks),
    weeksSinceRegistration: num(raw.weeksSinceRegistration),
    country: typeof raw.country === "string" ? raw.country : null
  };
}

export function mapEToroLivePositions(raw: Record<string, unknown>): CopyLivePosition[] {
  const positions = Array.isArray(raw.positions) ? raw.positions : [];
  const out: CopyLivePosition[] = [];
  for (const item of positions) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const instrumentId = num(row.instrumentId);
    if (instrumentId == null) continue;
    out.push({
      instrumentId,
      isBuy: row.isBuy !== false,
      leverage: num(row.leverage) ?? 1,
      investmentPct: num(row.investmentPct),
      netProfit: num(row.netProfit),
      openRate: num(row.openRate),
      trailingStopLoss: row.trailingStopLoss === true
    });
  }
  return out;
}

export function rankingsUrl(query: EToroRankingQuery): string {
  const params = new URLSearchParams();
  params.set("period", query.period);
  if (query.sort) params.set("sort", query.sort);
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  if (query.popularInvestor) params.set("popularInvestor", "true");
  if (query.country) params.set("country", query.country);
  if (query.riskScoreMax != null) params.set("riskScoreMax", String(query.riskScoreMax));
  if (query.copiersMin != null) params.set("copiersMin", String(query.copiersMin));
  return `${ETORO_API_BASE}/api/v2/portfolios/rankings?${params.toString()}`;
}

export function livePortfolioUrl(username: string): string {
  return `${ETORO_API_BASE}/api/v1/user-info/people/${encodeURIComponent(username)}/portfolio/live`;
}

export function copyStartUrl(): string {
  return `${ETORO_API_BASE}/api/v1/copy-trading`;
}

async function etoroGet<T>(url: string, creds: EToroCredentials, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(url, { headers: etoroHeaders(creds) });
  if (!res.ok) {
    throw new Error(`eToro ${res.status} ${url}`);
  }
  return (await res.json()) as T;
}

export async function fetchEToroRankings(
  creds: EToroCredentials,
  query: EToroRankingQuery,
  fetchImpl: typeof fetch = fetch
): Promise<CopyRankRow[]> {
  const json = await etoroGet<{ results?: Record<string, unknown>[] }>(rankingsUrl(query), creds, fetchImpl);
  return (json.results ?? []).map(mapEToroRankItem).filter((row) => row.username);
}

export async function fetchEToroLivePortfolio(
  creds: EToroCredentials,
  username: string,
  fetchImpl: typeof fetch = fetch
): Promise<CopyLivePosition[]> {
  const json = await etoroGet<Record<string, unknown>>(livePortfolioUrl(username), creds, fetchImpl);
  return mapEToroLivePositions(json);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
