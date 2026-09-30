import { getDb, getSymbolLatestPrices, listConnectedAccounts, listUsers, peekPolicy, listFillEvents, resolveAlpacaMarketData } from "./db";
import { AlpacaSnapshotEnrichmentProvider } from "./data-providers";
import {
  aggregateRoundTrip,
  calculatePnl,
  getPerformanceSummary,
  getThesisScorecard,
  getRedTeamEfficacy,
  openLotSymbols,
  unrealizedFromOpenLots,
  type ClosedLot,
  type PnlResult,
  RED_TEAM_EFFICACY_MIN_UNIQUE_MATURED,
  type ThesisStat,
  type RedTeamEfficacy
} from "./performance";
import { withDeadline } from "./inflight-deadline";
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
 * Unrealized P&L (was hardcoded 0 with `pricesUnavailable: true` for every account): the open
 * symbols of each account are marked from the STORED latest-price rows (`symbol_field_latest`, via
 * `getSymbolLatestPrices` — one indexed read, no network, kept warm by the dashboard and every quote
 * refresh; never FMP, owner rule 2026-08-20).  That is the DEFAULT (`marks=stored`) on purpose: the
 * first cut ran the trading-grade quote cascade here, which after hours walks Finnhub (shared 1.2s
 * pacer), Tiingo (shared hourly budget), unpaced Yahoo singles and ROIC for every symbol that is not
 * field-complete, THREW AWAY every price gathered when the 8s deadline hit (so the account read
 * unpriced again), seeded policy rows through `getPolicy`, and let other-broker gateways fan out
 * per-symbol close-history fetches that ignore the abort.  A diagnostic GET must do none of that.
 * Each stored mark carries its own `as_of`; one older than `OPS_STORED_MARK_MAX_AGE_MS` is treated
 * as unpriced rather than mis-marking the book, and the oldest `as_of` used is reported per account
 * (`unrealizedMarksOldestAsOf`) so the reader can judge the figure.  `marks=live` opts in to ONE
 * bounded Alpaca market-data snapshot batch on top of the stored marks (no policy read, no broker
 * gateway, no history fan-out): at most `OPS_QUOTE_MAX_SYMBOLS` symbols per account, one
 * `OPS_QUOTE_FETCH_TIMEOUT_MS` deadline per account, one `OPS_QUOTE_TOTAL_BUDGET_MS` budget across
 * the request, and a timeout keeps the stored marks it already has.  `marks=off` skips marking
 * entirely.  A symbol is never re-quoted within one build (per-request memo), a missing mark is
 * skipped and listed in `unrealizedUnpricedSymbols` (never a $0 mark), and the whole snapshot stays
 * behind the 60s cache below.  The unrealized figure is `unrealizedFromOpenLots` over the
 * `openLots` `calculatePnl` already produced — it does NOT re-run the FIFO walk with prices.
 */

export const OPS_PERFORMANCE_DEFAULT_DAYS = 90;
export const OPS_PERFORMANCE_MIN_DAYS = 1;
export const OPS_PERFORMANCE_MAX_DAYS = 3650;

/** Bound on blocked-proposal rows scanned for the top-block-reasons rollup, per account. */
const MAX_BLOCK_REASON_ROWS = 1000;
/** Output cap on distinct itemised reason buckets (block, broker-rejection, placing-failure).  It
 *  was 10 / 20, which is sized for a human dashboard, not for an ops read that wants every cause.
 *  Only the OUTPUT grew: the row scans feeding it keep their own `MAX_*_ROWS` bounds, so this
 *  changes payload size, not query cost. */
const MAX_REASON_BUCKETS = 50;
/** Bound on `placing_failed` proposal rows scanned per account for the placing-failure reasons. */
const MAX_PLACING_FAILURE_ROWS = 1000;
/** Most open symbols marked for one account's unrealized P&L — a runaway book must not turn one
 *  diagnostic read into an unbounded lookup.  The excess is reported as unpriced. */
const OPS_MARK_MAX_SYMBOLS = 200;
/** Most symbols sent to the live Alpaca snapshot batch for one account (Alpaca's own batch size). */
const OPS_QUOTE_MAX_SYMBOLS = 100;
/** A stored latest-price row older than this is treated as unpriced: it is real data, but marking a
 *  position off a weeks-old print would report a confident, wrong unrealized figure.  Ten days
 *  covers a long holiday weekend and a missed refresh without accepting a stale-for-weeks price. */
const OPS_STORED_MARK_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;
/** Ceiling on the live snapshot fetch for ONE account.  A slow feed keeps the stored marks and
 *  degrades the rest to "unpriced", never a hang. */
const OPS_QUOTE_FETCH_TIMEOUT_MS = 8_000;
/** Ceiling on the time ALL live fetching may spend in one snapshot build.  An unfiltered request
 *  walks every account; without this a slow feed could cost `accounts x OPS_QUOTE_FETCH_TIMEOUT_MS`.
 *  It counts time spent WAITING ON QUOTES, not wall clock since the build started, so a large
 *  ledger's FIFO walk or a loaded event loop on an earlier account cannot starve the marks of the
 *  accounts after it. */
const OPS_QUOTE_TOTAL_BUDGET_MS = 20_000;
/** Bound on held ("proposed" / Awaiting approval) proposal rows scanned for the holdReasons
 *  rollup, per account — same rationale as MAX_BLOCK_REASON_ROWS. */
const MAX_HOLD_REASON_ROWS = 1000;
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

/** One itemised reason with how many times it was seen and WHEN.  `firstSeenAt`/`lastSeenAt` are the
 *  earliest and latest `created_at` among the rows that were scanned for this bucket, so a cause
 *  that stopped weeks ago reads differently from one still firing today.  When the scan hit its row
 *  cap (see the matching `*RowsCapped` flag) they describe the scanned newest rows only. */
export interface OpsReasonBucket {
  reason: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface OpsProposalFunnel {
  windowDays: number;
  /** Every status observed in the window, most-common first. */
  counts: Array<{ status: string; count: number }>;
  /** Primary (first) block reason per blocked proposal, tallied and truncated to 160 chars —
   *  reasons that embed a dynamic amount/symbol will not merge into one bucket; this is a
   *  diagnostic rollup, not a canonicalized taxonomy. */
  topBlockReasons: OpsReasonBucket[];
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
  brokerRejectionReasons: OpsReasonBucket[];
  /** True when `brokerRejectionReasons` was truncated by MAX_BROKER_REJECTION_ROWS. */
  brokerRejectionRowsCapped: boolean;
  /** `placing_failed` proposals itemised by their recorded `error_message` — the other way a
   *  broker refusal reaches a proposal row (the audit-event source above never sees these).  The
   *  Robinhood account's "Fractional orders must be at least $1" and account-questionnaire errors
   *  live here.  A row with no message is bucketed as "(no error message recorded)". */
  placingFailureReasons: OpsReasonBucket[];
  /** True when `placingFailureReasons` was truncated by MAX_PLACING_FAILURE_ROWS. */
  placingFailureRowsCapped: boolean;
}

export interface OpsEquityCurvePoint {
  date: string;
  equity: number;
  cash: number | null;
}

/** Where unrealized-P&L marks come from.  `stored` reads the latest-price rows (no network, the
 *  default); `live` adds one bounded Alpaca snapshot batch; `off` skips marking. */
export type OpsMarksMode = "stored" | "live" | "off";

export interface OpsPerformanceAccount {
  connectedAccountId: string;
  userId: string;
  label: string;
  broker: string;
  environment: FillSource;
  systemState: string;
  accountNumber: string | null;
  /** True only when the book HAS open positions and NONE of them could be marked (or marking was
   *  turned off with `marks=off`).  False when there is nothing to price, or at least one open symbol
   *  got a mark - in which case `unrealizedUnpricedSymbols` says which ones are still missing and
   *  the unrealized figures understate by exactly those positions. */
  pricesUnavailable: boolean;
  /** Open symbols that got no mark (no stored price, one too old, live fetch failed or over budget,
   *  or marking off).  Empty when every open position was priced or there are none. */
  unrealizedUnpricedSymbols: string[];
  /** How the marks were sourced: `stored` (latest-price rows, the default), `live` (stored plus one
   *  Alpaca snapshot batch), or `off`. */
  unrealizedMarkBasis: OpsMarksMode;
  /** ISO time of the OLDEST mark that fed the unrealized figures, or null when nothing was priced.
   *  The age of the figure: a stored mark can be a day or a long weekend old. */
  unrealizedMarksOldestAsOf: string | null;
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
            `SELECT decision, created_at FROM trade_proposals
             WHERE user_id = ? AND account_number = ? AND status = 'blocked' AND created_at >= ?
             ORDER BY created_at DESC LIMIT ?`
          )
          .all(userId, accountNumber, sinceIso, MAX_BLOCK_REASON_ROWS) as Array<{ decision: string; created_at: string }>)
      : [];

  const blockReasonRows: TimedReason[] = [];
  for (const row of blockedRows) {
    try {
      const parsed = JSON.parse(row.decision) as { reasons?: unknown };
      if (Array.isArray(parsed.reasons) && typeof parsed.reasons[0] === "string" && parsed.reasons[0].trim()) {
        blockReasonRows.push({ reason: parsed.reasons[0].trim().slice(0, 160), createdAt: row.created_at });
      }
    } catch {
      // malformed decision JSON — skip this row's reason, the count is still in `counts`
    }
  }
  const topBlockReasons = tallyReasonBuckets(blockReasonRows);

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
            `SELECT payload, created_at FROM audit_events
             WHERE user_id = ? AND connected_account_id = ? AND kind = 'order_rejected_by_broker'
               AND created_at >= ?
             ORDER BY created_at DESC LIMIT ?`
          )
          .all(userId, connectedAccountId, sinceIso, MAX_BROKER_REJECTION_ROWS) as Array<{ payload: string; created_at: string }>)
      : [];

  const brokerReasonRows: TimedReason[] = [];
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
    const key = normalizeBrokerRejectionReason(reason);
    if (!key) continue;
    brokerReasonRows.push({ reason: key, createdAt: row.created_at });
  }
  const brokerRejectionReasons = tallyReasonBuckets(brokerReasonRows);

  // `placing_failed` proposals carry the broker's refusal in `error_message` and never wrote an
  // `order_rejected_by_broker` audit row, so the audit scan above cannot see them: on the live
  // Robinhood account that was 22 failures (11x "Fractional orders must be at least $1", 8x the
  // dollar-based equivalent, 3x the account questionnaire) with no breakdown at all.  Same
  // indexed (user_id, account_number, created_at) scope and row cap as the block-reason scan.
  const placingFailedCount = globalCounts.get("placing_failed") ?? 0;
  const placingFailureRows =
    placingFailedCount > 0
      ? (getDb()
          .prepare(
            `SELECT error_message, created_at FROM trade_proposals
             WHERE user_id = ? AND account_number = ? AND status = 'placing_failed' AND created_at >= ?
             ORDER BY created_at DESC LIMIT ?`
          )
          .all(userId, accountNumber, sinceIso, MAX_PLACING_FAILURE_ROWS) as Array<{ error_message: string | null; created_at: string }>)
      : [];
  const placingFailureReasons = tallyReasonBuckets(
    placingFailureRows.map((row) => ({
      reason: normalizeBrokerRejectionReason(row.error_message) ?? PLACING_FAILURE_NO_MESSAGE,
      createdAt: row.created_at
    }))
  );

  return {
    windowDays,
    counts,
    byModel: byModelRows,
    topBlockReasons,
    blockReasonRowsCapped: blockedRows.length >= MAX_BLOCK_REASON_ROWS && blockedCount > MAX_BLOCK_REASON_ROWS,
    holdReasons,
    // The existing grouped count query is not row-capped, so this stays false; keep the field for
    // the API shape without running a duplicate proposal scan.
    holdReasonRowsCapped: false,
    brokerRejectionReasons,
    // "Did the scan hit its row cap?" — and nothing else. Deliberately NOT a comparison against
    // `rejectedCount`: that is a count of PROPOSALS carrying the `rejected_by_broker` status, while
    // this list is built from AUDIT ROWS, which are a different population (one proposal can log
    // several rejection events, and a reconcile-path row can exist without a status write).
    // Comparing the two silently produced a wrong answer in both directions. Same "hit the cap"
    // semantics as the block-reason and hold-reason scans.
    brokerRejectionRowsCapped: brokerRejectionRows.length >= MAX_BROKER_REJECTION_ROWS,
    placingFailureReasons,
    placingFailureRowsCapped: placingFailureRows.length >= MAX_PLACING_FAILURE_ROWS && placingFailedCount > MAX_PLACING_FAILURE_ROWS
  };
}

/** Bucket label for a `placing_failed` proposal that recorded no `error_message`. */
const PLACING_FAILURE_NO_MESSAGE = "(no error message recorded)";

/** One scanned reason string plus the row timestamp it came from. */
interface TimedReason {
  reason: string;
  createdAt: string;
}

/** Tally `(reason, createdAt)` rows into count + first/last-seen buckets, sorted by count then
 *  name and capped at `MAX_REASON_BUCKETS`.  Shared by the block-reason, broker-rejection and
 *  placing-failure rollups: all three are "normalise, then tally over a row-capped scan". */
function tallyReasonBuckets(rows: TimedReason[]): OpsReasonBucket[] {
  const buckets = new Map<string, { count: number; firstSeenAt: string; lastSeenAt: string }>();
  for (const { reason, createdAt } of rows) {
    const existing = buckets.get(reason);
    if (!existing) {
      buckets.set(reason, { count: 1, firstSeenAt: createdAt, lastSeenAt: createdAt });
      continue;
    }
    existing.count += 1;
    if (createdAt < existing.firstSeenAt) existing.firstSeenAt = createdAt;
    if (createdAt > existing.lastSeenAt) existing.lastSeenAt = createdAt;
  }
  return Array.from(buckets.entries())
    .map(([reason, bucket]) => ({ reason, ...bucket }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, MAX_REASON_BUCKETS);
}

/** Reduce a broker/validation error string to a short reason key.
 *
 * Broker adapter errors arrive wrapped, and the same underlying refusal differs on every
 * occurrence:
 *  - a transport prefix ("HTTP 422: bracket orders must be entry orders" vs "HTTP 400: ...");
 *  - JSON nested one to three levels deep — Robinhood's "Fractional orders must be at least $1"
 *    arrives as `place_equity_order response had no order id: {"text":"API error 400:
 *    {\"non_field_errors\":[\"Fractional orders must be at least $1...\"]}"}`;
 *  - a dynamic amount inside the sentence ("at least $1" vs "at least $5").
 * Without collapsing those, 11 rejections of one rule read as 11 causes.
 *
 * Unwraps up to three levels of JSON looking for the innermost sentence (`non_field_errors[0]`,
 * `detail`, `text`, `message`, `error`), strips a leading `HTTP <code>:` / `API error <code>:`,
 * then collapses dollar amounts to `$N` and other bare numbers to `#`.  Best effort and never
 * throws: a message that will not unwrap (truncated mid-JSON, say) is still normalised and
 * returned, and an empty one returns `undefined` so the caller can decide what an unexplained row
 * is called.  Deliberately NOT a full canonicaliser — merging genuinely different refusals is
 * worse than under-merging.  Same caveat as `topBlockReasons`.  Capped at 160 characters. */
export function normalizeBrokerRejectionReason(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  let text = raw.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    const jsonStart = text.indexOf("{");
    if (jsonStart === -1) break;
    let inner: string | undefined;
    try {
      const parsed = JSON.parse(text.slice(jsonStart)) as Record<string, unknown> | null;
      const nonField = parsed?.non_field_errors;
      const candidates: unknown[] = [
        Array.isArray(nonField) ? nonField[0] : undefined,
        parsed?.detail,
        parsed?.text,
        parsed?.message,
        parsed?.error
      ];
      inner = candidates.find((c): c is string => typeof c === "string" && c.trim().length > 0);
    } catch {
      // Not valid JSON at this level — the stored message is often cut off mid-string, which is
      // exactly what happened to the Robinhood account-questionnaire error.  Take the sentence
      // that follows the first recognisable error key instead of leaving the whole wrapper as the
      // reason, so a truncated row still lands in the same bucket as its untruncated siblings.
      const salvaged = /\b(?:non_field_errors|detail|message)\b\W{1,8}([^"\\]{8,})/i.exec(text.slice(jsonStart));
      if (salvaged) text = salvaged[1].trim();
      break;
    }
    if (!inner) break;
    text = inner.trim();
  }
  const normalized = text
    .replace(/^(?:HTTP|API error)\s+\d{3}\s*[:\-]?\s*/i, "")
    .replace(/\$\d+(?:\.\d+)?/g, "$N")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return normalized || undefined;
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

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function emptyProposalFunnel(windowDays: number): OpsProposalFunnel {
  return {
    windowDays,
    counts: [],
    byModel: [],
    topBlockReasons: [],
    blockReasonRowsCapped: false,
    holdReasons: [],
    holdReasonRowsCapped: false,
    brokerRejectionReasons: [],
    brokerRejectionRowsCapped: false,
    placingFailureReasons: [],
    placingFailureRowsCapped: false
  };
}

interface OpsMark {
  price: number;
  /** ISO time the price was observed (stored rows) or fetched (live snapshot). */
  asOf: string;
}

/** Per-build mark state: marks already obtained (a ticker held in several accounts is marked once),
 *  symbols already attempted (a failed one is not retried by the next account), and how much of the
 *  live-fetch budget is already spent. */
interface OpsQuoteContext {
  mode: OpsMarksMode;
  marks: Map<string, OpsMark>;
  attempted: Set<string>;
  /** Milliseconds spent waiting on live fetches so far in this build. */
  spentMs: number;
}

/** The oldest observation time among the marks in use, as ISO, or null when there are none. */
function oldestMarkAsOf(marks: OpsMark[]): string | null {
  let oldest: number | null = null;
  for (const mark of marks) {
    const at = Date.parse(mark.asOf);
    if (Number.isFinite(at) && (oldest === null || at < oldest)) oldest = at;
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}

/** Stored latest-price rows for `symbols`, minus any whose observation time is unparseable or older
 *  than the cutoff.  One indexed read; never throws (a read failure leaves them unpriced). */
function readStoredMarks(symbols: string[], nowMs: number): Record<string, OpsMark> {
  const out: Record<string, OpsMark> = {};
  let stored: ReturnType<typeof getSymbolLatestPrices>;
  try {
    stored = getSymbolLatestPrices(symbols);
  } catch {
    return out;
  }
  for (const [rawSymbol, row] of Object.entries(stored)) {
    const symbol = normalizeSymbol(rawSymbol);
    const at = Date.parse(row.asOf);
    if (!symbol || !Number.isFinite(at) || nowMs - at > OPS_STORED_MARK_MAX_AGE_MS) continue;
    if (typeof row.price === "number" && Number.isFinite(row.price) && row.price > 0) {
      out[symbol] = { price: row.price, asOf: new Date(at).toISOString() };
    }
  }
  return out;
}

/**
 * One bounded Alpaca market-data snapshot batch (`marks=live` only).  Deliberately NOT the trading
 * quote cascade: no policy read (so it can never seed a policy row), no broker gateway (whose
 * per-symbol close-history fan-out ignores an abort), no Finnhub/Tiingo/Yahoo/ROIC tiers.  Returns
 * whatever it could price; a timeout or provider error returns {} and the caller keeps its stored
 * marks.  Only strictly positive prices count - a zero or missing quote is unpriced, never a $0 mark.
 */
async function fetchLiveSnapshotMarks(symbols: string[], userId: string, timeoutMs: number): Promise<Record<string, OpsMark>> {
  const out: Record<string, OpsMark> = {};
  try {
    const creds = resolveAlpacaMarketData(userId);
    if (!creds.apiKey || !creds.secretKey) return out;
    const provider = new AlpacaSnapshotEnrichmentProvider(creds.apiKey, creds.secretKey, creds.source, userId);
    const enrichment = await withDeadline(
      provider.enrich(symbols),
      timeoutMs,
      `ops-performance live snapshot timed out after ${timeoutMs}ms`
    );
    const fetchedAt = new Date().toISOString();
    for (const symbol of symbols) {
      const data = enrichment[symbol];
      if (!data) continue;
      const price = data.price ?? (data.bid && data.ask ? (data.bid + data.ask) / 2 : undefined);
      if (typeof price === "number" && Number.isFinite(price) && price > 0) {
        const at = data.asOf ? Date.parse(data.asOf) : NaN;
        out[symbol] = { price, asOf: Number.isFinite(at) ? new Date(at).toISOString() : fetchedAt };
      }
    }
  } catch {
    // Timed out or the provider threw: the stored marks the caller already holds stand.
  }
  return out;
}

/**
 * Marks for one account's open symbols.  Never throws and never blocks past its budget.  Stored
 * latest-price rows are read first (memoised per build); `live` mode then upgrades up to
 * `OPS_QUOTE_MAX_SYMBOLS` of them from one snapshot batch under the per-account and per-request
 * time budgets.  Returns the mark for every requested symbol that has one, including ones
 * memoised earlier in the same build.
 */
async function resolveOpsMarks(symbols: string[], userId: string, ctx: OpsQuoteContext): Promise<Record<string, OpsMark>> {
  const out: Record<string, OpsMark> = {};
  if (ctx.mode === "off") return out;

  const fresh: string[] = [];
  for (const symbol of symbols) {
    const known = ctx.marks.get(symbol);
    if (known) out[symbol] = known;
    else if (!ctx.attempted.has(symbol)) fresh.push(symbol);
  }
  if (fresh.length === 0) return out;

  const slice = fresh.slice(0, OPS_MARK_MAX_SYMBOLS);
  const marks = readStoredMarks(slice, Date.now());

  if (ctx.mode === "live") {
    const timeoutMs = Math.min(OPS_QUOTE_FETCH_TIMEOUT_MS, OPS_QUOTE_TOTAL_BUDGET_MS - ctx.spentMs);
    if (timeoutMs > 0) {
      const startedAt = Date.now();
      try {
        Object.assign(marks, await fetchLiveSnapshotMarks(slice.slice(0, OPS_QUOTE_MAX_SYMBOLS), userId, timeoutMs));
      } finally {
        ctx.spentMs += Math.max(0, Date.now() - startedAt);
      }
    }
  }

  for (const symbol of slice) {
    ctx.attempted.add(symbol);
    const mark = marks[symbol];
    if (mark) {
      ctx.marks.set(symbol, mark);
      out[symbol] = mark;
    }
  }
  return out;
}

export interface BuildOpsPerformanceInput {
  /** Narrow to one connectedAccountId (across every user) — omit for every account the ops
   *  snapshot covers, mirroring `/api/ops/snapshot`'s all-users iteration. */
  connectedAccountId?: string;
  days?: number;
  /** How to mark open positions for unrealized P&L (default `stored`: one indexed read of the
   *  latest-price rows, no network).  `live` adds one bounded Alpaca snapshot batch; `off` skips
   *  marking, and open positions are then reported unpriced rather than as a $0 mark. */
  marks?: OpsMarksMode;
}

export async function buildOpsPerformanceSnapshot(input: BuildOpsPerformanceInput = {}): Promise<OpsPerformanceSnapshot> {
  const windowDays = clampDays(input.days);
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const marksMode: OpsMarksMode = input.marks ?? "stored";
  const quoteCtx: OpsQuoteContext = {
    mode: marksMode,
    marks: new Map(),
    attempted: new Set(),
    spentMs: 0
  };

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
          // Nothing was computed, so there is nothing that needed a price.
          pricesUnavailable: false,
          unrealizedUnpricedSymbols: [],
          unrealizedMarkBasis: marksMode,
          unrealizedMarksOldestAsOf: null,
          liveRealizedPnl: 0,
          paperRealizedPnl: 0,
          liveUnrealizedPnl: 0,
          paperUnrealizedPnl: 0,
          tradeStats: { windowDays, tradeCount: 0, winRate: 0, expectancyUsd: 0 },
          roundTripStats: { windowDays, tradeCount: 0, winRate: 0, expectancyUsd: 0, incompleteRoundTrips: 0, lotsGraded: 0 },
          thesisScorecard: [],
          redTeamEfficacy: safeRedTeamEfficacy(userId, { connectedAccountId: account.id, auditLimit: OPS_RED_TEAM_AUDIT_LIMIT }),
          modelAttribution: [],
          proposalFunnel: emptyProposalFunnel(windowDays),
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
        // FIFO runs with NO prices: its `openLots` tell us which symbols need a mark, and the
        // unrealized figure is then applied to those lots below without a second ledger walk.
        const livePnl: PnlResult = calculatePnl(liveFills, {});
        const paperPnl: PnlResult = calculatePnl(paperFills, {});
        const prefetched = { liveFills, paperFills };
        const prefetchedPnl = { live: livePnl, paper: paperPnl };

        const openSymbols = openLotSymbols(livePnl.openLots, paperPnl.openLots);
        const opsMarks = openSymbols.length > 0 ? await resolveOpsMarks(openSymbols, userId, quoteCtx) : {};
        const marks: Record<string, number> = {};
        for (const [symbol, mark] of Object.entries(opsMarks)) marks[symbol] = mark.price;
        const unpricedSymbols = openSymbols.filter((symbol) => marks[symbol] === undefined).sort();
        const liveUnrealizedPnl = unrealizedFromOpenLots(livePnl.openLots, marks);
        const paperUnrealizedPnl = unrealizedFromOpenLots(paperPnl.openLots, marks);
        const pricesUnavailable = openSymbols.length > 0 && unpricedSymbols.length === openSymbols.length;

        // Realized P&L and the equity curve never depend on a live quote; only unrealized does,
        // and that is overridden below from `marks`.
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
          pricesUnavailable,
          unrealizedUnpricedSymbols: unpricedSymbols,
          unrealizedMarkBasis: marksMode,
          unrealizedMarksOldestAsOf: oldestMarkAsOf(Object.values(opsMarks)),
          liveRealizedPnl: performance.liveRealizedPnl,
          paperRealizedPnl: performance.paperRealizedPnl,
          liveUnrealizedPnl: round2(liveUnrealizedPnl),
          paperUnrealizedPnl: round2(paperUnrealizedPnl),
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
          // The account errored before it could be priced: unknown, not "nothing to price".
          pricesUnavailable: true,
          unrealizedUnpricedSymbols: [],
          unrealizedMarkBasis: marksMode,
          unrealizedMarksOldestAsOf: null,
          liveRealizedPnl: 0,
          paperRealizedPnl: 0,
          liveUnrealizedPnl: 0,
          paperUnrealizedPnl: 0,
          tradeStats: { windowDays, tradeCount: 0, winRate: 0, expectancyUsd: 0 },
          roundTripStats: { windowDays, tradeCount: 0, winRate: 0, expectancyUsd: 0, incompleteRoundTrips: 0, lotsGraded: 0 },
          thesisScorecard: [],
          redTeamEfficacy: safeRedTeamEfficacy(userId, { connectedAccountId: account.id, auditLimit: OPS_RED_TEAM_AUDIT_LIMIT }),
          modelAttribution: [],
          proposalFunnel: emptyProposalFunnel(windowDays),
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
  return `${input.connectedAccountId ?? "*"}\0${clampDays(input.days)}\0${input.marks ?? "stored"}`;
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
