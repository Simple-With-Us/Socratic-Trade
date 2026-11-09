/**
 * CFTC Commitment of Traders — weekly futures positioning (free, no API key; an optional
 * Socrata app token raises rate limits). We read the E-mini S&P 500 contract from the legacy
 * futures-only report and surface large-speculator ("non-commercial") net positioning, which
 * the agent can read as a crowd/sentiment gauge (extreme net-long = complacency risk; extreme
 * net-short can precede squeezes). Market-wide, weekly — not per-symbol.
 */

const CFTC_URL = "https://publicreporting.cftc.gov/resource/6dca-aqww.json";
const SP_CONTRACT = "E-MINI S&P 500"; // exact contract_market_name (excludes MICRO E-MINI)

export interface CotSummary {
  contract: string;
  reportDate?: string;
  /** Non-commercial (large speculators) net contracts: long − short. + = net long. */
  nonCommNet?: number;
  /** Commercial (hedgers) net contracts: long − short. */
  commNet?: number;
  /** Non-commercial net as a % of total open interest. */
  nonCommNetPctOI?: number;
  openInterest?: number;
}

/** Reduce a raw CFTC legacy-report row to a net-positioning summary. Pure. */
export function summarizeCotRow(row: Record<string, unknown>): CotSummary {
  const num = (v: unknown): number => Number(v);
  const ncLong = num(row.noncomm_positions_long_all);
  const ncShort = num(row.noncomm_positions_short_all);
  const cLong = num(row.comm_positions_long_all);
  const cShort = num(row.comm_positions_short_all);
  const oi = num(row.open_interest_all);
  const nonCommNet = Number.isFinite(ncLong) && Number.isFinite(ncShort) ? ncLong - ncShort : undefined;
  const commNet = Number.isFinite(cLong) && Number.isFinite(cShort) ? cLong - cShort : undefined;
  const reportDate = typeof row.report_date_as_yyyy_mm_dd === "string" ? row.report_date_as_yyyy_mm_dd.slice(0, 10) : undefined;
  return {
    contract: typeof row.contract_market_name === "string" ? row.contract_market_name : SP_CONTRACT,
    reportDate,
    nonCommNet,
    commNet,
    nonCommNetPctOI: nonCommNet !== undefined && Number.isFinite(oi) && oi > 0 ? Math.round((nonCommNet / oi) * 1000) / 10 : undefined,
    openInterest: Number.isFinite(oi) ? oi : undefined
  };
}

export async function fetchCftcSpPositioning(appToken?: string): Promise<CotSummary | undefined> {
  const params = new URLSearchParams({
    $where: `contract_market_name='${SP_CONTRACT}'`,
    $order: "report_date_as_yyyy_mm_dd DESC",
    $limit: "1"
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${CFTC_URL}?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: appToken ? { "X-App-Token": appToken } : undefined
    });
    clearTimeout(timeout);
    if (!res.ok) return undefined;
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) return undefined;
    return summarizeCotRow(rows[0]);
  } catch {
    clearTimeout(timeout);
    return undefined;
  }
}
