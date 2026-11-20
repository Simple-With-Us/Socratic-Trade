import { centralTradingDayKey, startOfCentralTradingDay } from "./trading-day";

// External deposit/withdrawal inference — PURE, and deliberately dependency-free.
//
// Why this is its own module rather than living in `benchmark.ts` where it started:
// `app/console/lib/derive.ts` needs `inferExternalCashFlows` to compute a cash-flow-adjusted
// day P&L, and derive.ts is imported by ~a dozen "use client" components (the console chrome,
// the dashboard, the mobile PWA client, …). Importing it through benchmark.ts dragged the whole
// server graph into the browser bundle:
//
//   derive.ts → benchmark.ts → history.ts → db.ts (barrel: migrations, api-key crypto, …)
//
// which is how a client chunk ended up carrying the SQLite/migration/ENCRYPTION_KEY code and
// warning about a missing `ENCRYPTION_KEY` in the browser console. The flow math itself never
// needed any of that — it is arithmetic over an equity curve and a fill list.
//
// RULE: this file must stay free of runtime imports. Type-only imports are fine (they are erased
// at compile time); a value import from `./db`, `./history`, or anything that reaches them will
// silently re-attach the server graph to every console page. `history.ts` and the `db` barrel are
// marked `server-only`, so a regression fails the build instead of shipping quietly.
//
// Sign convention (everywhere):
//   deposit / paper top-up / ACH in  → positive
//   withdrawal / ACH out / paper cash-out → negative
// Account return math: V_end - V_start - sum(flows) is market P&L in dollars.

import type { EquityCurvePoint, FillEvent, Portfolio } from "./types";

/** Shared with benchmark.ts, which does the same date-collapsing and 2-dp rounding. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Normalize any timestamp (ms epoch | ISO datetime | YYYY-MM-DD) to a Central trading-day key. */
export function isoDate(ts: string | number | undefined): string | null {
  if (ts == null) return null;
  if (typeof ts === "number") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : centralTradingDayKey(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : centralTradingDayKey(d);
}

/** A flow is only "external" when it clears both floors — below that, cash drift is
 *  indistinguishable from dividends/fees/rounding and must NOT be treated as a transfer. */
export const FLOW_MATERIALITY_PCT_OF_EQUITY = 0.5; // % of prior equity
export const FLOW_MATERIALITY_MIN_USD = 0.50;

/** Sanity bound for an inferred flow vs its own sub-period's equity move (issue #2557). */
export const FLOW_SANITY_EQUITY_DELTA_MULT = 5;
export const FLOW_SANITY_PCT_OF_EQUITY = 2; // % of sub-period start equity

/**
 * A real external transfer moves account equity by roughly its own size (± the market move in
 * the same gap). An inferred flow whose magnitude exceeds BOTH 5× the sub-period's |Δequity|
 * AND 2% of the start equity cannot be reconciled against the equity it supposedly moved —
 * the live failure was a phantom "withdrawal $36,501.38" inferred on a sub-period whose
 * equity moved only −$837, which then inflated TWR to +56%. Such a flow is UNVERIFIED:
 * show it to the owner, but exclude it from TWR neutralization and day-P&L adjustment.
 * The 2%-of-equity floor keeps genuine small transfers verified even on flat-equity days
 * (e.g. a $500 deposit offset by a same-day market dip on a $100k book). Pure.
 */
export function isInferredFlowUnverified(flow: number, startEquity: number, endEquity: number): boolean {
  if (!Number.isFinite(flow) || flow === 0) return false;
  if (!Number.isFinite(startEquity) || !Number.isFinite(endEquity)) return true;
  const deltaEquity = endEquity - startEquity;
  const bound = Math.max(
    FLOW_SANITY_EQUITY_DELTA_MULT * Math.abs(deltaEquity),
    (FLOW_SANITY_PCT_OF_EQUITY / 100) * Math.max(startEquity, 0)
  );
  return Math.abs(flow) > bound;
}

/**
 * Qualify fill-event rows for display cash-flow inference. This intentionally differs from
 * performance.ts isAccountingFill for broker-priced pending live receipts; the historical
 * P&L predicate is unchanged. This module stays dependency-free (see the header RULE):
 * performance.ts reaches the db barrel, and importing it would re-attach the server graph to
 * every client bundle.
 *
 * Why this filter exists: fill_events deliberately books rejected/canceled/expired order
 * receipts WITH their requested notional (reconciliation audit trail — see
 * findFillEventByBrokerOrderId). Those rows never moved cash. Counting their notional in
 * tradeCash makes flow = Δcash − tradeCash invent a "withdrawal" exactly the size of the
 * rejected order (live 2026-11-19: Tradier Sandbox showed −0.2% TWR instead of ≈−3.35%
 * because phantom withdrawals from rejected GOOGL/T/BUD/CRM stops neutralized real losses).
 */
/** Runtime narrowing (no type assertions) for the broker execution payload a fill writer may
 * have persisted on the row's raw blob. Mirrors hasBrokerReportedPricedFill (broker-side.ts):
 * execution truth is ONLY a positive finite filledQuantity AND a positive finite averagePrice.
 * Price alone is not truth: recordFillFromProposal falls back to the proposal quantity when the
 * broker quantity is absent, so a price-only pending row's notional is unexecuted requests. */
function brokerExecutionPayloadFromRaw(raw: unknown): { averagePrice: number; filledQuantity: number } | undefined {
  if (typeof raw !== "object" || raw === null || !("execution" in raw)) return undefined;
  const execution = raw.execution;
  if (typeof execution !== "object" || execution === null) return undefined;
  if (!("averagePrice" in execution) || !("filledQuantity" in execution)) return undefined;
  const averagePrice = execution.averagePrice;
  const filledQuantity = execution.filledQuantity;
  if (typeof averagePrice !== "number" || !Number.isFinite(averagePrice) || averagePrice <= 0) return undefined;
  if (typeof filledQuantity !== "number" || !Number.isFinite(filledQuantity) || filledQuantity <= 0) return undefined;
  return { averagePrice, filledQuantity };
}

export function isCashMovingFill(
  fill: Pick<FillEvent, "status" | "source" | "brokerOrderId" | "executionMode" | "raw">
): boolean {
  // A working partial fill is real broker exposure; its receipt is updated in place as more
  // shares execute, so its current notional is the cash that actually moved so far.
  if (fill.status === "filled" || fill.status === "partially_filled") return true;
  if (fill.status === "pending_reconciliation" && fill.source !== "paper") {
    // Cash-moving ONLY with broker execution truth persisted on the row: a positive finite
    // filledQuantity AND averagePrice under raw.execution, the same contract as
    // hasBrokerReportedPricedFill (broker-side.ts). Writer census at 10a4c73:
    // - strategy.ts books pending for a WORKING order that reports a priced partial fill on a
    //   non-terminal state; its raw.execution carries both fields and its notional is
    //   filledQuantity x averagePrice, real cash moved. Admitted.
    // - A price-only pending is NOT truth: the writer falls back to the proposal quantity when
    //   filledQuantity is absent, so its notional is unexecuted requests. Excluded.
    // - awaitingBrokerPrice pendings (quantity without price) book notional 0. Excluded.
    // - fill-reconciliation placeholder receipts carry price/notional 0 and no execution
    //   payload. Excluded.
    // - synthetic-stops books a resting order pending at a PROVISIONAL quote with real-looking
    //   price/notional but no execution payload (raw.syntheticStop). Excluded: counting its
    //   quote would mint the rejected-order phantom class in a "pending" flavor.
    // Residual: a trade whose row lacks the persisted pair (e.g. a partial the broker priced
    // without reporting quantity) stays undercounted until reconcilePendingFills recovers
    // execution truth, and an absent or unresolvable order NEVER auto-flips (escalation is
    // advisory only, strategy-execution.ts), so there is NO timing guarantee on that recovery.
    return brokerExecutionPayloadFromRaw(fill.raw) !== undefined;
  }
  // Broker-paper pending receipts remain excluded as before, even with an execution pair.
  if (fill.source !== "paper") return false;
  // Note the legacy-paper exception: simulated paper rows below can carry a pending-style
  // status and still count (no brokerOrderId, absent/legacy executionMode) — they are local
  // simulations, not broker exposure, and are exactly what this branch exists to admit.
  // Legacy/local Test rows predate executionMode (or carry the removed "test/local" value).
  // They have no broker order id and were already simulated fills — same rule as the P&L ledger.
  // Widening assignment, not an assertion: ExecutionMode is a string union, and any unexpected
  // persisted string still reaches the comparison unchanged.
  const legacyMode: string | undefined = fill.executionMode;
  return !fill.brokerOrderId && (legacyMode === undefined || legacyMode === "test/local");
}

type CurvePoint = {
  equity: number;
  cash?: number;
  positionsValue?: number;
  timestampMs: number;
  /** Broker-reported EOD equity only (no cash/positions split). */
  brokerHistory?: boolean;
  /** Run that recorded this snapshot; its portfolio predates the run's own fills. */
  runId?: string;
};

function materialityThreshold(priorEquity: number): number {
  return Math.max((FLOW_MATERIALITY_PCT_OF_EQUITY / 100) * Math.max(priorEquity, 0), FLOW_MATERIALITY_MIN_USD);
}

/** True when the snapshot is essentially all cash (no meaningful open positions). */
function isAllCash(p: CurvePoint): boolean {
  const threshold = materialityThreshold(p.equity);
  // Prefer cash ≈ equity. positionsValue has been wrong/double-counted in the past; when cash
  // says the book is fully liquid, treat it as all-cash even if positionsValue is noisy.
  if (typeof p.cash === "number" && Number.isFinite(p.cash)) {
    return Math.abs(p.cash - p.equity) <= Math.max(FLOW_MATERIALITY_MIN_USD, 0.01 * p.equity);
  }
  if (typeof p.positionsValue === "number" && Number.isFinite(p.positionsValue)) {
    return Math.abs(p.positionsValue) < threshold;
  }
  return false;
}

function hasCash(p: CurvePoint): p is CurvePoint & { cash: number } {
  return typeof p.cash === "number" && Number.isFinite(p.cash);
}

function hasPositions(p: CurvePoint): p is CurvePoint & { positionsValue: number } {
  return typeof p.positionsValue === "number" && Number.isFinite(p.positionsValue);
}

/**
 * Infer external deposits/withdrawals per calendar date from the equity curve and recorded fills.
 *
 * Every material external dollar move should appear here (deposits AND withdrawals, paper resets,
 * ACH). Market P&L and trade-driven cash↔stock conversions must NOT.
 *
 * Priority:
 *  1. All-cash → all-cash: equity delta IS the transfer (paper reset, full-cash ACH).
 *  2. Cash present: flow = Δcash − tradeCash (buy notional reduces cash, sell/cover increases it).
 *     Guards zero out cash↔stock conversions when fills are missing.
 *  3. Cash+positions both present and equity ≈ cash+positions: cross-check with
 *     flow ≈ Δequity − Δpositions − tradeCash (same identity when the balance sheet holds).
 *  4. Missing cash: only invent a transfer when both sides look flat and there was no trading.
 *     Never for broker-reported equity-only points (`brokerHistory`) — their flows come from the
 *     broker transfer ledger only.
 *
 * Returns a map keyed by the PERIOD-END snapshot date. Sign: deposit +, withdrawal −.
 * Pure — exported for direct unit testing.
 */
export function inferExternalCashFlows(
  equityCurve: EquityCurvePoint[],
  fills: FillEvent[] = []
): Map<string, number> {
  const flows = new Map<string, number>();
  // Collapse to one (last) point per calendar date, mirroring normalizeAgainstBenchmark.
  const byDate = new Map<string, CurvePoint>();
  for (const p of equityCurve) {
    const d = isoDate(p.timestamp);
    const t = new Date(p.timestamp).getTime();
    if (!d || !Number.isFinite(t)) continue;
    if (!Number.isFinite(p.equity) || p.equity <= 0) continue;
    const point: CurvePoint = { equity: p.equity, timestampMs: t };
    if (typeof p.cash === "number" && Number.isFinite(p.cash)) point.cash = p.cash;
    if (typeof p.positionsValue === "number" && Number.isFinite(p.positionsValue)) {
      point.positionsValue = p.positionsValue;
    }
    if (p.brokerHistory === true) point.brokerHistory = true;
    if (typeof p.runId === "string" && p.runId) point.runId = p.runId;
    // Retain the CHRONOLOGICALLY last point per date, not merely the last-inserted: with
    // chronologically sorted input the two coincide (the documented intent), but an unsorted
    // curve would otherwise keep an earlier point and misbucket that day's fills against the
    // forward-only gap scan below.
    const retained = byDate.get(d);
    if (!retained || t >= retained.timestampMs) byDate.set(d, point);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return flows;

  // Only fills that actually moved cash (isCashMovingFill): rejected/canceled/expired order
  // receipts are booked with their requested notional for reconciliation but never moved a dollar.
  const sortedFills = fills
    .filter(isCashMovingFill)
    .map((f) => ({ t: new Date(f.filledAt).getTime(), side: f.side, notional: f.notional, runId: f.runId }))
    .filter((f) => Number.isFinite(f.t) && Number.isFinite(f.notional))
    .sort((a, b) => a.t - b.t);

  // Assign each fill to the FIRST snapshot whose timestamp covers it and whose run did not
  // execute it. A snapshot's portfolio is fetched at its run's start (strategy.ts: one fetch
  // feeds both the pre-run and post-run snapshot), so its cash provably excludes every fill
  // that run executed: counting such a fill against that snapshot mints a phantom flow and an
  // equal-opposite one in the next gap (2026-11: +1,920.99 on 11/4, -1,920.99 on 11/5).
  // Deferral to the next snapshot's gap — where the settled cash actually appears — keeps
  // tradeCash consistent with captured cash. Run-identity only, no clock arithmetic, so
  // broker/local timestamp skew is irrelevant. Scope is OWN-RUN identity only: a fill stamped
  // with a DIFFERENT run's id executed inside the covering run's window is not deferred and
  // can still artifact (pinned as a known limit in cash-flows-run-alignment.test.ts).
  // Actual cross-run reachability is NOT established: without fetch-time provenance the
  // other-run/null-runId timing space remains uncovered (per-account run locks do not rule
  // out resting orders), and no fetch timestamps are guessed to widen this. Fills with no runId (reconciliation-booked: stops/brackets/replacements, which rest
  // at the broker between runs) are unchanged, and with no runIds anywhere this assignment is
  // exactly the old (prev, cur] membership.
  const points = dates.map((d) => byDate.get(d)!);
  const fillsByGap = new Map<number, typeof sortedFills>();
  let searchFrom = 0;
  for (const f of sortedFills) {
    let i = searchFrom;
    while (i < points.length && points[i].timestampMs < f.t) i++;
    searchFrom = i; // fills are sorted by t, so the covering snapshot index never decreases
    while (i < points.length && f.runId && points[i].runId === f.runId) i++; // same-run deferral
    if (i >= points.length) continue; // deferred past the last snapshot: absent from its cash too
    const bucket = fillsByGap.get(i) ?? [];
    bucket.push(f);
    fillsByGap.set(i, bucket);
  }

  for (let i = 1; i < dates.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const threshold = materialityThreshold(prev.equity);
    const deltaEquity = cur.equity - prev.equity;

    // Trade cash in the gap: buys/shorts reduce cash (negative), sells/covers increase it.
    let tradeNotionalAbs = 0;
    let tradeCash = 0;
    for (const f of fillsByGap.get(i) ?? []) {
      tradeNotionalAbs += Math.abs(f.notional);
      // Short sale credits cash (+); cover and buy debit cash (−). Sell credits (+).
      tradeCash += f.side === "sell" || f.side === "short" ? f.notional : -f.notional;
    }

    // ── 1. All-cash books: any equity move is a transfer (deposit or withdrawal / reset). ──
    if (isAllCash(prev) && isAllCash(cur)) {
      if (Math.abs(deltaEquity) >= threshold) flows.set(dates[i], round2(deltaEquity));
      continue;
    }

    // ── 2. Cash present: primary identity flow = Δcash − tradeCash. ──
    // Deposits: Δcash > 0 (and usually Δequity > 0). Withdrawals: Δcash < 0 (and usually Δequity < 0).
    // Trade-driven cash↔stock is removed via tradeCash or the missing-fill guards below.
    if (hasCash(prev) && hasCash(cur)) {
      const deltaCash = cur.cash - prev.cash;
      let flow = deltaCash - tradeCash;

      // Missing-fill guards: without trade receipts, a cash→stock conversion looks like a withdrawal.
      if (Math.abs(tradeCash) < 1e-9) {
        const deltaPos =
          hasPositions(prev) && hasPositions(cur) ? cur.positionsValue - prev.positionsValue : null;

        if (Math.abs(deltaCash) >= threshold && Math.abs(deltaEquity) < threshold) {
          // Cash moved, equity didn't — bought/sold positions, not a transfer.
          flow = 0;
        } else if (
          deltaPos != null &&
          ((deltaCash < -threshold && deltaPos > threshold) || (deltaCash > threshold && deltaPos < -threshold))
        ) {
          // Cash and positions moved in opposite directions — usually a trade (cash↔stock).
          // Without fills we cannot see the trade notional, so a pure conversion would look
          // like a withdrawal (cash down) or deposit (cash up). Default: flow = 0.
          //
          // Exceptions — concurrent EXTERNAL capital with trading in the same sparse gap
          // (common on paper accounts: deposit then invest between rare snapshots):
          //   1. Large cash+equity drop while positions only absorb a fraction of the cash
          //      (withdraw most, leave/invest a remainder) → flow ≈ Δequity (withdrawal).
          //   2. Material residual equity change vs the cash↔stock swap size → transfer
          //      dominates (deposit then buy, or sell then withdraw). Pure trade + modest
          //      mark-to-market keeps |Δequity| small vs the swap, so flow stays 0.
          const swapped = Math.min(Math.abs(deltaCash), Math.abs(deltaPos));
          const residualIsTransfer =
            Math.abs(deltaEquity) >= Math.max(threshold, 0.25 * swapped);
          if (
            deltaCash < -threshold &&
            deltaEquity < -threshold &&
            deltaPos >= -threshold &&
            Math.abs(deltaCash) > Math.abs(deltaPos) * 2
          ) {
            flow = deltaEquity;
          } else if (residualIsTransfer) {
            // Deposit+invest (Δequity ≈ deposit) or sell+withdraw: neutralize the external $
            // so TWR does not report e.g. 66k→99k as +50% alpha vs SPY.
            flow = deltaEquity;
          } else {
            flow = 0;
          }
        } else if (Math.abs(deltaCash - deltaEquity) < threshold) {
          // Cash and equity moved together (same direction & size) — pure deposit/withdrawal.
          // Covers: withdraw cash (both down), deposit cash (both up), with or without open stock.
          flow = deltaEquity;
        }
      }

      if (Math.abs(flow) >= threshold) flows.set(dates[i], round2(flow));
      continue;
    }

    // ── 4. Missing cash metadata: only invent a transfer when both sides look flat and no trades. ──
    // (Otherwise mark-to-market would be misread as ACH.)
    // Broker-reported EOD equity (Alpaca portfolio history) carries no cash/positions split at
    // all, so "looks flat" is unknowable there: an ordinary ≥0.5% market day would be invented
    // into a deposit/withdrawal and TWR would neutralize real return toward 0%. For those points
    // the broker transfer ledger (resolveExternalCashFlows) is the only flow source; equity-only
    // inference never invents one.
    if (prev.brokerHistory || cur.brokerHistory) continue;
    const prevFlat = hasPositions(prev) ? Math.abs(prev.positionsValue) < threshold : true;
    const curFlat = hasPositions(cur) ? Math.abs(cur.positionsValue) < threshold : true;
    if (prevFlat && curFlat && tradeNotionalAbs < threshold && Math.abs(deltaEquity) >= threshold) {
      flows.set(dates[i], round2(deltaEquity));
    }
  }
  return flows;
}

/**
 * Capital-adjusted account return over a window (%):
 *   (V_end − V_start − netExternalFlows) / V_start × 100
 *
 * Deposits (+) and withdrawals (−) in `netExternalFlows` are stripped so only market P&L remains.
 * This is the intuitive "I started with $100k, took out $10k, have $88k → lost $2k = −2%" figure.
 * Distinct from multi-period TWR (which chains sub-period returns). Pure.
 */
export function capitalAdjustedReturnPct(
  startEquity: number,
  endEquity: number,
  netExternalFlows: number
): number | null {
  if (!(startEquity > 0) || !Number.isFinite(startEquity) || !Number.isFinite(endEquity)) return null;
  if (!Number.isFinite(netExternalFlows)) netExternalFlows = 0;
  return round2(((endEquity - startEquity - netExternalFlows) / startEquity) * 100);
}

/** Last curve point strictly before the current Central trading day — the day-P&L baseline.
 *  Shared by the console derive and the server snapshot so both pick the SAME baseline. Pure. */
export function selectDayPnlBaseline(curve: EquityCurvePoint[], now: Date = new Date()): EquityCurvePoint | undefined {
  const todayStart = startOfCentralTradingDay(now).getTime();
  let baseline: EquityCurvePoint | undefined;
  for (const point of curve) {
    const t = new Date(point.timestamp).getTime();
    if (Number.isFinite(t) && t < todayStart) baseline = point;
  }
  return baseline;
}

/** Inferred net external flow on the current Central trading day for a two-point
 *  [baseline, now] curve, with the same-run deferral and unverified-flow guard applied.
 *  Pure. Caller supplies the fill ledger; the result is only as complete as that ledger —
 *  a display-truncated tail (e.g. PerformanceSummary.fills, newest 100) can drop fills the
 *  inference needs and mint a phantom transfer, so production callers must pass the FULL
 *  per-mode ledger (the server does; the console's no-hint fallback is the bounded legacy
 *  behavior for snapshots that predate the server hint). */
export function inferTodayExternalFlow(args: {
  baseline: EquityCurvePoint;
  /** Equity to sanity-check the flow against; defaults to baseline.equity (broker prior-close overrides pass theirs). */
  baselineEquity?: number;
  fills: FillEvent[];
  currentEquity: number;
  currentCash: number;
  now?: Date;
}): number {
  const now = args.now ?? new Date();
  const baselineEquity = args.baselineEquity ?? args.baseline.equity;
  const baselineMs = new Date(args.baseline.timestamp).getTime();
  const fakeCurrent: EquityCurvePoint = {
    timestamp: now.toISOString(),
    equity: args.currentEquity,
    source: "live",
    cash: args.currentCash,
    positionsValue: args.currentEquity - args.currentCash
  };
  // Relevance pre-filter (result-identical): on the two-point [baseline, now] curve, a fill
  // can land in the REPORTED gap only when it is newer than the baseline or belongs to the
  // baseline's own run (same-run deferral carries it past the baseline). Anything older from
  // another run lands in the baseline's own gap, which this curve never reports. This bounds
  // the SORT to the relevant tail; the scan itself stays O(N) over the ledger array the caller
  // already loaded, so this is a partial cost reduction, not a full ledger-read bound.
  const dayFills = args.fills.filter((f) => {
    const t = new Date(f.filledAt).getTime();
    if (!Number.isFinite(t) || t > now.getTime()) return false;
    return t > baselineMs || (f.runId !== undefined && f.runId === args.baseline.runId);
  });
  const flowMap = inferExternalCashFlows([args.baseline, fakeCurrent], dayFills);
  const flow = flowMap.get(centralTradingDayKey(now)) ?? 0;
  if (flow !== 0 && isInferredFlowUnverified(flow, baselineEquity, args.currentEquity)) return 0;
  return flow;
}

/** The snapshot server's day-P&L inferred-flow hint, computed where the FULL per-mode fill
 *  ledger is in hand. Returns undefined — never a guess — when any input is missing, non-finite
 *  or baseline-less; the console then keeps its tail-bounded fallback. Pure: the dashboard call
 *  site is a one-liner over this, so mode-to-ledger selection and the skip conditions are all
 *  unit-testable here. */
export function computeDayPnlInferredHint(args: {
  liveCurve: EquityCurvePoint[];
  paperCurve: EquityCurvePoint[];
  liveFills: FillEvent[];
  paperFills: FillEvent[];
  mode: "live" | "paper";
  portfolio: Pick<Portfolio, "totalMarketValue" | "cash"> | undefined;
  now?: Date;
}):
  | { mode: "live" | "paper"; flow: number; dayKey: string; baselineAt: string; currentEquity: number; currentCash: number }
  | undefined {
  const now = args.now ?? new Date();
  const curve = args.mode === "live" ? args.liveCurve : args.paperCurve;
  const fills = args.mode === "live" ? args.liveFills : args.paperFills;
  const baseline = selectDayPnlBaseline(curve, now);
  if (!baseline || !Number.isFinite(baseline.equity) || baseline.equity === 0) return undefined;
  const portfolio = args.portfolio;
  if (!portfolio || !Number.isFinite(portfolio.totalMarketValue) || !Number.isFinite(portfolio.cash)) return undefined;
  const flow = inferTodayExternalFlow({
    baseline,
    fills,
    currentEquity: portfolio.totalMarketValue,
    currentCash: portfolio.cash,
    now
  });
  return {
    mode: args.mode,
    flow,
    dayKey: centralTradingDayKey(now),
    baselineAt: baseline.timestamp,
    currentEquity: portfolio.totalMarketValue,
    currentCash: portfolio.cash
  };
}
