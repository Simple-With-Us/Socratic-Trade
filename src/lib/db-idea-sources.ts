// 13F / ARK / CUSIP map persistence (migration 83).
import "server-only";
import { getDb } from "./db";

export interface ThirteenFHoldingRow {
  id: string;
  filerCik: string;
  filerName: string;
  periodEnd: string;
  accession: string;
  cusip: string;
  ticker: string;
  issuerName: string;
  titleOfClass: string;
  shares: number;
  valueUsd: number;
  sshPrnType: string;
  fetchedAt: string;
}

export interface ArkHoldingRow {
  id: string;
  asOf: string;
  fund: string;
  ticker: string;
  company: string;
  cusip: string;
  shares: number;
  marketValueUsd: number;
  weightPct: number;
  fetchedAt: string;
}

export function lookupTickerByCusip(cusip: string): string | undefined {
  const key = cusip.trim().toUpperCase();
  if (!key) return undefined;
  const row = getDb()
    .prepare("SELECT ticker FROM cusip_ticker_map WHERE cusip = ?")
    .get(key) as { ticker: string } | undefined;
  return row?.ticker;
}

export function upsertCusipTicker(cusip: string, ticker: string, source: string, nowIso: string): void {
  const c = cusip.trim().toUpperCase();
  const t = ticker.trim().toUpperCase();
  if (!c || !t) return;
  getDb()
    .prepare(
      `INSERT INTO cusip_ticker_map (cusip, ticker, source, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(cusip) DO UPDATE SET ticker = excluded.ticker, source = excluded.source, updated_at = excluded.updated_at`
    )
    .run(c, t, source, nowIso);
}

export function replaceThirteenFFiling(rows: ThirteenFHoldingRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const filer = rows[0].filerCik;
  const period = rows[0].periodEnd;
  const insert = db.prepare(
    `INSERT OR REPLACE INTO sec_13f_holdings (
      id, filer_cik, filer_name, period_end, accession, cusip, ticker, issuer_name,
      title_of_class, shares, value_usd, ssh_prn_type, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    db.prepare("DELETE FROM sec_13f_holdings WHERE filer_cik = ? AND period_end = ?").run(filer, period);
    for (const r of rows) {
      insert.run(
        r.id,
        r.filerCik,
        r.filerName,
        r.periodEnd,
        r.accession,
        r.cusip,
        r.ticker,
        r.issuerName,
        r.titleOfClass,
        r.shares,
        r.valueUsd,
        r.sshPrnType,
        r.fetchedAt
      );
    }
  })();
}

export function listThirteenFHoldingsForTicker(ticker: string, limit = 40): ThirteenFHoldingRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, filer_cik, filer_name, period_end, accession, cusip, ticker, issuer_name,
              title_of_class, shares, value_usd, ssh_prn_type, fetched_at
       FROM sec_13f_holdings
       WHERE ticker = ?
       ORDER BY period_end DESC, value_usd DESC
       LIMIT ?`
    )
    .all(ticker.trim().toUpperCase(), limit) as Array<Record<string, string | number>>;
  return rows.map(rowTo13f);
}

export function listLatestThirteenFPeriodByFiler(): Array<{ filerCik: string; periodEnd: string }> {
  return getDb()
    .prepare(
      `SELECT filer_cik AS filerCik, MAX(period_end) AS periodEnd
       FROM sec_13f_holdings
       GROUP BY filer_cik`
    )
    .all() as Array<{ filerCik: string; periodEnd: string }>;
}

export function listThirteenFHoldingsForFilerPeriod(filerCik: string, periodEnd: string): ThirteenFHoldingRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, filer_cik, filer_name, period_end, accession, cusip, ticker, issuer_name,
              title_of_class, shares, value_usd, ssh_prn_type, fetched_at
       FROM sec_13f_holdings
       WHERE filer_cik = ? AND period_end = ?`
    )
    .all(filerCik, periodEnd) as Array<Record<string, string | number>>;
  return rows.map(rowTo13f);
}

export function countThirteenFHoldings(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM sec_13f_holdings").get() as { n: number };
  return row.n;
}

/** Drop accession-CIK leftovers after a filer is re-ingested with a real quarter-end. */
export function purgeInvalidThirteenFPeriods(filerCik: string): number {
  const info = getDb()
    .prepare(
      `DELETE FROM sec_13f_holdings
       WHERE filer_cik = ?
         AND period_end NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`
    )
    .run(filerCik);
  return info.changes;
}

export function replaceArkFundDay(rows: ArkHoldingRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const fund = rows[0].fund;
  const asOf = rows[0].asOf;
  const insert = db.prepare(
    `INSERT OR REPLACE INTO ark_holdings (
      id, as_of, fund, ticker, company, cusip, shares, market_value_usd, weight_pct, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    db.prepare("DELETE FROM ark_holdings WHERE fund = ? AND as_of = ?").run(fund, asOf);
    for (const r of rows) {
      insert.run(
        r.id,
        r.asOf,
        r.fund,
        r.ticker,
        r.company,
        r.cusip,
        r.shares,
        r.marketValueUsd,
        r.weightPct,
        r.fetchedAt
      );
    }
  })();
}

export function listArkHoldingsForTicker(ticker: string, limit = 24): ArkHoldingRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, as_of, fund, ticker, company, cusip, shares, market_value_usd, weight_pct, fetched_at
       FROM ark_holdings
       WHERE ticker = ?
       ORDER BY as_of DESC, weight_pct DESC
       LIMIT ?`
    )
    .all(ticker.trim().toUpperCase(), limit) as Array<Record<string, string | number>>;
  return rows.map(rowToArk);
}

export function listArkHoldingsForFundAsOf(fund: string, asOf: string): ArkHoldingRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, as_of, fund, ticker, company, cusip, shares, market_value_usd, weight_pct, fetched_at
       FROM ark_holdings
       WHERE fund = ? AND as_of = ?`
    )
    .all(fund, asOf) as Array<Record<string, string | number>>;
  return rows.map(rowToArk);
}

export function listLatestArkAsOfByFund(): Array<{ fund: string; asOf: string }> {
  return getDb()
    .prepare(
      `SELECT fund, MAX(as_of) AS asOf FROM ark_holdings GROUP BY fund`
    )
    .all() as Array<{ fund: string; asOf: string }>;
}

export function countArkHoldings(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM ark_holdings").get() as { n: number };
  return row.n;
}

export function listRecentThirteenFChanges(limit = 16): ThirteenFHoldingRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, filer_cik, filer_name, period_end, accession, cusip, ticker, issuer_name,
              title_of_class, shares, value_usd, ssh_prn_type, fetched_at
       FROM sec_13f_holdings
       WHERE ticker != ''
       ORDER BY period_end DESC, value_usd DESC
       LIMIT ?`
    )
    .all(limit) as Array<Record<string, string | number>>;
  return rows.map(rowTo13f);
}

export function listRecentArkHoldings(limit = 16): ArkHoldingRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, as_of, fund, ticker, company, cusip, shares, market_value_usd, weight_pct, fetched_at
       FROM ark_holdings
       ORDER BY as_of DESC, weight_pct DESC
       LIMIT ?`
    )
    .all(limit) as Array<Record<string, string | number>>;
  return rows.map(rowToArk);
}

function rowTo13f(row: Record<string, string | number>): ThirteenFHoldingRow {
  return {
    id: String(row.id),
    filerCik: String(row.filer_cik),
    filerName: String(row.filer_name),
    periodEnd: String(row.period_end),
    accession: String(row.accession),
    cusip: String(row.cusip),
    ticker: String(row.ticker),
    issuerName: String(row.issuer_name),
    titleOfClass: String(row.title_of_class),
    shares: Number(row.shares),
    valueUsd: Number(row.value_usd),
    sshPrnType: String(row.ssh_prn_type),
    fetchedAt: String(row.fetched_at)
  };
}

function rowToArk(row: Record<string, string | number>): ArkHoldingRow {
  return {
    id: String(row.id),
    asOf: String(row.as_of),
    fund: String(row.fund),
    ticker: String(row.ticker),
    company: String(row.company),
    cusip: String(row.cusip),
    shares: Number(row.shares),
    marketValueUsd: Number(row.market_value_usd),
    weightPct: Number(row.weight_pct),
    fetchedAt: String(row.fetched_at)
  };
}
