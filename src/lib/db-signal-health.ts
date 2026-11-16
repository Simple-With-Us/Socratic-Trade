// db-signal-health.ts — CRUD for the live signal-health monitor (r2 lesson: health).
// Schema lives in db.ts migrate() (versioned migration 74). The daily signal-health-refresh lane
// (src/lib/signal-health.ts) joins socratic decision cases' confidenceScore with their matured
// outcome returns and persists one snapshot row per (user, UTC day, horizon): rank IC + t-stat,
// quantile buckets, top-K churn, gross vs net-of-cost. A row is written ONLY when the observation
// floor is met — never a fabricated diagnostic. Advisory observability; the opt-in auto-throttle
// (policy.tuning.signalHealthAutoThrottle) is the only consumer that touches sizing.
import "server-only";
import { getDb } from "./db";

/** Per-quantile outcome stats — mirrors CongressQuantileStat (congress-score-eval.ts) so the two
 * signal diagnostics read the same way. */
export interface SignalHealthQuantileBucket {
  bucket: number;
  n: number;
  avgReturn: number;
  hitRate: number;
}

export interface SignalHealthSnapshotRow {
  userId: string;
  /** UTC date (YYYY-MM-DD) the snapshot was computed on. */
  periodEnd: string;
  /** Outcome horizon the observations matured at ('1d' | '1w'). */
  horizon: string;
  /** Pooled Spearman rank IC of confidenceScore vs side-adjusted outcome returnPct. */
  rankIC: number;
  tStat: number;
  nObservations: number;
  nDates: number;
  quantileBuckets: SignalHealthQuantileBucket[];
  /** Mean Jaccard DISTANCE (%) between consecutive-day top-K decision sets; undefined < 2 days. */
  topKChurnPct?: number;
  /** Mean side-adjusted outcome return (%) across observations. */
  grossReturnPct: number;
  /** grossReturnPct minus the round-trip cost estimate (backtest.ts cost convention). */
  netOfCostReturnPct: number;
  /** OLS slope of the rolling rank-IC series ending at this row; undefined on the first window. */
  rollingRankICSlope?: number;
  createdAt: string;
}

/** Minimal decision projection the observation builder needs (confidence + matured horizons). */
export interface SignalHealthDecisionRow {
  id: string;
  symbol: string | null;
  side: string | null;
  confidenceScore: number;
  createdAt: string;
  outcomes: Array<{ horizon: string; returnPct?: number; resolution: string }>;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Decision cases usable as signal-health observations: a recorded confidenceScore plus a matured
 * (terminal, non-'unresolvable') outcome. Horizon-level filtering (resolution === 'ok', finite
 * returnPct) happens in the lane — this just bounds the scan. Newest first.
 */
/** Trailing observation window: signal health is a ROLLING diagnostic — pooling all history
 *  makes the daily rank IC ever less responsive as n grows, defeating the drift detector. */
const SIGNAL_HEALTH_WINDOW_DAYS = 90;

export function listSignalHealthDecisionRows(
  userId: string = "local",
  opts: { limit?: number; windowDays?: number; now?: number } = {}
): SignalHealthDecisionRow[] {
  const limit = Math.max(1, Math.min(5000, Math.floor(opts.limit ?? 2000)));
  const windowDays = Math.max(1, Math.floor(opts.windowDays ?? SIGNAL_HEALTH_WINDOW_DAYS));
  // Window is relative to the refresh clock (opts.now), not wall-clock Date.now().
  // Tests inject a fixed `now`; production passes the lane's now. Using wall clock here
  // dropped hard-coded Aug-2026 fixtures once real calendar day crossed the 90d edge (CI 2026-11-06).
  const cutoffIso = new Date((opts.now ?? Date.now()) - windowDays * 86_400_000).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT id, symbol, side, confidence_score, created_at, outcome
       FROM socratic_decisions
       WHERE user_id = ?
         AND confidence_score IS NOT NULL
         AND created_at >= ?
         AND json_extract(outcome, '$.status') IN ('won', 'lost', 'flat', 'unknown')
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(userId, cutoffIso, limit) as Array<{
    id: string;
    symbol: string | null;
    side: string | null;
    confidence_score: number;
    created_at: string;
    outcome: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    confidenceScore: row.confidence_score,
    createdAt: row.created_at,
    outcomes: parseJson<{ outcomes?: SignalHealthDecisionRow["outcomes"] }>(row.outcome, {}).outcomes ?? []
  }));
}

/** Idempotent per-(user, day, horizon) write — a re-run within the same UTC day overwrites. */
export function upsertSignalHealthSnapshot(
  row: Omit<SignalHealthSnapshotRow, "createdAt">,
  now: string = new Date().toISOString()
): void {
  getDb()
    .prepare(
      `INSERT INTO signal_health_snapshot (
         user_id, period_end, horizon, rank_ic, t_stat, n_observations, n_dates,
         quantile_buckets, top_k_churn_pct, gross_return_pct, net_of_cost_return_pct,
         rolling_rank_ic_slope, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, period_end, horizon) DO UPDATE SET
         rank_ic = excluded.rank_ic,
         t_stat = excluded.t_stat,
         n_observations = excluded.n_observations,
         n_dates = excluded.n_dates,
         quantile_buckets = excluded.quantile_buckets,
         top_k_churn_pct = excluded.top_k_churn_pct,
         gross_return_pct = excluded.gross_return_pct,
         net_of_cost_return_pct = excluded.net_of_cost_return_pct,
         rolling_rank_ic_slope = excluded.rolling_rank_ic_slope,
         created_at = excluded.created_at`
    )
    .run(
      row.userId,
      row.periodEnd,
      row.horizon,
      row.rankIC,
      row.tStat,
      row.nObservations,
      row.nDates,
      JSON.stringify(row.quantileBuckets),
      row.topKChurnPct ?? null,
      row.grossReturnPct,
      row.netOfCostReturnPct,
      row.rollingRankICSlope ?? null,
      now
    );
}

/** Snapshots for one horizon, newest first (the rolling-slope/drift window read). */
export function listSignalHealthSnapshots(
  userId: string = "local",
  opts: { horizon: string; limit?: number }
): SignalHealthSnapshotRow[] {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 30)));
  const rows = getDb()
    .prepare(
      `SELECT user_id, period_end, horizon, rank_ic, t_stat, n_observations, n_dates,
              quantile_buckets, top_k_churn_pct, gross_return_pct, net_of_cost_return_pct,
              rolling_rank_ic_slope, created_at
       FROM signal_health_snapshot
       WHERE user_id = ? AND horizon = ?
       ORDER BY period_end DESC
       LIMIT ?`
    )
    .all(userId, opts.horizon, limit) as Array<{
    user_id: string;
    period_end: string;
    horizon: string;
    rank_ic: number;
    t_stat: number;
    n_observations: number;
    n_dates: number;
    quantile_buckets: string;
    top_k_churn_pct: number | null;
    gross_return_pct: number;
    net_of_cost_return_pct: number;
    rolling_rank_ic_slope: number | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    userId: row.user_id,
    periodEnd: row.period_end,
    horizon: row.horizon,
    rankIC: row.rank_ic,
    tStat: row.t_stat,
    nObservations: row.n_observations,
    nDates: row.n_dates,
    quantileBuckets: parseJson<SignalHealthQuantileBucket[]>(row.quantile_buckets, []),
    ...(row.top_k_churn_pct != null ? { topKChurnPct: row.top_k_churn_pct } : {}),
    grossReturnPct: row.gross_return_pct,
    netOfCostReturnPct: row.net_of_cost_return_pct,
    ...(row.rolling_rank_ic_slope != null ? { rollingRankICSlope: row.rolling_rank_ic_slope } : {}),
    createdAt: row.created_at
  }));
}
