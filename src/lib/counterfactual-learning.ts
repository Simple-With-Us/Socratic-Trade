import {
  enqueueDueJob,
  getCounterfactualLearningWatermark,
  insertSkippedCounterfactualCandidate,
  listPendingSkippedCounterfactuals,
  listSignalSnapshotAuditAfter,
  markSkippedCounterfactualChecked,
  markSkippedCounterfactualMatured,
  markSkippedCounterfactualUnresolvable,
  setCounterfactualLearningWatermark,
  skippedCounterfactualId
} from "./db";
import { fetchDailyOHLC, toBusinessDay } from "./history";
import type { OHLCBar } from "./indicators";
import { addTradingDays, marketDateOf } from "./market-calendar";
import { normalizeSymbol } from "./money";
import {
  buildIntradaySampleJobSpecs,
  computeDailyHorizonRows,
  computeIntradayHorizonRows,
  mergeHorizonRows,
  normalizeDailyBars,
  UNRESOLVABLE_AFTER_TRADING_DAYS
} from "./outcome-horizons";
import type { MarketFactor, MarketFactorBreakdown } from "./types";

const DAY_MS = 86_400_000;
const DEFAULT_HORIZON_DAYS = 5;
const DEFAULT_AUDIT_LIMIT = 100;
const DEFAULT_PENDING_LIMIT = 50;
const DEFAULT_RECHECK_MS = 6 * 60 * 60_000;

export type CounterfactualOHLCFetcher = (symbol: string, now?: number, userId?: string) => Promise<OHLCBar[] | null>;

export interface CounterfactualMaterializationOptions {
  now?: number;
  /** Scope learning to one connected account: read only its snapshots, tag its candidates, keep its own watermark. */
  connectedAccountId?: string;
  horizonDays?: number;
  auditLimit?: number;
  pendingLimit?: number;
  recheckMs?: number;
  fetchOHLC?: CounterfactualOHLCFetcher;
}

export interface CounterfactualMaterializationResult {
  auditRowsScanned: number;
  candidatesInserted: number;
  pendingChecked: number;
  materialized: number;
  /** Rows terminally marked 'unresolvable' this run (kill-survivorship: delisted/renamed symbols
   * whose price series never resolved within the bounded recheck window). */
  markedUnresolvable: number;
}

interface SignalSnapshotPayload {
  runId?: string;
  asOf?: string;
  signals?: Array<{
    symbol?: string;
    chosen?: boolean;
    refPrice?: number;
    score?: number;
    sector?: string;
    regime?: string;
    factorBreakdown?: MarketFactorBreakdown;
    bulletins?: string[];
  }>;
}

/**
 * Materializes skipped-candidate counterfactuals once their holding window has
 * matured. It never writes fills/orders and never infers prices: no OHLC bar means
 * the candidate remains pending for a later bounded retry.
 */
export async function materializeSkippedCandidateCounterfactuals(
  userId: string = "local",
  options: CounterfactualMaterializationOptions = {}
): Promise<CounterfactualMaterializationResult> {
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const horizonDays = boundedInteger(options.horizonDays ?? envHorizonDays(), 1, 252, DEFAULT_HORIZON_DAYS);
  const auditLimit = boundedInteger(options.auditLimit, 1, 500, DEFAULT_AUDIT_LIMIT);
  const pendingLimit = boundedInteger(options.pendingLimit, 1, 500, DEFAULT_PENDING_LIMIT);
  const recheckMs = boundedInteger(options.recheckMs, 60_000, 7 * DAY_MS, DEFAULT_RECHECK_MS);
  const fetchOHLC = options.fetchOHLC ?? fetchDailyOHLC;

  const connectedAccountId = options.connectedAccountId;
  const watermark = getCounterfactualLearningWatermark(userId, connectedAccountId);
  const auditRows = listSignalSnapshotAuditAfter(userId, watermark, auditLimit, connectedAccountId);
  let candidatesInserted = 0;

  for (const row of auditRows) {
    candidatesInserted += ingestSignalSnapshot(row.payload, {
      userId,
      connectedAccountId,
      createdAt: row.createdAt,
      horizonDays,
      nowIso
    });
  }

  const lastAudit = auditRows[auditRows.length - 1];
  if (lastAudit) {
    setCounterfactualLearningWatermark({
      userId,
      connectedAccountId,
      lastAuditRowid: lastAudit.rowid,
      lastAuditCreatedAt: lastAudit.createdAt,
      lastAuditId: lastAudit.id,
      updatedAt: nowIso
    });
  }

  const checkedBefore = new Date(now - recheckMs).toISOString();
  const pending = listPendingSkippedCounterfactuals({
    userId,
    nowDate: new Date(now).toISOString().slice(0, 10),
    checkedBefore,
    limit: pendingLimit
  });

  const barsBySymbol = new Map<string, OHLCBar[] | null>();
  let pendingChecked = 0;
  let materialized = 0;
  let markedUnresolvable = 0;
  const nowDate = new Date(now).toISOString().slice(0, 10);
  // One SPY series per run for the spyExcessPct of every matured row's daily horizons. A failed
  // SPY fetch simply omits spyExcessPct (never fabricated) — the symbol's own return still lands.
  // Intentionally left on plain SPY (not the ^GSPC-index/sector-aware benchmark outcome-engine.ts
  // now uses, r4): this pipeline feeds missed-opportunity analytics, not the primary alpha-grading
  // loop — upgrading it is a follow-up, not this slice.
  const spyBars = pending.length > 0 ? normalizeDailyBars(await fetchOHLC("SPY", now, userId).catch(() => null)) : [];
  const spyBenchmark = spyBars.length > 0 ? { bars: spyBars, basis: "SPY" } : null;

  for (const candidate of pending) {
    let bars = barsBySymbol.get(candidate.symbol);
    if (bars === undefined) {
      bars = await fetchOHLC(candidate.symbol, now, userId);
      barsBySymbol.set(candidate.symbol, bars);
    }

    // Multi-horizon rows (15m/1h/1d/1w). The skipped pipeline has no placement-time quote sampling
    // path, so intraday horizons here always resolve to 'unresolvable(no_intraday_source)' once the
    // sampling window has passed — recorded honestly rather than fabricated from daily bars.
    const normalizedBars = bars ? normalizeDailyBars(bars) : null;
    const outcomes = mergeHorizonRows(
      candidate.outcomes,
      [
        ...computeIntradayHorizonRows({
          basisPrice: candidate.refPrice,
          basisAtMs: Date.parse(candidate.snapshotAt),
          nowMs: now,
          priceBasisPrefix: "ref_price",
          measuredAt: nowIso
        }),
        ...computeDailyHorizonRows({
          basisPrice: candidate.refPrice,
          // Market (America/New_York) day, not the UTC date: an after-hours ET snapshot must anchor
          // on its own session, same as targetBusinessDate below (ST-4589 B12).
          basisDate: marketDateOf(candidate.snapshotAt) ?? candidate.snapshotAt.slice(0, 10),
          bars: normalizedBars,
          benchmark: spyBenchmark,
          nowDate,
          priceBasisPrefix: "ref_price",
          measuredAt: nowIso
        })
      ]
    );

    const exit = bars ? selectExitBar(bars, candidate.targetDate) : undefined;
    if (!exit) {
      // Kill-survivorship: past the bounded recheck window with still no bar at/after target, the
      // row becomes terminally 'unresolvable' WITH a reason instead of pending forever (delisted /
      // renamed / never-covered symbols must stay countable in every denominator).
      const unresolvableAfter = addTradingDays(candidate.targetDate, UNRESOLVABLE_AFTER_TRADING_DAYS);
      if (nowDate > unresolvableAfter) {
        const reason = !normalizedBars || normalizedBars.length === 0 ? "no_price_series" : "no_bar_at_or_after_target";
        if (markSkippedCounterfactualUnresolvable({ id: candidate.id, userId, reason, outcomes, checkedAt: nowIso })) {
          markedUnresolvable += 1;
        }
      } else {
        markSkippedCounterfactualChecked(candidate.id, userId, nowIso);
      }
      pendingChecked += 1;
      continue;
    }

    const returnPct = Number((((exit.close - candidate.refPrice) / candidate.refPrice) * 100).toFixed(2));
    if (
      markSkippedCounterfactualMatured({
        id: candidate.id,
        userId,
        exitDate: exit.date,
        exitPrice: exit.close,
        returnPct,
        outcomes,
        checkedAt: nowIso
      })
    ) {
      materialized += 1;
    }
    pendingChecked += 1;
  }

  return {
    auditRowsScanned: auditRows.length,
    candidatesInserted,
    pendingChecked,
    materialized,
    markedUnresolvable
  };
}

/**
 * Record a user/policy-REJECTED proposal into the same skipped-candidate counterfactual pipeline so
 * its "what happened after we passed" return matures (via fetchDailyOHLC at the holding horizon) and
 * feeds missed-opportunity analytics — not just the live readout on the dashboard. The existing
 * skipped-candidate set only covers LLM-NOT-CHOSEN names; this closes the gap for names the LLM DID
 * propose but a human/policy then rejected. Additive: reuses insertSkippedCounterfactualCandidate
 * (INSERT OR IGNORE) so it never double-counts and writes no fills/orders. Returns true if inserted.
 */
/**
 * Enqueue the pair of 'sample_intraday_horizon' due-jobs (15m/1h) for a skipped-candidate
 * counterfactual whose (refPrice, snapshotAt) basis is known immediately at insert time. Fire-safe
 * by construction — enqueueDueJob is a plain INSERT OR IGNORE and never throws; wrapped anyway so a
 * future change to that guarantee can't take the counterfactual pipeline down with it.
 */
function enqueueIntradaySampleJobs(input: {
  caseId: string;
  runId: string;
  symbol: string;
  horizonDays: number;
  refPrice: number;
  snapshotAt: string;
  regime?: string;
  userId: string;
  connectedAccountId?: string;
}): void {
  try {
    const specs = buildIntradaySampleJobSpecs({
      caseKind: "counterfactual",
      caseId: input.caseId,
      runId: input.runId,
      symbol: input.symbol,
      horizonDays: input.horizonDays,
      basisPrice: input.refPrice,
      basisAtMs: Date.parse(input.snapshotAt),
      priceBasisPrefix: "ref_price"
    });
    for (const spec of specs) {
      enqueueDueJob({
        jobType: "sample_intraday_horizon",
        dedupeKey: spec.dedupeKey,
        dueAt: spec.dueAt,
        notAfter: spec.notAfter,
        payload: spec.payload,
        userId: input.userId,
        connectedAccountId: input.connectedAccountId
      });
    }
  } catch (err) {
    console.warn("[counterfactual-learning] intraday sample job enqueue failed:", err instanceof Error ? err.message : String(err));
  }
}

export function recordRejectedProposalCounterfactual(input: {
  userId?: string;
  connectedAccountId?: string;
  runId: string;
  symbol: string;
  refPrice: number | undefined;
  createdAt: string;
  regime?: string;
  now?: number;
  horizonDays?: number;
}): boolean {
  const userId = input.userId ?? "local";
  const symbol = normalizeSymbol(input.symbol);
  const refPrice = positiveNumber(input.refPrice);
  const nowMs = input.now ?? Date.now();
  const snapshotAt = validIso(input.createdAt) ?? validIso(new Date(nowMs).toISOString());
  if (!symbol || !refPrice || !snapshotAt) return false;
  const horizonDays = boundedInteger(input.horizonDays ?? envHorizonDays(), 1, 252, DEFAULT_HORIZON_DAYS);
  const targetDate = targetBusinessDate(snapshotAt, horizonDays);
  if (!targetDate) return false;
  const inserted = insertSkippedCounterfactualCandidate({
    userId,
    connectedAccountId: input.connectedAccountId,
    runId: input.runId,
    symbol,
    snapshotAt,
    refPrice,
    horizonDays,
    targetDate,
    regime: nonEmpty(input.regime),
    now: new Date(nowMs).toISOString()
  });
  if (inserted) {
    enqueueIntradaySampleJobs({
      caseId: skippedCounterfactualId(userId, input.runId, symbol, horizonDays),
      runId: input.runId,
      symbol,
      horizonDays,
      refPrice,
      snapshotAt,
      userId,
      connectedAccountId: input.connectedAccountId
    });
  }
  return inserted;
}

function ingestSignalSnapshot(
  payload: unknown,
  context: { userId: string; connectedAccountId?: string; createdAt: string; horizonDays: number; nowIso: string }
): number {
  const snapshot = payload as SignalSnapshotPayload | undefined;
  if (!snapshot?.runId || !Array.isArray(snapshot.signals)) return 0;
  const snapshotAt = validIso(snapshot.asOf) ?? validIso(context.createdAt);
  if (!snapshotAt) return 0;
  const targetDate = targetBusinessDate(snapshotAt, context.horizonDays);
  if (!targetDate) return 0;

  let inserted = 0;
  for (const signal of snapshot.signals) {
    if (signal.chosen !== false) continue;
    const symbol = normalizeSymbol(signal.symbol ?? "");
    const refPrice = positiveNumber(signal.refPrice);
    if (!symbol || !refPrice) continue;
    if (
      insertSkippedCounterfactualCandidate({
        userId: context.userId,
        connectedAccountId: context.connectedAccountId,
        runId: snapshot.runId,
        symbol,
        snapshotAt,
        refPrice,
        horizonDays: context.horizonDays,
        targetDate,
        score: finiteNumber(signal.score),
        sector: nonEmpty(signal.sector),
        regime: nonEmpty(signal.regime),
        dominantFactor: dominantFactor(signal.factorBreakdown),
        bulletins: cleanBulletins(signal.bulletins),
        now: context.nowIso
      })
    ) {
      inserted += 1;
      enqueueIntradaySampleJobs({
        caseId: skippedCounterfactualId(context.userId, snapshot.runId, symbol, context.horizonDays),
        runId: snapshot.runId,
        symbol,
        horizonDays: context.horizonDays,
        refPrice,
        snapshotAt,
        userId: context.userId,
        connectedAccountId: context.connectedAccountId
      });
    }
  }
  return inserted;
}

function selectExitBar(bars: OHLCBar[], targetDate: string): { date: string; close: number } | undefined {
  return bars
    .map((bar) => ({ date: toBusinessDay(bar.time), close: positiveNumber(bar.close) }))
    .filter((bar): bar is { date: string; close: number } => Boolean(bar.date && bar.close))
    .sort((a, b) => a.date.localeCompare(b.date))
    .find((bar) => bar.date >= targetDate);
}

/**
 * TRADING-day horizon target (see `market-calendar.addTradingDays` for the full historical
 * note): `horizonDays` trading sessions after `snapshotAt`'s MARKET-day calendar date,
 * honoring weekends and full-close holidays — NOT `horizonDays * 86_400_000` ms of calendar
 * time. The anchor date is derived in America/New_York (`marketDateOf`), not UTC: an
 * after-hours ET snapshot (e.g. Mon 19:30 ET = Tue 00:30 UTC) counts sessions from Monday's
 * market day; the earlier UTC conversion delayed those horizons by one session (Codex review
 * on PR #365). Named `targetBusinessDate` to match `backtest.ts`'s identical helper (kept as
 * separate thin wrappers since each module owns its own snapshot-parsing/validation contract).
 */
function targetBusinessDate(snapshotAt: string, horizonDays: number): string | undefined {
  const snapshotDate = marketDateOf(snapshotAt);
  if (!snapshotDate) return undefined;
  return addTradingDays(snapshotDate, horizonDays);
}

function envHorizonDays(): number {
  return Number(process.env.COUNTERFACTUAL_HORIZON_DAYS ?? DEFAULT_HORIZON_DAYS);
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanBulletins(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const bulletins = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, 3);
  return bulletins.length > 0 ? bulletins : undefined;
}

function dominantFactor(breakdown?: MarketFactorBreakdown): MarketFactor | undefined {
  if (!breakdown) return undefined;
  let best: { factor: MarketFactor; value: number } | undefined;
  for (const [key, value] of Object.entries(breakdown)) {
    if (key === "weightedTotal") continue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    if (!best || numeric > best.value) best = { factor: key as MarketFactor, value: numeric };
  }
  return best?.factor;
}
