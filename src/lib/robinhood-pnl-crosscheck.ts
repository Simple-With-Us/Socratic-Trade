import { callRobinhoodMcpTool } from "./robinhood";
import { listFillEvents } from "./db";
import { calculatePnl } from "./performance";

// Rough sanity-check tolerance. Robinhood's own realized-gain bucketing uses its own
// timezone, wash-sale, and asset-class rules that will never line up exactly with this
// app's FIFO lot accounting, so this is a "same ballpark" alarm, not a reconciliation.
const TOLERANCE_PCT = 5;

export interface RealizedPnlCrossCheck {
  appRealizedPnl: number;
  robinhoodRealizedPnl: number | undefined;
  discrepancyAbs: number | undefined;
  discrepancyPct: number | undefined;
  withinTolerance: boolean | undefined;
}

/**
 * Independent sanity check of this app's own realized P&L against Robinhood's bucketed
 * `get_realized_pnl` for the same account. Read-only diagnostic — never places or reconciles.
 *
 * The app number is live equity realized P&L over the same requested span (Robinhood is
 * a real broker, so its fills are `live`). When Robinhood isn't connected or the call
 * fails, the Robinhood/discrepancy fields come back undefined rather than throwing.
 */
export async function crossCheckRealizedPnl(
  userId: string,
  accountNumber: string,
  opts?: { span?: string; now?: Date | string }
): Promise<RealizedPnlCrossCheck> {
  const span = opts?.span ?? "3month";
  const appRealizedPnl = calculateAppRealizedPnl(userId, accountNumber, span, opts?.now);

  let robinhoodRealizedPnl: number | undefined;
  try {
    const raw = await callRobinhoodMcpTool(userId, "get_realized_pnl", {
      account_number: accountNumber,
      span
    });
    robinhoodRealizedPnl = parseRealizedPnl(raw);
  } catch {
    robinhoodRealizedPnl = undefined;
  }

  if (robinhoodRealizedPnl === undefined) {
    return { appRealizedPnl, robinhoodRealizedPnl: undefined, discrepancyAbs: undefined, discrepancyPct: undefined, withinTolerance: undefined };
  }

  const discrepancyAbs = Math.abs(appRealizedPnl - robinhoodRealizedPnl);
  // Percent is relative to Robinhood's figure (the independent reference). When it's ~0, fall
  // back to an absolute-only check so a tiny reference doesn't blow the percentage up to Infinity.
  const denom = Math.abs(robinhoodRealizedPnl);
  const discrepancyPct = denom > 1e-9 ? (discrepancyAbs / denom) * 100 : undefined;
  const withinTolerance = discrepancyPct !== undefined ? discrepancyPct <= TOLERANCE_PCT : discrepancyAbs <= 1e-9;

  return { appRealizedPnl, robinhoodRealizedPnl, discrepancyAbs, discrepancyPct, withinTolerance };
}

function calculateAppRealizedPnl(userId: string, accountNumber: string, span: string, nowInput?: Date | string): number {
  const liveFills = listFillEvents(accountNumber, "live", undefined, userId);
  const closedLots = calculatePnl(liveFills).closedLots;
  const start = spanStart(span, nowInput);
  const inSpan = start ? closedLots.filter((lot) => lot.exitAt !== undefined && lot.exitAt >= start) : closedLots;
  return inSpan.reduce((sum, lot) => sum + lot.pnl, 0);
}

function spanStart(span: string, nowInput?: Date | string): string | undefined {
  const normalized = span.trim().toLowerCase();
  if (["all", "alltime", "all_time", "max"].includes(normalized)) return undefined;
  const now = nowInput instanceof Date ? new Date(nowInput) : nowInput ? new Date(nowInput) : new Date();
  if (!Number.isFinite(now.getTime())) return undefined;

  if (["day", "1d"].includes(normalized)) now.setUTCDate(now.getUTCDate() - 1);
  else if (["week", "1w"].includes(normalized)) now.setUTCDate(now.getUTCDate() - 7);
  else if (["month", "1m"].includes(normalized)) now.setUTCMonth(now.getUTCMonth() - 1);
  else if (["3month", "3m", "quarter"].includes(normalized)) now.setUTCMonth(now.getUTCMonth() - 3);
  else if (["year", "1y"].includes(normalized)) now.setUTCFullYear(now.getUTCFullYear() - 1);
  else if (["5year", "5y"].includes(normalized)) now.setUTCFullYear(now.getUTCFullYear() - 5);
  else return undefined;

  return now.toISOString();
}

// Robinhood's get_realized_pnl bucketing keys vary; pull the realized gain defensively.
function parseRealizedPnl(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;

  // Some shapes return per-bucket rows; prefer an equity-only bucket sum when possible so
  // options/crypto realized P&L does not pollute the app's equity-only ledger.
  const buckets = Array.isArray(row.results) ? row.results : Array.isArray(row.buckets) ? row.buckets : undefined;
  if (buckets) {
    let sum = 0;
    let matched = false;
    for (const entry of buckets) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const bucket = entry as Record<string, unknown>;
      if (!isEquityBucket(bucket)) continue;
      const value = firstMoney(bucket, ["realized_pnl", "realizedPnl", "realized_gain", "realizedGain", "pnl", "gain"]);
      if (value !== undefined) {
        sum += value;
        matched = true;
      }
    }
    if (matched) return sum;
  }

  const direct = firstMoney(row, [
    "total_realized_pnl",
    "totalRealizedPnl",
    "realized_pnl",
    "realizedPnl",
    "total_realized_gain",
    "totalRealizedGain",
    "realized_gain",
    "realizedGain",
    "total"
  ]);
  if (direct !== undefined) return direct;
  return undefined;
}

function isEquityBucket(row: Record<string, unknown>): boolean {
  const raw = row.asset_class ?? row.assetClass ?? row.asset_type ?? row.assetType ?? row.instrument_type ?? row.instrumentType ?? row.type;
  if (raw === null || raw === undefined || raw === "") return true;
  const value = String(raw).trim().toLowerCase();
  return ["equity", "equities", "stock", "stocks"].includes(value);
}

function firstMoney(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
