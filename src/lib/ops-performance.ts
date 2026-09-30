import { getDb, listConnectedAccounts, listUsers, peekPolicy, listFillEvents } from "./db";
import {
  aggregateRoundTrip,
  calculatePnl,
  getPerformanceSummary,
  getThesisScorecard,
  getRedTeamEfficacy,
  type ClosedLot,
  type PnlResult,
  RED_TEAM_EFFICACY_MIN_UNIQUE_MATURED,
  type ThesisStat,
  type RedTeamEfficacy
} from "./performance";
import { normalizeSymbol } from "./money";
import { yieldEventLoop } from "./slow-sync-guard";
import type { FillEvent, FillSource, HoldReasonCode } from "./types";

/**
 * Token-gated, read-only realized-performance rollup for remote diagnostics
 * (`GET /api/ops/performance` — mirrors `/api/ops/snapshot`'s ops-auth gate).
 *
 * Deliberately reuses the SAME FIFO lot-matching (`calculatePnl`) and scorecard
 * functions the app already ships (`getPerformanceSummary`, `getThesisScorecard`,
 * `getRedTeamEfficacy`) rather than re-deriving P&L math.  `liveFills`/`paperFills`
 * are fetched ONCE per account and `calculatePnl` runs ONCE per source — the
 * results are threaded through as `PrefetchedFills`/`PrefetchedPnl` so
 * `getPerformanceSummary` and `getThesisScorecard` never recompute FIFO
 * matching a second time (same C2 contract `performance.ts` already documents
 * for its own callers).
 *
 * This process's event loop is already known to stall under load (see
 * `docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md` and
 * `docs/rollouts/2026-09-12-issue-3221-event-loop-stalls.md`), so every NEW query this
 * module adds (proposal funnel, block reasons) is bounded: a status GROUP BY
 * scoped to `(user_id, account_number, created_at)` — covered by the existing
 * `idx_trade_proposals_user_account_created` index — and a row-capped scan for
 * block reasons (`MAX_BLOCK_REASON_ROWS`).  The equity curve reuses
 * `getPerformanceSummary`'s `live/paperEquityCurve`, which is already sourced
 * from `listDailyPortfolioSnapshots` (one row per calendar day, capped at
 * `DAILY_SNAPSHOT_DAY_CAP` — see `db-fills.ts`) — no new query.
 *
 * `days` bounds only the IN-MEMORY windowing of trade stats / the proposal funnel / the equity
 * curve (thesis/Red-Team/model attribution are lifetime by design, matching the app's own
 * scorecards).  It deliberately does NOT truncate `listFillEvents` or `calculatePnl`'s FIFO lot
 * replay — `db-fills.ts`'s own doc comment on `listFillEvents` explains why a windowed ledger
 * read corrupts the walk (an exit whose entry falls outside the window would find no lot to
 * close). So per-account cost is bounded by that ACCOUNT's total ledger size, not by `days`, and
 * the unfiltered request (no `account` param — the endpoint's own documented default; see
 * `scripts/fetch-prod-ops-performance.sh`) repeats that per-account cost once per connected
 * account across every user, all inside one request. `buildOpsPerformanceSnapshot` is `async`
 * and calls `yieldEventLoop()` (this codebase's established fix for exactly this incident class —
 * see `slow-sync-guard.ts`, `sec-ingest-worker.ts`, `db-learning.ts`) once per account so that
 * work — however large — is never one unbroken synchronous stretch; it cannot reduce the total
 * work, only keep this process able to serve `/api/health` and other requests while it runs.
 *
 * No live quotes are fetched (mirrors `/api/connected-accounts/[id]/performance`):
 * `unrealized` P&L is real only when a broker sync recently wrote a portfolio
 * snapshot's mark; this endpoint never calls a broker, so every account's
 * `pricesUnavailable` is always `true` and unrealized figures read 0 from an
 * empty `currentPrices` map — same disclosed limitation as that route.
 */

export const OPS_PERFORMANCE_DEFAULT_DAYS = 90;
export const OPS_PERFORMANCE_MIN_DAYS = 1;
export const OPS_PERFORMANCE_MAX_DAYS = 3650;

/** Bound on blocked-proposal rows scanned for the top-block-reasons rollup, per account. */
const MAX_BLOCK_REASON_ROWS = 1000;
/** Bound on Red Team veto audit rows scanned per account — the app's own default (5000) is sized
 *  for a single-account request; this endpoint can iterate every account for every user. */
const OPS_RED_TEAM_AUDIT_LIMIT = 500;
/** Bucket label for closed lots whose opening proposal carries no `proposedByModel` stamp —
 *  matches the Red Team rollup's own label (performance.ts:1391). */
const OPS_MODEL_UNATTRIBUTED = "unattributed";
/** Bound on `order_rejected_by_broker` audit rows scanned per account for the broker-rejection
 *  reason itemisation — same rationale as MAX_BLOCK_REASON_ROWS. */
const MAX_BROKER_REJECTION_ROWS = 1000;

export interface OpsTradeStats {
  windowDays: number;
  tradeCount: number;
  /** % of closed lots with pnl > 0, 0-100.  0 when tradeCount is 0 (never fabricated as N/A). */
  winRate: number;
  /** Mean pnl (USD) over winning lots; undefined when there are no winners. */
  avgWinUsd?: number;
  /** Mean |pnl| (USD) over losing lots, reported positive; undefined when there are no losers. */
  avgLossUsd?: number;
  /** sum(winning pnl) / abs(sum(losing pnl)).  undefined when there are no losers (no denominator);
   *  Infinity is never emitted — an all-winners window is reported via `tradeCount`/`winRate` instead. */
  profitFactor?: number;
  /** Mean pnl (USD) per closed lot across the WHOLE window (winners and losers). */
  expectancyUsd: number;
}

export interface OpsRoundTripStats extends OpsTradeStats {
  /** Opening lots whose exits do not yet cover the full entry size — the position is still
   *  partly open, so there is no result to grade. Excluded from every inherited figure; reported
   *  so a consumer can say "40 graded of 51 opened" rather than implying full coverage. */
  incompleteRoundTrips: number;
  /** Raw `ClosedLot`s folded into the graded round trips above. Equals `tradeCount` when nothing
   *  was scaled out of, and exceeds it precisely when partial exits are what created the need for
   *  round-trip grading in the first place. */
  lotsGraded: number;
}

export interface OpsModelAttributionRow {
  model: string;
  trades: number;
  winRate: number;
  totalPnlUsd: number;
}

export interface OpsProposalFunnel {
  windowDays: number;
  /** Every status observed in the window, most-common first. */
  counts: Array<{ status: string; count: number }>;
  /** Primary (first) block reason per blocked proposal, tallied and truncated to 160 chars —
   *  reasons that embed a dynamic amount/symbol will not merge into one bucket; this is a
   *  diagnostic rollup, not a canonicalized taxonomy. */
  topBlockReasons: Array<{ reason: string; count: number }>;
  /** True when `topBlockReasons` was truncated by MAX_BLOCK_REASON_ROWS (more blocked proposals
   *  exist in the window than were scanned for reasons — counts.blocked is still exact). */
  blockReasonRowsCapped: boolean;
  /** Coarse cause bucket for every proposal that was ever routed to "Awaiting approval" in the
   *  window — see `HoldReasonCode` in types.ts — counted WHATEVER its status is now.  A held card
   *  the owner never answered expires (policy.proposalExpiryMinutes) and one they answered is
   *  placed, rejected or withdrawn; counting only rows still "proposed" (the first version)
   *  reported just the cards open at that instant, so the very holds the owner asked about
   *  vanished once resolved.  A held proposal persisted before `holdReason` existed carries none
   *  and is simply not counted here (counts.proposed is still exact). */
  holdReasons: Array<{ reason: HoldReasonCode; count: number }>;
  /** Always false: the roll-up is folded into the funnel's single grouped count query (exact, no
   *  row cap).  Kept so the response shape does not change for existing consumers. */
  holdReasonRowsCapped: boolean;
  /** The same status counts, broken out by the model that PROPOSED the idea. Without this the
   *  funnel is a single global tally, so "which model actually reaches the broker" is unanswerable
   *  and a model's win rate can be compared while its share of placed orders is invisible. The
   *  2026-09-25 review named this gap explicitly. `model` is the `proposedByModel` stamp read out
   *  of the proposal JSON; proposals with no stamp (or a malformed blob) fall into the shared
   *  `unattributed` bucket so they are visible rather than dropped. */
  byModel: Array<{ model: string; counts: Array<{ status: string; count: number }> }>;
  /** Broker-declined orders itemised by the reason the broker gave, e.g. "bracket orders must be
   *  entry orders" or "market orders require no stop or limit price". `topBlockReasons` above only
   *  covers the app's OWN pre-placement block decision, so before this the ~84 broker rejections
   *  outside the PG failure path were a single unexplained bucket. Sourced from
   *  `audit_events` where kind = `order_rejected_by_broker` (`payload.reason`, falling back to
   *  `payload.brokerState` for the reconcile-path rows that carry no reason string). */
  brokerRejectionReasons: Array<{ reason: string; count: number }>;
  /** True when `brokerRejectionReasons` was truncated by MAX_BROKER_REJECTION_ROWS. */
  brokerRejectionRowsCapped: boolean;
}

export interface OpsEquityCurvePoint {
  date: string;
  equity: number;
  cash: number | null;
}

export interface OpsPerformanceAccount {
  connectedAccountId: string;
  userId: string;
  label: string;
  broker: string;
  environment: FillSource;
  systemState: string;
  accountNumber: string | null;
  pricesUnavailable: true;
  liveRealizedPnl: number;
  paperRealizedPnl: number;
  liveUnrealizedPnl: number;
  paperUnrealizedPnl: number;
  tradeStats: OpsTradeStats;
  /** Same window, graded on completed ROUND TRIPS rather than individual FIFO lots. This is the
   *  figure to decide on: `tradeStats` counts one entry per exit, so a scaled-out position is
   *  graded several times and reads better than it traded. See `buildRoundTripStats`. */
  roundTripStats: OpsRoundTripStats;
  thesisScorecard: ThesisStat[];
  redTeamEfficacy: RedTeamEfficacy;
  modelAttribution: OpsModelAttributionRow[];
  proposalFunnel: OpsProposalFunnel;
  equityCurve: OpsEquityCurvePoint[];
  /** Set instead of throwing when this one account's rollup failed — the rest of the snapshot
   *  still returns (mirrors ops-snapshot's per-account try/catch). Note this is coarser than
   *  `redTeamEfficacy`'s own isolation: a Red Team audit-read failure alone never sets this — it
   *  falls back to an empty `redTeamEfficacy` while the rest of the account's fields (P&L, trade
   *  stats, funnel, equity curve) still compute normally. See `safeRedTeamEfficacy`. */
  error?: string;
}

export interface OpsPerformanceSnapshot {
  asOf: string;
  windowDays: number;
  accounts: OpsPerformanceAccount[];
}

function clampDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return OPS_PERFORMANCE_DEFAULT_DAYS;
  return Math.min(OPS_PERFORMANCE_MAX_DAYS, Math.max(OPS_PERFORMANCE_MIN_DAYS, Math.floor(n)));
}

/** Static fallback for `getRedTeamEfficacy` failures — same shape it returns for a genuine
 *  zero-veto account, so nothing downstream needs a new "unavailable" variant; `coverage` is the
 *  only field that says so explicitly. */
const RED_TEAM_EFFICACY_UNAVAILABLE: RedTeamEfficacy = {
  totalVetoes: 0,
  maturedVetoes: 0,
  unresolvableVetoes: 0,
  maturedCoveragePct: 0,
  coverage: "unavailable (read failed)",
  vetoValueAddRate: 0,
  survivorRiskHitRate: 0,
  avgReturnPct: 0,
  // A failed read must NOT read as a scored zero. `getRedTeamEfficacy` now reports whether its
  // sample is even large enough to conclude on (review rank 7), and "we could not measure it" is a
  // different fact from "we measured zero vetoes and zero value". Say so explicitly, or a consumer
  // reading the default shape would conclude the Red Team vetoes nothing.
  sampleSufficient: false,
  minUniqueMaturedForVerdict: RED_TEAM_EFFICACY_MIN_UNIQUE_MATURED,
  verdict: "insufficient-sample",
  uniqueScenarios: 0,
  maturedUniqueScenarios: 0,
  duplicateVetoes: 0,
  byModel: [],
  records: []
};

/** `getRedTeamEfficacy` -> `listAuditByKind` (`db-learning.ts`) does an unguarded
 *  `JSON.parse(row.payload)` per `audit_events` row for this account/user. One malformed payload
 *  row (partial write, historical bad row) throws there and would otherwise propagate out of
 *  `buildOpsPerformanceSnapshot` uncaught, 500ing this whole diagnostic endpoint for every
 *  account of every user — exactly the tool an operator reaches for during an incident. Wrap it
 *  here (never inside a catch/fallback branch that could itself be reached by the same throw)
 *  and fall back to a static empty shape, mirroring `ops-snapshot.ts`'s own defensive
 *  `JSON.parse`-with-fallback pattern over the same `audit_events` table. */
function safeRedTeamEfficacy(
  userId: string,
  options: { connectedAccountId?: string; auditLimit?: number }
): RedTeamEfficacy {
  try {
    return getRedTeamEfficacy(userId, options);
  } catch {
    return RED_TEAM_EFFICACY_UNAVAILABLE;
  }
}

/** Pure arithmetic over an already-computed `ClosedLot[]` (from `calculatePnl`) — never
 *  re-derives pnl/returnPct itself.  `sinceIso` filters to lots that EXITED in the window;
 *  lots without an `exitAt` (legacy rows) are excluded from the windowed count. */
function computeTradeStats(closedLots: ClosedLot[], sinceIso: string, windowDays: number): OpsTradeStats {
  const windowed = closedLots.filter((lot) => typeof lot.exitAt === "string" && lot.exitAt >= sinceIso);
  const tradeCount = windowed.length;
  if (tradeCount === 0) {
    return { windowDays, tradeCount: 0, winRate: 0, expectancyUsd: 0 };
  }
  let winSum = 0;
  let winCount = 0;
  let lossSum = 0; // positive magnitude
  let lossCount = 0;
  let totalPnl = 0;
  for (const lot of windowed) {
    totalPnl += lot.pnl;
    if (lot.pnl > 0) {
      winSum += lot.pnl;
      winCount += 1;
    } else if (lot.pnl < 0) {
      lossSum += -lot.pnl;
      lossCount += 1;
    }
  }
  return {
    windowDays,
    tradeCount,
    winRate: Number(((winCount / tradeCount) * 100).toFixed(1)),
    avgWinUsd: winCount > 0 ? Number((winSum / winCount).toFixed(2)) : undefined,
    avgLossUsd: lossCount > 0 ? Number((lossSum / lossCount).toFixed(2)) : undefined,
    profitFactor: lossSum > 0 ? Number((winSum / lossSum).toFixed(2)) : undefined,
    expectancyUsd: Number((totalPnl / tradeCount).toFixed(2))
  };
}

/** Round-trip identity of one OPENING fill: symbol + the timestamp `calculatePnl` stamps onto
 *  every exit it books against that lot. Deliberately the same pair, so grouping exits here lines
 *  up with the FIFO match `calculatePnl` already performed — this never re-derives lot matching. */
function roundTripKey(symbol: string | undefined, entryAt: string | undefined): string {
  // A legacy lot with no symbol and no entryAt cannot be attributed to an opening fill at all;
  // give it a stable singleton key so it forms its own group and is reported as incomplete
  // rather than silently merged into some other position's round trip.
  return `${symbol ? normalizeSymbol(symbol) : "?"}|${entryAt ?? ""}`;
}

/** Grade the window on ROUND TRIPS rather than on individual FIFO lots.
 *
 * `computeTradeStats` above counts one entry per `ClosedLot`, and a scaled-out position produces
 * one `ClosedLot` per trim — so a position that took two profitable trims and then a stopped-out
 * remainder reads as 2 wins + 1 loss instead of one losing trade. Every per-model/thesis
 * comparison the 2026-09-25 review drew is distorted by that, which is why it asked for
 * `aggregateRoundTrip` grading (its "perf-11" note). This is the honest denominator.
 *
 * A round trip is only graded once it is COMPLETE: `aggregateRoundTrip` returns `undefined` while
 * the position is still partly open, because grading a half-closed trade is grading it before it
 * is over. Those openings are counted in `incompleteRoundTrips` rather than dropped silently, so
 * a report can say "these figures cover 40 of 51 round trips" instead of quietly implying 51.
 *
 * `fills` supplies the opening size per lot — `ClosedLot` carries the size each EXIT closed, not
 * the size the position was opened with, and the two differ on exactly the scaled-out positions
 * this exists to measure. */
function buildRoundTripStats(
  closedLots: ClosedLot[],
  fills: FillEvent[],
  sinceIso: string,
  windowDays: number
): OpsRoundTripStats {
  const entrySize = new Map<string, number>();
  for (const fill of fills) {
    if (fill.side !== "buy" && fill.side !== "short") continue; // closing side
    const key = roundTripKey(fill.symbol, fill.filledAt);
    entrySize.set(key, (entrySize.get(key) ?? 0) + Number(fill.quantity));
  }

  const groups = new Map<string, ClosedLot[]>();
  for (const lot of closedLots) {
    const key = roundTripKey(lot.symbol, lot.entryAt);
    const bucket = groups.get(key);
    if (bucket) bucket.push(lot);
    else groups.set(key, [lot]);
  }

  const trips: ClosedLot[] = [];
  let lotsGraded = 0;
  let incompleteRoundTrips = 0;
  for (const [key, lots] of groups) {
    // Terminal ordering matters: `aggregateRoundTrip` takes exitAt/mae/mfe from the LAST exit,
    // so a group read out of order would stamp the wrong holding period.
    lots.sort((a, b) => String(a.exitAt ?? "").localeCompare(String(b.exitAt ?? "")));
    const trip = aggregateRoundTrip(lots, entrySize.get(key) ?? 0);
    if (!trip) {
      incompleteRoundTrips += 1;
      continue;
    }
    trips.push(trip);
    // Count the lots only when the trip they belong to is actually IN the window. `computeTradeStats`
    // windows on `exitAt >= sinceIso`, so counting unconditionally here would let a 200-day-old
    // round trip inflate `lotsGraded` while contributing nothing to `tradeCount` — two figures
    // describing the same denominator but disagreeing. Apply the identical predicate.
    if (typeof trip.exitAt === "string" && trip.exitAt >= sinceIso) lotsGraded += lots.length;
  }

  return { ...computeTradeStats(trips, sinceIso, windowDays), incompleteRoundTrips, lotsGraded };
}

/** Group ALL (not window-filtered — an account's model attribution is inherently
 *  lifetime) closed lots by `entryModel` (proposal.proposedByModel).  Pure arithmetic over
 *  already-computed pnl/returnPct, same category as `computeTradeStats` above — not P&L math. */
function computeModelAttribution(closedLots: ClosedLot[]): OpsModelAttributionRow[] {
  const byModel = new Map<string, { trades: number; wins: number; pnl: number }>();
  for (const lot of closedLots) {
    // An unstamped lot is a REPORTABLE bucket, not a silent drop. The 2026-09-25 performance
    // review found the unstamped fifth of Alpaca Paper's closed lots was collectively the
    // PROFITABLE bucket (+$184.54) — dropping them is what let "gpt-5.5 vs grok-build-0.1"
    // read as ~3-in-1,000 by chance. Same label the Red Team rollup already uses
    // (performance.ts:1391), so both surfaces agree on what one word means.
    const model = lot.entryModel?.trim() || OPS_MODEL_UNATTRIBUTED;
    const cur = byModel.get(model) ?? { trades: 0, wins: 0, pnl: 0 };
    cur.trades += 1;
    if (lot.pnl > 0) cur.wins += 1;
    cur.pnl += lot.pnl;
    byModel.set(model, cur);
  }
  return Array.from(byModel.entries())
    .map(([model, s]) => ({
      model,
      trades: s.trades,
      winRate: Number(((s.wins / s.trades) * 100).toFixed(1)),
      totalPnlUsd: Number(s.pnl.toFixed(2))
    }))
    .sort((a, b) => b.trades - a.trades || a.model.localeCompare(b.model));
}

/** Status funnel + top block reasons for one account's proposals in the window.  Both queries are
 *  scoped by (user_id, account_number, created_at) — covered by the existing
 *  idx_trade_proposals_user_account_created index — and the reasons scan is row-capped. */
function queryProposalFunnel(
  userId: string,
  accountNumber: string,
  connectedAccountId: string,
  sinceIso: string,
  windowDays: number
): OpsProposalFunnel {
  const countRows = getDb()
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(json_extract(proposal, '$.proposedByModel')), ''), ?) AS model,
              status, json_extract(proposal, '$.holdReason') AS hold_reason, COUNT(*) AS n
       FROM trade_proposals
       WHERE user_id = ? AND account_number = ? AND created_at >= ?
       GROUP BY model, status, hold_reason`
    )
    .all(OPS_MODEL_UNATTRIBUTED, userId, accountNumber, sinceIso) as Array<{
    model: string;
    status: string;
    hold_reason: string | null;
    n: number;
  }>;

  // Global per-status counts are the SUM over the per-model rows, not a second query: the window
  // scan is the expensive part of this function and this module's whole design constraint is not
  // adding one (see the module doc comment on the stalling event loop). Both views come from the
  // same grouped rows, so they can never disagree with each other.
  const globalCounts = new Map<string, number>();
  const byModel = new Map<string, Map<string, number>>();
  for (const row of countRows) {
    globalCounts.set(row.status, (globalCounts.get(row.status) ?? 0) + row.n);
    const perModel = byModel.get(row.model) ?? new Map<string, number>();
    perModel.set(row.status, (perModel.get(row.status) ?? 0) + row.n);
    byModel.set(row.model, perModel);
  }
  const counts = Array.from(globalCounts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
  const byModelRows = Array.from(byModel.entries())
    .map(([model, perStatus]) => ({
      model,
      counts: Array.from(perStatus.entries())
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status))
    }))
    .sort(
      (a, b) =>
        (b.counts[0]?.count ?? 0) - (a.counts[0]?.count ?? 0) ||
        b.counts.reduce((s, c) => s + c.count, 0) - a.counts.reduce((s, c) => s + c.count, 0) ||
        a.model.localeCompare(b.model)
    );

  const blockedCount = globalCounts.get("blocked") ?? 0;
  const blockedRows =
    blockedCount > 0
      ? (getDb()
          .prepare(
            `SELECT decision FROM trade_proposals
             WHERE user_id = ? AND account_number = ? AND status = 'blocked' AND created_at >= ?
             ORDER BY created_at DESC LIMIT ?`
          )
          .all(userId, accountNumber, sinceIso, MAX_BLOCK_REASON_ROWS) as Array<{ decision: string }>)
      : [];

  const reasonCounts = new Map<string, number>();
  for (const row of blockedRows) {
    let reason: string | undefined;
    try {
      const parsed = JSON.parse(row.decision) as { reasons?: unknown };
      if (Array.isArray(parsed.reasons) && typeof parsed.reasons[0] === "string" && parsed.reasons[0].trim()) {
        reason = parsed.reasons[0].trim().slice(0, 160);
      }
    } catch {
      // malformed decision JSON — skip this row's reason, the count is still in `counts`
    }
    if (!reason) continue;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const topBlockReasons = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 10);

  // holdReasons: read off the same grouped rows as the status counts (no extra window scan), over
  // EVERY status — see the `holdReasons` field doc for why "still proposed" is the wrong filter.
  const holdReasonCounts = new Map<HoldReasonCode, number>();
  for (const row of countRows) {
    const holdReason = row.hold_reason;
    if (
      holdReason === "red_team_unavailable" ||
      holdReason === "funding_sell" ||
      holdReason === "policy_revert" ||
      holdReason === "other"
    ) {
      holdReasonCounts.set(holdReason, (holdReasonCounts.get(holdReason) ?? 0) + row.n);
    }
  }
  const holdReasons = Array.from(holdReasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  // Broker-declined orders, itemised. Scoped on `audit_events`' own (user_id,
  // connected_account_id, kind) columns — every `order_rejected_by_broker` row is written with
  // both by `audit()` (db.ts:3627), and `idx_audit_events_user_account_kind` covers the lookup.
  // Deliberately NOT joined through to `trade_proposals` on the payload's proposalId: that would
  // make SQLite parse every rejection payload in the table to find the ones in this account, and
  // this module's whole design constraint (see its doc comment) is not adding a query whose cost
  // scales with the whole audit table. Row-capped for the same reason the block-reason scan is.
  const rejectedCount = globalCounts.get("rejected_by_broker") ?? 0;
  const brokerRejectionRows =
    rejectedCount > 0
      ? (getDb()
          .prepare(
            `SELECT payload FROM audit_events
             WHERE user_id = ? AND connected_account_id = ? AND kind = 'order_rejected_by_broker'
               AND created_at >= ?
             ORDER BY created_at DESC LIMIT ?`
          )
          .all(userId, connectedAccountId, sinceIso, MAX_BROKER_REJECTION_ROWS) as Array<{ payload: string }>)
      : [];

  const brokerReasonCounts = new Map<string, number>();
  for (const row of brokerRejectionRows) {
    let reason: string | undefined;
    try {
      const parsed = JSON.parse(row.payload) as { reason?: unknown; brokerState?: unknown };
      if (typeof parsed.reason === "string" && parsed.reason.trim()) reason = parsed.reason;
      // The reconcile-path rows (strategy-execution.ts) never carry `reason`; they record the
      // broker's own terminal state instead, which is the closest thing to a reason available.
      else if (typeof parsed.brokerState === "string" && parsed.brokerState.trim()) reason = `broker state: ${parsed.brokerState}`;
    } catch {
      // malformed payload — skip this row's reason, same as the block-reason scan above
      continue;
    }
    if (!reason) continue;
    const key = canonicalizeBrokerRejectionReason(reason);
    if (!key) continue;
    brokerReasonCounts.set(key, (brokerReasonCounts.get(key) ?? 0) + 1);
  }
  const brokerRejectionReasons = Array.from(brokerReasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 20);

  return {
    windowDays,
    counts,
    byModel: byModelRows,
    topBlockReasons,
    blockReasonRowsCapped: blockedRows.length >= MAX_BLOCK_REASON_ROWS && blockedCount > MAX_BLOCK_REASON_ROWS,
    holdReasons,
    holdReasonRowsCapped: false,
    brokerRejectionReasons,
    // "Did the scan hit its row cap?" — and nothing else. Deliberately NOT a comparison against
    // `rejectedCount`: that is a count of PROPOSALS carrying the `rejected_by_broker` status, while
    // this list is built from AUDIT ROWS, which are a different population (one proposal can log
    // several rejection events, and a reconcile-path row can exist without a status write).
    // Comparing the two silently produced a wrong answer in both directions. Same "hit the cap"
    // semantics as the block-reason scan.
    brokerRejectionRowsCapped: brokerRejectionRows.length >= MAX_BROKER_REJECTION_ROWS
  };
}

/** Reduce a broker/validation error string to a bucket key.
 *
 * The raw text is a broker adapter message, so the same underlying refusal arrives with
 * different HTTP statuses attached ("HTTP 422: bracket orders must be entry orders" vs "HTTP 400:
 * …"). Stripping the transport prefix is what lets the repeat offenders in the 2026-09-25 review
 * — 11 rejections of that one bracket rule — actually count as one cause instead of eleven.
 *
 * Deliberately NOT a full canonicalizer: anything beyond collapsing whitespace and stripping the
 * leading status code risks merging genuinely different refusals, and a diagnostic rollup that
 * over-merges is worse than one that under-merges. Same caveat as `topBlockReasons`. */
function canonicalizeBrokerRejectionReason(raw: string): string | undefined {
  const stripped = raw
    .trim()
    .replace(/^HTTP\s+\d{3}\s*[:\-]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return undefined;
  return stripped.slice(0, 200);
}

/** Merge live+paper equity curves (already downsampled to <= 1 point/day inside
 *  getPerformanceSummary via listDailyPortfolioSnapshots), filter to the window, sort. */
function buildEquityCurve(
  liveCurve: Array<{ timestamp: string; equity: number; cash?: number }>,
  paperCurve: Array<{ timestamp: string; equity: number; cash?: number }>,
  sinceIso: string
): OpsEquityCurvePoint[] {
  return [...liveCurve, ...paperCurve]
    .filter((point) => point.timestamp >= sinceIso)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((point) => ({
      date: point.timestamp.slice(0, 10),
      equity: point.equity,
      cash: typeof point.cash === "number" ? point.cash : null
    }));
}

export interface BuildOpsPerformanceInput {
  /** Narrow to one connectedAccountId (across every user) — omit for every account the ops
   *  snapshot covers, mirroring `/api/ops/snapshot`'s all-users iteration. */
  connectedAccountId?: string;
  days?: number;
}

export async function buildOpsPerformanceSnapshot(input: BuildOpsPerformanceInput = {}): Promise<OpsPerformanceSnapshot> {
  const windowDays = clampDays(input.days);
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const accounts: OpsPerformanceAccount[] = [];
  for (const userId of listUsers()) {
    for (const account of listConnectedAccounts(userId)) {
      if (input.connectedAccountId && account.id !== input.connectedAccountId) continue;

      const base = {
        connectedAccountId: account.id,
        userId,
        label: account.label || account.broker,
        broker: account.broker,
        environment: account.environment,
        accountNumber: account.accountNumber ?? null
      };

      if (!account.accountNumber) {
        // Never connected / never synced a broker account number — nothing to compute.
        accounts.push({
          ...base,
          systemState: "unknown",
          pricesUnavailable: true,
          liveRealizedPnl: 0,
          paperRealizedPnl: 0,
          liveUnrealizedPnl: 0,
          paperUnrealizedPnl: 0,
          tradeStats: { windowDays, tradeCount: 0, winRate: 0, expectancyUsd: 0 },
          roundTripStats: { windowDays, tradeCount: 0, winRate: 0, expectancyUsd: 0, incompleteRoundTrips: 0, lotsGraded: 0 },
          thesisScorecard: [],
          redTeamEfficacy: safeRedTeamEfficacy(userId, { connectedAccountId: account.id, auditLimit: OPS_RED_TEAM_AUDIT_LIMIT }),
          modelAttribution: [],
          proposalFunnel: { windowDays, counts: [], byModel: [], topBlockReasons: [], blockReasonRowsCapped: false, holdReasons: [], holdReasonRowsCapped: false, brokerRejectionReasons: [], brokerRejectionRowsCapped: false },
          equityCurve: []
        });
        // Give the process a scheduling point between accounts even on this cheap branch, so an
        // unfiltered request over many never-synced accounts stays uniform with the branch below.
        await yieldEventLoop();
        continue;
      }

      try {
        const accountNumber = account.accountNumber;
        const policy = peekPolicy(userId, account.id);
        const systemState = policy.systemState;

        // Fetch each source's fills ONCE, compute FIFO ONCE per source, and thread the results
        // through as PrefetchedFills/PrefetchedPnl so getPerformanceSummary and
        // getThesisScorecard never recompute calculatePnl for the same book.
        const liveFills = listFillEvents(accountNumber, "live", undefined, userId);
        const paperFills = listFillEvents(accountNumber, "paper", undefined, userId);
        const livePnl: PnlResult = calculatePnl(liveFills, {});
        const paperPnl: PnlResult = calculatePnl(paperFills, {});
        const prefetched = { liveFills, paperFills };
        const prefetchedPnl = { live: livePnl, paper: paperPnl };

        // No currentPrices fetched (matches /api/connected-accounts/[id]/performance) — this is a
        // read-only ops diagnostic and never calls a broker for a live quote.
        const performance = getPerformanceSummary(accountNumber, {}, userId, prefetched, prefetchedPnl);

        // Scorecards/trade-stats key off the account's OWN book (environment), not a merged
        // live+paper FIFO match, which getThesisScorecard(source=undefined) would otherwise
        // recompute from scratch — see module doc comment.
        const source: FillSource = account.environment;
        const sourcePnl = source === "live" ? livePnl : paperPnl;

        const thesisScorecard = getThesisScorecard(accountNumber, source, {}, userId, prefetched, prefetchedPnl);
        const redTeamEfficacy = safeRedTeamEfficacy(userId, {
          connectedAccountId: account.id,
          auditLimit: OPS_RED_TEAM_AUDIT_LIMIT
        });
        const modelAttribution = computeModelAttribution(sourcePnl.closedLots);
        const tradeStats = computeTradeStats(sourcePnl.closedLots, sinceIso, windowDays);
        // Grade the same book on completed round trips, using the account's OWN source fills for
        // opening sizes — the same live/paper split `source`/`sourcePnl` already apply above.
        const sourceFills: FillEvent[] = source === "live" ? liveFills : paperFills;
        const roundTripStats = buildRoundTripStats(sourcePnl.closedLots, sourceFills, sinceIso, windowDays);
        const proposalFunnel = queryProposalFunnel(userId, accountNumber, account.id, sinceIso, windowDays);
        const equityCurve = buildEquityCurve(performance.liveEquityCurve, performance.paperEquityCurve, sinceIso);

        accounts.push({
          ...base,
          systemState,
          pricesUnavailable: true,
          liveRealizedPnl: performance.liveRealizedPnl,
          paperRealizedPnl: performance.paperRealizedPnl,
          liveUnrealizedPnl: performance.liveUnrealizedPnl,
          paperUnrealizedPnl: performance.paperUnrealizedPnl,
          tradeStats,
          roundTripStats,
          thesisScorecard,
          redTeamEfficacy,
          modelAttribution,
          proposalFunnel,
          equityCurve
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        accounts.push({
          ...base,
          systemState: "unknown",
          pricesUnavailable: true,
          liveRealizedPnl: 0,
          paperRealizedPnl: 0,
          liveUnrealizedPnl: 0,
          paperUnrealizedPnl: 0,
          tradeStats: { windowDays, tradeCount: 0, winRate: 0, expectancyUsd: 0 },
          roundTripStats: { windowDays, tradeCount: 0, winRate: 0, expectancyUsd: 0, incompleteRoundTrips: 0, lotsGraded: 0 },
          thesisScorecard: [],
          redTeamEfficacy: safeRedTeamEfficacy(userId, { connectedAccountId: account.id, auditLimit: OPS_RED_TEAM_AUDIT_LIMIT }),
          modelAttribution: [],
          proposalFunnel: { windowDays, counts: [], byModel: [], topBlockReasons: [], blockReasonRowsCapped: false, holdReasons: [], holdReasonRowsCapped: false, brokerRejectionReasons: [], brokerRejectionRowsCapped: false },
          equityCurve: [],
          error: message
        });
      }

      // The expensive step: a full-ledger listFillEvents + FIFO calculatePnl walk per source,
      // run above for EVERY account in an unfiltered request. Yield here — after each account,
      // win or error — so this request can never hold the event loop for its whole duration; see
      // the module doc comment and `slow-sync-guard.ts` for why this is this codebase's fix for
      // exactly this incident class. This does not shrink the total work, only breaks it up.
      await yieldEventLoop();
    }
  }

  return {
    asOf: new Date().toISOString(),
    windowDays,
    accounts
  };
}

// ── 60s in-memory cache (event loop already stalls under load — see module doc comment) ──────

const CACHE_TTL_MS = 60_000;

type CacheEntry = { expiresAt: number; value: OpsPerformanceSnapshot };
const snapshotCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<OpsPerformanceSnapshot>>();

function cacheKey(input: BuildOpsPerformanceInput): string {
  return `${input.connectedAccountId ?? "*"}\0${clampDays(input.days)}`;
}

/** Cached wrapper around buildOpsPerformanceSnapshot — 60s TTL, single-flight per key so two
 *  concurrent requests for the same (account, days) never double the DB work. */
export async function getOrBuildOpsPerformanceSnapshot(input: BuildOpsPerformanceInput = {}): Promise<OpsPerformanceSnapshot> {
  const key = cacheKey(input);
  const now = Date.now();
  const hit = snapshotCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const value = await buildOpsPerformanceSnapshot(input);
      snapshotCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/** Test-only: full reset (mirrors dashboard-snapshot-cache.ts's resetDashboardSnapshotCacheForTests). */
export function resetOpsPerformanceCacheForTests(): void {
  snapshotCache.clear();
  inFlight.clear();
}
