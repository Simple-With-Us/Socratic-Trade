// signal-health.ts — live signal-health monitor (r2 lesson: health, qlib/freqtrade playbook).
//
// Pure-arithmetic rolling diagnostics of the LLM's OWN confidenceScore against matured decision
// outcomes: pooled Spearman rank IC + t-stat, score-quantile outcome buckets, consecutive-day
// top-K churn (Jaccard distance), and gross-vs-net-of-cost returns — persisted daily as
// signal_health_snapshot rows (db-signal-health.ts) so signal decay is visible weeks before the
// equity curve shows it. The write side already exists: every decision case records its
// confidenceScore (socratic_decisions) and the outcome engine matures it into side-adjusted
// multi-horizon returns (outcome-engine.ts). SQLite-only; no provider or LLM calls.
//
// Honest floors: a horizon below SIGNAL_HEALTH_MIN_OBSERVATIONS writes NO snapshot row — never a
// fabricated diagnostic. Drift (detectDrift: N consecutive declining windows OR a negative rolling
// slope over enough windows) raises an advisory alarm (audit + signal_health notification). The
// opt-in auto-throttle (policy.tuning.signalHealthAutoThrottle, default OFF) is the ONLY sizing
// consumer: while an alarm is active it caps conviction upside in strategy-risk.ts with a
// dataAdjustments receipt; off, the alarm only notifies/logs.
import { spearmanRankIC } from "./backtest";
import {
  listSignalHealthDecisionRows,
  listSignalHealthSnapshots,
  upsertSignalHealthSnapshot,
  type SignalHealthDecisionRow,
  type SignalHealthQuantileBucket
} from "./db-signal-health";
import { getInternalSetting, setInternalSetting } from "./db-settings";
import { marketDateOf } from "./market-calendar";

/** Minimum matured (score, return) pairs before a horizon writes any snapshot row. */
export const SIGNAL_HEALTH_MIN_OBSERVATIONS = 20;
/** Outcome horizons the monitor snapshots (daily lane; intraday horizons are too noisy here). */
export const SIGNAL_HEALTH_HORIZONS = ["1d", "1w"] as const;
/** Round-trip transaction cost estimate in bps — mirrors backtest.ts's OOS default (10 bps/leg). */
export const SIGNAL_HEALTH_COST_ROUND_TRIP_BPS = 20;
/** Top-K decision set size for the consecutive-day churn diagnostic. */
export const SIGNAL_HEALTH_TOP_K = 3;
const QUANTILE_COUNT = 5;
/** Rolling rank-IC window (snapshots, incl. the one being written) for slope + drift detection. */
const SLOPE_WINDOW = 8;

const LAST_RUN_KEY_PREFIX = "signal_health:lastRunDate";
const DRIFT_STATE_KEY_PREFIX = "signal_health:drift";

/** One matured (confidence, outcome) pair. `returnPct` is the outcome engine's side-adjusted % —
 * positive means the decided direction worked, whatever the side was. */
export interface SignalHealthObservation {
  date: string;
  symbol: string;
  score: number;
  returnPct: number;
}

export interface SignalHealthRankIC {
  rankIC: number;
  tStat: number;
  nObservations: number;
  nDates: number;
}

export interface SignalHealthDriftResult {
  drifting: boolean;
  /** Trailing strictly-declining steps at the end of the series. */
  trailingDeclines: number;
  /** OLS slope of the series (per window); undefined when the series has < 2 points. */
  slope?: number;
  reasons: string[];
}

interface DriftState {
  active: boolean;
  horizon: string;
  detectedAt?: string;
  rankIC?: number;
  slope?: number;
  trailingDeclines?: number;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Pooled tie-corrected Spearman rank IC of confidenceScore vs matured return, with the standard
 * t = r·sqrt((n−2)/(1−r²)) significance stat (denominator floored so a perfectly monotone sample
 * stays finite). Undefined below 3 observations or when either side has zero rank variance.
 * Pooled (not per-date like congress-score-eval): decision volume is a handful per day, so a
 * per-date IC would almost never clear a names-per-date gate.
 */
export function computeRankIC(observations: SignalHealthObservation[]): SignalHealthRankIC | undefined {
  if (observations.length < 3) return undefined;
  const ic = spearmanRankIC(
    observations.map((obs) => obs.score),
    observations.map((obs) => obs.returnPct)
  );
  if (ic === undefined) return undefined;
  const n = observations.length;
  const denom = Math.max(1e-9, 1 - ic * ic);
  return {
    rankIC: round6(ic),
    tStat: round6(ic * Math.sqrt((n - 2) / denom)),
    nObservations: n,
    nDates: new Set(observations.map((obs) => obs.date)).size
  };
}

/** Pooled score-quantile outcome buckets (bucket 1 = lowest confidence), mirroring
 * CongressQuantileStat's shape. A healthy signal shows avgReturn/hitRate rising with the bucket. */
export function computeQuantileBuckets(
  observations: SignalHealthObservation[],
  quantiles: number = QUANTILE_COUNT
): SignalHealthQuantileBucket[] {
  const q = Math.max(2, Math.min(20, Math.floor(quantiles)));
  const buckets = Array.from({ length: q }, (_, i) => ({ bucket: i + 1, returns: [] as number[] }));
  const sorted = [...observations].sort((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol));
  sorted.forEach((obs, i) => {
    const bucket = Math.min(q - 1, Math.floor((i * q) / sorted.length));
    buckets[bucket].returns.push(obs.returnPct);
  });
  return buckets.map((bucket) => ({
    bucket: bucket.bucket,
    n: bucket.returns.length,
    avgReturn: bucket.returns.length ? round6(mean(bucket.returns)) : 0,
    hitRate: bucket.returns.length ? round6(bucket.returns.filter((r) => r > 0).length / bucket.returns.length) : 0
  }));
}

/**
 * Mean Jaccard DISTANCE (%) between consecutive-day top-K decision sets ranked by confidenceScore
 * (score ties broken by symbol for determinism). High churn = the signal reshuffles its favorites
 * daily — conviction that flips names that fast is noise, not thesis. Undefined with < 2 distinct
 * dates (no consecutive pair to compare — never fabricated).
 */
export function computeTopKChurn(
  observations: SignalHealthObservation[],
  k: number = SIGNAL_HEALTH_TOP_K
): number | undefined {
  const byDate = new Map<string, SignalHealthObservation[]>();
  for (const obs of observations) {
    const bucket = byDate.get(obs.date);
    if (bucket) bucket.push(obs);
    else byDate.set(obs.date, [obs]);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return undefined;
  const topSets = dates.map((date) => {
    const ranked = [...(byDate.get(date) ?? [])].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    return new Set(ranked.slice(0, Math.max(1, k)).map((obs) => obs.symbol));
  });
  const distances: number[] = [];
  for (let i = 1; i < topSets.length; i++) {
    const prev = topSets[i - 1];
    const curr = topSets[i];
    const union = new Set([...prev, ...curr]);
    if (union.size === 0) continue;
    let intersection = 0;
    for (const symbol of prev) if (curr.has(symbol)) intersection += 1;
    distances.push(1 - intersection / union.size);
  }
  if (distances.length === 0) return undefined;
  return round6(mean(distances) * 100);
}

/** Mean gross return (%) and the net after debiting the round-trip cost estimate from every
 * observation — backtest.ts's cost convention (cost always debited; the tax leg is deliberately
 * not modeled here, this is a cost estimate, not an after-tax projection). */
export function pairGrossNet(
  observations: SignalHealthObservation[],
  costRoundTripBps: number = SIGNAL_HEALTH_COST_ROUND_TRIP_BPS
): { grossReturnPct: number; netOfCostReturnPct: number } {
  const costPct = costRoundTripBps / 100;
  const gross = observations.length ? mean(observations.map((obs) => obs.returnPct)) : 0;
  return { grossReturnPct: round6(gross), netOfCostReturnPct: round6(gross - costPct) };
}

/** OLS slope of `values` against index 0..n−1 (per-window units); undefined below 2 points. */
export function olsSlope(values: number[]): number | undefined {
  const n = values.length;
  if (n < 2) return undefined;
  const mx = (n - 1) / 2;
  const my = mean(values);
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (i - mx) * (values[i] - my);
    vx += (i - mx) * (i - mx);
  }
  return vx > 0 ? cov / vx : undefined;
}

/**
 * Drift detector over the chronological rolling rank-IC series (oldest → newest): fires on
 * `consecutiveDeclines` strictly-declining trailing steps OR a negative OLS slope once the series
 * spans at least `minWindows` snapshots. Deliberately simple pure arithmetic — unit-tested, no
 * smoothing, no model.
 */
export function detectDrift(
  series: number[],
  options: { consecutiveDeclines?: number; minWindows?: number } = {}
): SignalHealthDriftResult {
  const declinesNeeded = Math.max(1, Math.floor(options.consecutiveDeclines ?? 3));
  const minWindows = Math.max(2, Math.floor(options.minWindows ?? 5));
  let trailingDeclines = 0;
  for (let i = series.length - 1; i > 0; i--) {
    if (series[i] < series[i - 1]) trailingDeclines += 1;
    else break;
  }
  const slope = olsSlope(series);
  const reasons: string[] = [];
  if (trailingDeclines >= declinesNeeded) {
    reasons.push(`rank IC declined ${trailingDeclines} consecutive windows (>= ${declinesNeeded})`);
  }
  if (series.length >= minWindows && slope !== undefined && slope < 0) {
    reasons.push(`rolling rank-IC slope ${round6(slope)}/window is negative over ${series.length} windows`);
  }
  return {
    drifting: reasons.length > 0,
    trailingDeclines,
    ...(slope !== undefined ? { slope: round6(slope) } : {}),
    reasons
  };
}

/** Matured observations for one horizon from the decision rows: finite confidenceScore joined with
 * that horizon's resolution === 'ok' side-adjusted returnPct. Missing pieces drop the row — no
 * observation is ever synthesized. Date is the decision's market day (after-hours decisions stay
 * on their ET session). */
export function buildSignalHealthObservations(
  rows: SignalHealthDecisionRow[],
  horizon: string
): SignalHealthObservation[] {
  const observations: SignalHealthObservation[] = [];
  for (const row of rows) {
    if (!Number.isFinite(row.confidenceScore)) continue;
    const outcome = row.outcomes.find(
      (o) => o.horizon === horizon && o.resolution === "ok" && typeof o.returnPct === "number" && Number.isFinite(o.returnPct)
    );
    if (!outcome) continue;
    const date = marketDateOf(row.createdAt) ?? row.createdAt.slice(0, 10);
    observations.push({
      date,
      symbol: (row.symbol ?? "").toUpperCase() || row.id,
      score: row.confidenceScore,
      returnPct: outcome.returnPct as number
    });
  }
  return observations;
}

export interface SignalHealthRefreshResult {
  horizons: Array<{
    horizon: string;
    observations: number;
    /** False = below the observation floor; no row was written. */
    written: boolean;
    drifting: boolean;
  }>;
}

function driftStateKey(userId: string, horizon: string): string {
  return `${DRIFT_STATE_KEY_PREFIX}:${userId}:${horizon}`;
}

/**
 * The daily refresh pass: per horizon, build matured observations, persist the snapshot row (only
 * at/above the observation floor), and run drift detection over the rolling rank-IC series. Alarm
 * transitions are edge-triggered on the persisted drift state — a NEW alarm audits + notifies
 * once; a persisting alarm just updates its receipts; a recovery clears the state with an audit.
 * Below the floor the existing drift state is left untouched — no new evidence either way.
 */
export async function runSignalHealthRefresh(
  userId: string = "local",
  opts: { now?: number } = {}
): Promise<SignalHealthRefreshResult> {
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const periodEnd = utcDate(now);
  const rows = listSignalHealthDecisionRows(userId);
  const result: SignalHealthRefreshResult = { horizons: [] };
  const newAlarms: DriftState[] = [];

  for (const horizon of SIGNAL_HEALTH_HORIZONS) {
    const observations = buildSignalHealthObservations(rows, horizon);
    if (observations.length < SIGNAL_HEALTH_MIN_OBSERVATIONS) {
      result.horizons.push({ horizon, observations: observations.length, written: false, drifting: false });
      continue;
    }
    const rank = computeRankIC(observations);
    if (!rank) {
      // Zero rank variance (e.g. every score identical) — nothing honest to snapshot.
      result.horizons.push({ horizon, observations: observations.length, written: false, drifting: false });
      continue;
    }
    // Rolling series: prior snapshots (excluding any earlier same-day row this write replaces),
    // oldest first, ending at today's value.
    const prior = listSignalHealthSnapshots(userId, { horizon, limit: SLOPE_WINDOW })
      .filter((snap) => snap.periodEnd !== periodEnd)
      .slice(0, SLOPE_WINDOW - 1);
    const series = [...prior.map((snap) => snap.rankIC).reverse(), rank.rankIC];
    const slope = olsSlope(series);
    const { grossReturnPct, netOfCostReturnPct } = pairGrossNet(observations);
    const topKChurnPct = computeTopKChurn(observations);
    upsertSignalHealthSnapshot(
      {
        userId,
        periodEnd,
        horizon,
        rankIC: rank.rankIC,
        tStat: rank.tStat,
        nObservations: rank.nObservations,
        nDates: rank.nDates,
        quantileBuckets: computeQuantileBuckets(observations),
        ...(topKChurnPct !== undefined ? { topKChurnPct } : {}),
        grossReturnPct,
        netOfCostReturnPct,
        ...(slope !== undefined ? { rollingRankICSlope: round6(slope) } : {})
      },
      nowIso
    );

    const drift = detectDrift(series);
    const key = driftStateKey(userId, horizon);
    const previous = getInternalSetting<DriftState>(key);
    if (drift.drifting) {
      const state: DriftState = {
        active: true,
        horizon,
        detectedAt: previous?.active ? previous.detectedAt ?? nowIso : nowIso,
        rankIC: rank.rankIC,
        ...(drift.slope !== undefined ? { slope: drift.slope } : {}),
        trailingDeclines: drift.trailingDeclines
      };
      setInternalSetting(key, state);
      if (!previous?.active) {
        newAlarms.push(state);
        const { audit } = await import("./db");
        audit(
          "signal_health_drift",
          { horizon, rankIC: rank.rankIC, slope: drift.slope, trailingDeclines: drift.trailingDeclines, reasons: drift.reasons, windows: series.length, nObservations: rank.nObservations },
          userId
        );
      }
    } else if (previous?.active) {
      setInternalSetting(key, { active: false, horizon });
      const { audit } = await import("./db");
      audit("signal_health_drift_cleared", { horizon, rankIC: rank.rankIC, slope: drift.slope, windows: series.length }, userId);
    }
    result.horizons.push({ horizon, observations: observations.length, written: true, drifting: drift.drifting });
  }

  if (newAlarms.length > 0) {
    await notifyDriftAlarms(userId, newAlarms).catch((err) =>
      console.warn(`[signal-health] drift notification failed for ${userId}:`, err instanceof Error ? err.message : String(err))
    );
  }
  return result;
}

/** One batched advisory notification for the pass's NEW alarms. enabledEvents gating is real
 * (owner ruling 2026-08-12: no toggle is silently overridden) — a persisted policy that predated
 * the signal_health event type got it backfilled once by the db migration
 * (backfillDefaultOnNotificationEvents in db.ts), not force-included per send. ntfy titles are
 * raw HTTP header values — ASCII only. */
async function notifyDriftAlarms(userId: string, alarms: DriftState[]): Promise<void> {
  const { sendNotification } = await import("./notifications");
  const { getPolicy } = await import("./db");
  const policy = getPolicy(userId);
  const horizons = alarms.map((alarm) => alarm.horizon).join(", ");
  const throttleOn = policy.tuning?.signalHealthAutoThrottle === true;
  const detail = alarms
    .map(
      (alarm) =>
        `${alarm.horizon}: rank IC ${alarm.rankIC?.toFixed(3) ?? "n/a"}${alarm.slope !== undefined ? `, slope ${alarm.slope.toFixed(4)}/window` : ""}${alarm.trailingDeclines ? `, ${alarm.trailingDeclines} declining windows` : ""}`
    )
    .join("; ");
  const body =
    `The AI's confidence signal is losing predictive power against matured outcomes (${detail}).  ` +
    (throttleOn
      ? "The signal-health auto-throttle is on, so conviction upside is capped for sizing while this alarm is active."
      : "Advisory only: sizing is unchanged unless you enable the signal-health auto-throttle in tuning.");
  await sendNotification(
    { type: "signal_health", title: `Signal health drift (${horizons})`, payload: { alarms, autoThrottle: throttleOn } },
    { userId, policy, directBody: body }
  );
}

/**
 * Scheduler entry point: once per UTC day per user (runRetrievalUsefulnessJoinIfDue's marker
 * pattern), never throws. The marker is set only after a successful pass.
 */
export async function runSignalHealthRefreshIfDue(
  userId: string,
  now: number = Date.now()
): Promise<SignalHealthRefreshResult | undefined> {
  try {
    const key = `${LAST_RUN_KEY_PREFIX}:${userId}`;
    if (getInternalSetting<string>(key) === utcDate(now)) return undefined;
    const result = await runSignalHealthRefresh(userId, { now });
    setInternalSetting(key, utcDate(now));
    return result;
  } catch (err) {
    console.warn(`[signal-health] refresh failed for ${userId}:`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

/** Sizing hot-path read for the opt-in auto-throttle: is ANY horizon's drift alarm active?
 * Fails OPEN to inactive — a settings-store failure must never abort or shrink sizing
 * (getUserSourceSettingsMap's contract, source-settings.ts). */
export function signalHealthDriftActive(userId: string): {
  active: boolean;
  horizons: string[];
  detectedAt?: string;
} {
  try {
    const active: DriftState[] = [];
    for (const horizon of SIGNAL_HEALTH_HORIZONS) {
      const state = getInternalSetting<DriftState>(driftStateKey(userId, horizon));
      if (state?.active) active.push(state);
    }
    const detectedAt = active
      .map((state) => state.detectedAt)
      .filter((value): value is string => typeof value === "string")
      .sort()[0];
    return {
      active: active.length > 0,
      horizons: active.map((state) => state.horizon),
      ...(detectedAt ? { detectedAt } : {})
    };
  } catch {
    return { active: false, horizons: [] };
  }
}
