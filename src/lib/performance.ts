import { getMaturedSkippedCounterfactualByRunSymbol, getPolicy, getSkippedCounterfactualCoverage, insertFillEvent, insertPortfolioSnapshot, listAudit, listAuditByKind, listFillEvents, listMaturedSkippedCounterfactuals, listPortfolioSnapshots, listSkippedCounterfactualsByStatus, recordTakeProfitTrimBand, type SkippedCounterfactualCoverage } from "./db";
import { applyExecutionCost, estimateExecutionCostBps, executionCostConfig } from "./execution-cost";
import { normalizeSymbol } from "./money";
import type {
  EquityPosition,
  ExecutedOrder,
  ExecutionMode,
  FillEvent,
  FillSource,
  MarketFactor,
  MarketFactorBreakdown,
  MarketScan,
  PerformanceSummary,
  Portfolio,
  ReviewedOrder,
  RunAttribution,
  OrderSide,
  TradeProposal
} from "./types";

/**
 * Side-adjusted % move from a proposal's entry anchor to a current price. Positive means the
 * proposed direction worked (a long that rose / a short that fell). For a REJECTED proposal this is
 * the realized counterfactual ("what it did since we passed"). Returns undefined when either price is
 * missing/non-positive so callers can omit the figure rather than show a misleading 0.
 */
export function returnSinceProposalPct(
  referencePrice: number | undefined,
  currentPrice: number | undefined,
  side: OrderSide
): number | undefined {
  if (referencePrice == null || !(referencePrice > 0) || currentPrice == null || !(currentPrice > 0)) return undefined;
  const raw = ((currentPrice - referencePrice) / referencePrice) * 100;
  // Sign convention by intended benefit direction, not just open/close:
  //   price-up-is-good   = { buy (open long), cover (close short) } -> keep raw
  //   price-down-is-good = { short (open short), sell (close long) } -> negate raw
  // So a proposed sell followed by a price drop reads as "the call worked" (positive).
  const adjusted = side === "sell" || side === "short" ? -raw : raw;
  return Math.round(adjusted * 100) / 100;
}

export interface ClosedLot {
  pnl: number;
  returnPct: number;
  symbol?: string;
  thesisTag?: string;
  regime?: string;
  side?: "long" | "short";
  entryPrice?: number;
  entryAt?: string;
  exitAt?: string;
  /** Run that opened this lot — joins to the per-run `signal_snapshot` audit for efficacy analysis. */
  entryRunId?: string;
  /** Agent confidence (1–100) assigned to the opening proposal, for calibration analysis. */
  confidence?: number;
  /** Sector the position was opened in (stamped at fill time), for the sector dimension. */
  sector?: string;
  /** Dominant scan factor at entry (stamped at fill time). Preferred by getFactorScorecard over the
   * signal_snapshot lookup, so per-factor attribution survives after the entry snapshot ages out. */
  dominantFactor?: MarketFactor;
  /** Max Adverse Excursion (% from entry price, typically negative for longs) persisted after post-mortem. */
  mae?: number;
  /** Max Favorable Excursion (% from entry price, typically positive for longs) persisted after post-mortem. */
  mfe?: number;
}

/** Realized-outcome stats grouped by the thesis a position was opened under. */
export interface ThesisStat {
  thesisTag: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  shrunkWinRate: number;
  shrunkAvgReturnPct: number;
  /** Average calendar days held; undefined when lots lack entryAt/exitAt timestamps. */
  avgDaysHeld?: number;
  /** % of lots held < 365 days (short-term capital gains); undefined when no timestamp data. */
  shortTermPct?: number;
}

/** Realized-outcome stats grouped by the market regime a position was opened in. */
export interface RegimeStat {
  regime: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  shrunkWinRate: number;
  shrunkAvgReturnPct: number;
  avgDaysHeld?: number;
  shortTermPct?: number;
}

/** An open (unclosed) tax lot with its entry date, for holding-period / tax analysis. */
export interface OpenLot {
  symbol: string;
  quantity: number;
  entryPrice: number;
  side: "long" | "short";
  entryAt?: string;
}

interface PnlResult {
  realized: number;
  unrealized: number;
  closedLots: ClosedLot[];
  openLots: OpenLot[];
  attribution: RunAttribution[];
}

export function recordPortfolioSnapshot(input: {
  userId?: string;
  runId?: string;
  accountNumber: string;
  source: FillSource;
  executionMode?: ExecutionMode;
  portfolio: Portfolio;
  positions: EquityPosition[];
}) {
  return insertPortfolioSnapshot({
    userId: input.userId,
    runId: input.runId,
    accountNumber: input.accountNumber,
    source: input.source,
    executionMode: input.executionMode,
    equity: input.portfolio.totalMarketValue,
    cash: input.portfolio.cash,
    buyingPower: input.portfolio.buyingPower,
    positionsValue: input.portfolio.equityMarketValue,
    positions: input.positions
  });
}

export function recordFillFromProposal(input: {
  userId?: string;
  accountNumber: string;
  proposalId?: string;
  runId?: string;
  source: FillSource;
  executionMode?: ExecutionMode;
  proposal: TradeProposal;
  review?: ReviewedOrder;
  execution?: ExecutedOrder;
  marketScan?: MarketScan;
  status?: string;
}): FillEvent {
  const symbol = normalizeSymbol(input.proposal.symbol);
  const marketPrice = input.marketScan?.quotesBySymbol[symbol]?.price;
  const executionPrice = input.execution?.averagePrice;
  const proposedPrice = input.proposal.limitPrice ?? input.proposal.stopPrice;
  const notional = input.review?.estimatedNotional ?? input.proposal.dollarAmount ?? 0;
  const quantityInput = positiveNumber(input.execution?.filledQuantity) ?? positiveNumber(input.proposal.quantity);
  const impliedPrice = quantityInput && notional > 0 ? notional / quantityInput : undefined;
  const reviewPrice = priceFromReview(input.review?.raw);
  const basePrice =
    positiveNumber(executionPrice) ??
    positiveNumber(proposedPrice) ??
    positiveNumber(marketPrice) ??
    positiveNumber(reviewPrice) ??
    positiveNumber(impliedPrice) ??
    0;
  // Deterministic execution-cost model for SIMULATED fills (default ON). Real broker (live) fills
  // already carry their realized price, so only paper fills are adjusted — this makes the learning
  // loop net-of-cost rather than certifying a frictionless edge that won't survive a live fill.
  // Disable by setting PAPER_EXECUTION_COST_MODEL=off.
  const costCfg = executionCostConfig();
  let price = basePrice;
  if (costCfg.enabled && input.source === "paper" && basePrice > 0) {
    // bid/ask come from either the trimmed summary or the full candidate; daily volume (for the
    // sqrt-impact term) is only on the full topCandidates quote. When the symbol isn't a scan
    // candidate (e.g. an exit of a held name) the impact term is simply omitted.
    const full = input.marketScan?.topCandidates.find((c) => normalizeSymbol(c.symbol) === symbol);
    const summary = input.marketScan?.quotesBySymbol[symbol];
    const bid = full?.bid ?? summary?.bid;
    const ask = full?.ask ?? summary?.ask;
    const spreadBps =
      typeof bid === "number" && typeof ask === "number" && bid > 0 && ask > 0
        ? ((ask - bid) / ((ask + bid) / 2)) * 1e4
        : undefined;
    const dollarVol = full && full.price > 0 && full.volume > 0 ? full.price * full.volume : undefined;
    const orderNotional = (quantityInput && quantityInput > 0 ? quantityInput * basePrice : notional) || 0;
    const costBps = estimateExecutionCostBps({
      spreadBps,
      orderNotional,
      dollarVol,
      baseSlippageBps: costCfg.baseSlippageBps,
      impactCoeff: costCfg.impactCoeff
    });
    price = applyExecutionCost(basePrice, input.proposal.side, costBps);
  }
  const quantity =
    quantityInput ?? (price > 0 && notional > 0 ? notional / price : 0);
  const finalNotional =
    quantity > 0 && price > 0
      ? quantity * price
      : input.proposal.dollarAmount ?? (notional > 0 ? notional : 0);

  // The symbol's full scan candidate at fill time (factor breakdown source for the entry stamps below).
  const entryCandidate = input.marketScan?.topCandidates.find((c) => normalizeSymbol(c.symbol) === symbol);

  const fill = insertFillEvent({
    userId: input.userId,
    proposalId: input.proposalId,
    runId: input.runId,
    accountNumber: input.accountNumber,
    source: input.source,
    executionMode: input.executionMode,
    symbol,
    side: input.proposal.side,
    quantity,
    price,
    notional: Math.abs(finalNotional),
    status: input.status ?? (input.source === "paper" ? "filled" : "pending_reconciliation"),
    brokerOrderId: input.execution?.orderId,
    // Stamp the symbol's sector at fill time so closed lots can be grouped by sector
    // for the sector learning dimension (sector isn't on the proposal itself).
    // B5: also stamp the dominant scan factor at ENTRY (opening sides only), mirroring the sector stamp.
    // getFactorScorecard prefers this persisted value so per-factor attribution survives even after the
    // entry's signal_snapshot ages out of the 500-row listAudit window — the real coverage-decay hazard.
    raw: {
      proposal: input.proposal,
      review: input.review,
      execution: input.execution,
      sector: input.marketScan?.quotesBySymbol[symbol]?.sector,
      ...((input.proposal.side === "buy" || input.proposal.side === "short")
        ? {
            dominantFactor: dominantFactor(entryCandidate?.factorBreakdown),
            // Episodic experience memory (2026-07-04 composite review A1): also stamp the FULL
            // 8-factor breakdown + scan breadth at ENTRY, so the closed-lot experience vector can
            // embed the entry-time state instead of a lookahead reconstruction at exit. Additive
            // raw fields only — existing readers (thesisMetaFromFill) are unaffected.
            ...(entryCandidate?.factorBreakdown ? { factorBreakdown: entryCandidate.factorBreakdown } : {}),
            ...(typeof input.marketScan?.breadthPct === "number" ? { scanBreadthPct: input.marketScan.breadthPct } : {})
          }
        : {})
    }
  });

  // Advance the take-profit trim ratchet ONLY now that the trim has actually been placed/filled — a
  // proposed / policy-blocked / rejected trim never reaches recordFillFromProposal, so it's re-offered next
  // run instead of silently ratcheting past its band. Keyed to the lot's cost basis for close+rebuy resets.
  if (typeof input.proposal.takeProfitBand === "number") {
    try {
      recordTakeProfitTrimBand(input.accountNumber, symbol, input.proposal.takeProfitBand, input.proposal.takeProfitBasis ?? 0, input.userId);
    } catch {
      // ratchet bookkeeping must never break fill recording
    }
  }

  // Episodic experience memory write hook (2026-07-04 composite review A1): a sell/cover fill may
  // have just CLOSED one or more lots — embed each closed lot's entry state + realized outcome into
  // the experience-memory vector namespace, keyed by the entry proposalId. Strictly fire-and-forget:
  // the dynamic import + async body keep this sync function's signature and money-path behavior
  // untouched, and any failure (no vector keys, no matched lot, provider error) degrades to a
  // console warning inside recordClosedLotExperience (which never throws).
  if (input.proposal.side === "sell" || input.proposal.side === "cover") {
    void import("./experience-memory")
      .then((experienceMemory) =>
        experienceMemory.recordClosedLotExperience({
          userId: input.userId,
          accountNumber: input.accountNumber,
          source: input.source,
          closingFill: fill,
          closingProposal: input.proposal
        })
      )
      .catch((err) => {
        console.warn("[performance] experience-memory hook failed:", err instanceof Error ? err.message : String(err));
      });
  }
  return fill;
}

/**
 * Optional pre-fetched fill arrays so a single request (e.g. the dashboard snapshot) can fetch
 * live + paper fills ONCE and thread them into every consumer instead of each function re-issuing
 * its own `listFillEvents` SELECT + JSON.parse + FIFO replay. When omitted, each function fetches
 * internally exactly as before — so every other caller keeps working unchanged.
 */
export interface PrefetchedFills {
  liveFills?: FillEvent[];
  paperFills?: FillEvent[];
}

/** Resolve the fills for a single `FillSource`, preferring pre-fetched arrays when supplied. */
function fillsForSource(
  accountNumber: string,
  source: FillSource | undefined,
  userId: string,
  prefetched?: PrefetchedFills
): FillEvent[] {
  if (prefetched) {
    if (source === "live") return prefetched.liveFills ?? listFillEvents(accountNumber, "live", 500, userId);
    if (source === "paper") return prefetched.paperFills ?? listFillEvents(accountNumber, "paper", 500, userId);
    // No source filter: combine both pre-fetched arrays only when BOTH are present, so the result
    // is identical to the unfiltered SELECT for the common (well under 500 rows per source) case.
    if (prefetched.liveFills && prefetched.paperFills) {
      return [...prefetched.liveFills, ...prefetched.paperFills].sort((a, b) => a.filledAt.localeCompare(b.filledAt));
    }
  }
  return listFillEvents(accountNumber, source, 500, userId);
}

export function getPerformanceSummary(
  accountNumber: string,
  currentPrices: Record<string, number> = {},
  userId: string = "local",
  prefetched?: PrefetchedFills
): PerformanceSummary {
  const liveFills = prefetched?.liveFills ?? listFillEvents(accountNumber, "live", 500, userId);
  const paperFills = prefetched?.paperFills ?? listFillEvents(accountNumber, "paper", 500, userId);
  const allFills = [...liveFills, ...paperFills].sort((a, b) => a.filledAt.localeCompare(b.filledAt));
  const livePnl = calculatePnl(liveFills, currentPrices);
  const paperPnl = calculatePnl(paperFills, currentPrices);
  const liveSnapshots = listPortfolioSnapshots(accountNumber, "live", 100, userId);
  const paperSnapshots = listPortfolioSnapshots(accountNumber, "paper", 100, userId);

  return {
    liveEquityCurve: liveSnapshots.map((snapshot) => ({
      timestamp: snapshot.createdAt,
      equity: snapshot.equity,
      source: "live",
      // Cash rides along so the SPY benchmark can infer external deposits/withdrawals
      // (time-weighted return) instead of counting a transfer as a gain/loss.
      cash: snapshot.cash
    })),
    paperEquityCurve:
      paperSnapshots.length > 0
        ? paperSnapshots.map((snapshot) => ({ timestamp: snapshot.createdAt, equity: snapshot.equity, source: "paper", cash: snapshot.cash }))
        : syntheticPaperCurve(paperFills),
    liveRealizedPnl: livePnl.realized,
    paperRealizedPnl: paperPnl.realized,
    liveUnrealizedPnl: livePnl.unrealized,
    paperUnrealizedPnl: paperPnl.unrealized,
    liveWinRate: winRate(livePnl.closedLots),
    paperWinRate: winRate(paperPnl.closedLots),
    liveAverageReturnPct: averageReturn(livePnl.closedLots),
    paperAverageReturnPct: averageReturn(paperPnl.closedLots),
    attribution: combineAttribution(livePnl.attribution, paperPnl.attribution),
    fills: allFills.slice(-100)
  };
}

export function calculatePnl(fills: FillEvent[], currentPrices: Record<string, number> = {}): PnlResult {
  const lots = new Map<
    string,
    Array<{
      quantity: number;
      price: number;
      runId?: string;
      side: "long" | "short";
      thesisTag?: string;
      regime?: string;
      confidence?: number;
      sector?: string;
      dominantFactor?: MarketFactor;
      entryAt?: string;
    }>
  >();
  const closedLots: ClosedLot[] = [];
  const attribution = new Map<string, RunAttribution>();
  let realized = 0;

  for (const fill of fills.filter(isAccountingFill).sort((a, b) => a.filledAt.localeCompare(b.filledAt))) {
    const symbol = normalizeSymbol(fill.symbol);
    if (!lots.has(symbol)) lots.set(symbol, []);

    if (fill.side === "buy" || fill.side === "short") {
      const meta = thesisMetaFromFill(fill);
      lots.get(symbol)!.push({
        quantity: fill.quantity,
        price: fill.price,
        runId: fill.runId,
        side: fill.side === "buy" ? "long" : "short",
        thesisTag: meta.thesisTag,
        regime: meta.regime,
        confidence: meta.confidence,
        sector: meta.sector,
        dominantFactor: meta.dominantFactor,
        entryAt: fill.filledAt
      });
      addAttribution(attribution, fill, 0);
      continue;
    }

    // A closing fill matches only OPENING lots of the correct side: a "sell" closes
    // "long" lots, a "cover" closes "short" lots. Select the first SAME-SIDE lot (FIFO)
    // and skip opposite-side lots — never consume an opposite-side lot at $0 P&L, which
    // would silently erase a real open position from the books.
    const wantSide: "long" | "short" = fill.side === "cover" ? "short" : "long";
    let remaining = fill.quantity;
    const symbolLots = lots.get(symbol)!;
    while (remaining > 0) {
      const idx = symbolLots.findIndex((l) => l.side === wantSide);
      if (idx === -1) break; // no matching open lot to close against
      const lot = symbolLots[idx];
      const matched = Math.min(remaining, lot.quantity);
      const pnl = fill.side === "cover"
        ? matched * (lot.price - fill.price)
        : matched * (fill.price - lot.price);
      const returnPct = lot.price > 0
        ? (fill.side === "cover" ? (lot.price - fill.price) / lot.price : (fill.price - lot.price) / lot.price) * 100
        : 0;
      realized += pnl;
      // Attribute the realized outcome to the thesis/regime the lot was *opened* under,
      // and carry entry/exit context for excursion (MAE/MFE) analysis.
      closedLots.push({
        pnl,
        returnPct,
        symbol,
        thesisTag: lot.thesisTag,
        regime: lot.regime,
        side: lot.side,
        entryPrice: lot.price,
        entryAt: lot.entryAt,
        exitAt: fill.filledAt,
        entryRunId: lot.runId,
        confidence: lot.confidence,
        sector: lot.sector,
        dominantFactor: lot.dominantFactor,
        mae: fill.mae,
        mfe: fill.mfe
      });
      addAttribution(attribution, fill, pnl);
      // Change A: dual-sided credit — also credit the ENTRY run (the run that opened this lot).
      // Guard prevents double-counting when the same run opened and closed (that run already
      // gets the realized P&L via realizedPnl/realizedPnlAsExit from the addAttribution call).
      if (lot.runId && lot.runId !== (fill.runId ?? "manual")) {
        addEntryAttribution(attribution, lot.runId, pnl);
      }
      lot.quantity -= matched;
      remaining -= matched;
      if (lot.quantity <= 0.000001) symbolLots.splice(idx, 1);
    }
  }

  let unrealized = 0;
  const openLots: OpenLot[] = [];
  for (const [symbol, symbolLots] of lots) {
    const current = currentPrices[symbol];
    for (const lot of symbolLots) {
      if (Math.abs(lot.quantity) > 0.000001) {
        // Signed quantity: positive for longs, negative for shorts (matches EquityPosition convention)
        const signedQty = lot.side === "short" ? -lot.quantity : lot.quantity;
        openLots.push({ symbol, quantity: signedQty, entryPrice: lot.price, side: lot.side, entryAt: lot.entryAt });
      }
      if (!current) continue;
      if (lot.side === "long") {
        unrealized += lot.quantity * (current - lot.price);
      } else {
        unrealized += lot.quantity * (lot.price - current);
      }
    }
  }

  return {
    realized,
    unrealized,
    closedLots,
    openLots,
    attribution: Array.from(attribution.values()).sort((a, b) => a.runId.localeCompare(b.runId))
  };
}

/**
 * Per-thesis realized-outcome scorecard for the learning loop: how each
 * `tradeThesisTag` has actually performed once positions closed. Computed
 * deterministically in code (no LLM tokens) so it can be fed back to the agent
 * cheaply as high-signal "what has worked vs lost" context.
 */
export function getThesisScorecard(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local",
  prefetched?: PrefetchedFills
): ThesisStat[] {
  const { closedLots } = calculatePnl(fillsForSource(accountNumber, source, userId, prefetched), currentPrices);
  return aggregateClosedLots(
    closedLots,
    (lot) => (lot.thesisTag && lot.thesisTag.trim() ? lot.thesisTag.trim() : "Untagged"),
    userId
  ).map(({ key, ...rest }) => ({ thesisTag: key, ...rest }));
}

export function getRegimeScorecard(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local",
  prefetched?: PrefetchedFills
): RegimeStat[] {
  const { closedLots } = calculatePnl(fillsForSource(accountNumber, source, userId, prefetched), currentPrices);
  return aggregateClosedLots(
    closedLots,
    (lot) => (lot.regime && lot.regime.trim() ? lot.regime.trim() : "Unspecified"),
    userId
  ).map(({ key, ...rest }) => ({ regime: key, ...rest }));
}

/** Realized-outcome stats grouped by the sector a position was opened in. */
export interface SectorStat {
  sector: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  shrunkWinRate: number;
  shrunkAvgReturnPct: number;
  avgDaysHeld?: number;
  shortTermPct?: number;
}

export function getSectorScorecard(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local",
  prefetched?: PrefetchedFills
): SectorStat[] {
  const { closedLots } = calculatePnl(fillsForSource(accountNumber, source, userId, prefetched), currentPrices);
  return aggregateClosedLots(
    closedLots,
    (lot) => (lot.sector && lot.sector.trim() ? lot.sector.trim() : "Unknown"),
    userId
  ).map(({ key, ...rest }) => ({ sector: key, ...rest }));
}

/** Closed lots with entry/exit context, oldest-first, for excursion (MAE/MFE) analysis. */
export function getClosedLotsDetailed(
  accountNumber: string,
  source?: FillSource,
  userId: string = "local",
  prefetched?: PrefetchedFills
): ClosedLot[] {
  return calculatePnl(fillsForSource(accountNumber, source, userId, prefetched)).closedLots;
}

/**
 * Combined thesis × regime realized scorecard — the multi-dimensional learning
 * bucket. A thesis that wins in a Tech-Bull regime may lose in a High-Vol regime;
 * crossing the two surfaces those conditional edges. Shrunk like the 1-D cards so
 * thin buckets don't mislead. (Sector is a further dimension but isn't reliably
 * carried on closed lots yet — see docs/phase-9-web-sources.md follow-ups.)
 */
export interface ThesisRegimeStat {
  thesisTag: string;
  regime: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  shrunkWinRate: number;
  shrunkAvgReturnPct: number;
  avgDaysHeld?: number;
  shortTermPct?: number;
}

const THESIS_REGIME_SEP = " @ ";

export function getThesisRegimeScorecard(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local",
  prefetched?: PrefetchedFills
): ThesisRegimeStat[] {
  const { closedLots } = calculatePnl(fillsForSource(accountNumber, source, userId, prefetched), currentPrices);
  return aggregateClosedLots(closedLots, (lot) => {
    const thesis = lot.thesisTag?.trim() || "Untagged";
    const regime = lot.regime?.trim() || "Unspecified";
    return `${thesis}${THESIS_REGIME_SEP}${regime}`;
  }, userId).map(({ key, ...rest }) => {
    const sep = key.indexOf(THESIS_REGIME_SEP);
    return { thesisTag: key.slice(0, sep), regime: key.slice(sep + THESIS_REGIME_SEP.length), ...rest };
  });
}

/** Number of closed (realized) lots — the sample size that gates learned weight shifts. */
export function getClosedLotCount(
  accountNumber: string,
  source?: FillSource,
  userId: string = "local",
  prefetched?: PrefetchedFills
): number {
  return calculatePnl(fillsForSource(accountNumber, source, userId, prefetched)).closedLots.length;
}

/**
 * Realized win rate of long entries that DID vs DID NOT have a given evidence signal
 * at entry — so the agent can learn which signals actually predict winners rather than
 * trusting them on faith. Joins closed lots to the per-run `signal_snapshot` audit via
 * the opening run id. Compare each signal bucket's win rate to "All buys (baseline)".
 */
export interface SignalEfficacyStat {
  signal: string;
  trades: number;
  winRate: number;
  shrunkWinRate: number;
  avgReturnPct: number;
}

export function getSignalEfficacy(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local",
  prefetched?: PrefetchedFills
): SignalEfficacyStat[] {
  const { closedLots } = calculatePnl(fillsForSource(accountNumber, source, userId, prefetched), currentPrices);
  if (closedLots.length === 0) return [];

  // runId|symbol -> entry signals, from the signal_snapshot audit trail. The snapshot
  // now records the full scored set (chosen + skipped); only CHOSEN entries can have a
  // matching closed lot, so skip the rest (older snapshots predate the flag → undefined,
  // which we keep, preserving the chosen-only behavior they had).
  const signalByKey = new Map<string, { congressNet?: number; congressCompositeScore?: number; congressCompositeDirection?: string; insiderSentiment?: number }>();
  for (const event of listAudit(500, userId)) {
    if (event.kind !== "signal_snapshot") continue;
    const payload = event.payload as { runId?: string; signals?: Array<{ symbol?: string; chosen?: boolean; congressNet?: number; congressCompositeScore?: number; congressCompositeDirection?: string; insiderSentiment?: number }> };
    if (!payload?.runId || !Array.isArray(payload.signals)) continue;
    for (const s of payload.signals) {
      if (!s.symbol || s.chosen === false) continue;
      signalByKey.set(`${payload.runId}|${normalizeSymbol(s.symbol)}`, {
        congressNet: s.congressNet,
        congressCompositeScore: s.congressCompositeScore,
        congressCompositeDirection: s.congressCompositeDirection,
        insiderSentiment: s.insiderSentiment
      });
    }
  }

  const buckets = new Map<string, { wins: number; trades: number; returnSum: number }>();
  const bump = (name: string, lot: ClosedLot) => {
    const b = buckets.get(name) ?? { wins: 0, trades: 0, returnSum: 0 };
    b.trades += 1;
    b.wins += lot.pnl > 0 ? 1 : 0;
    b.returnSum += lot.returnPct;
    buckets.set(name, b);
  };

  for (const lot of closedLots) {
    if (lot.side !== "long") continue; // evaluate BUY-signal efficacy
    bump("All buys (baseline)", lot);
    const sig = lot.entryRunId && lot.symbol ? signalByKey.get(`${lot.entryRunId}|${normalizeSymbol(lot.symbol)}`) : undefined;
    if (!sig) continue;
    if (typeof sig.congressNet === "number" && sig.congressNet > 0) bump("Congressional buying tailwind", lot);
    if (
      sig.congressCompositeDirection === "BUY" &&
      typeof sig.congressCompositeScore === "number" &&
      sig.congressCompositeScore >= 60
    ) {
      bump("Congress.Trade BUY signal at entry", lot);
    }
    if (typeof sig.insiderSentiment === "number" && sig.insiderSentiment >= 60) bump("Insider buying tailwind", lot);
  }

  const prior = resolveShrinkPrior(userId);
  return Array.from(buckets.entries())
    .map(([signal, b]) => ({
      signal,
      trades: b.trades,
      winRate: Math.round((b.wins / b.trades) * 100),
      shrunkWinRate: Math.round(((b.wins + 0.5 * prior) / (b.trades + prior)) * 100),
      avgReturnPct: Number((b.returnSum / b.trades).toFixed(2))
    }))
    .sort((a, b) => b.trades - a.trades);
}

/** Realized-outcome stats grouped by the dominant deterministic factor at entry. */
export interface FactorScorecardStat {
  factor: MarketFactor;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  shrunkWinRate: number;
  shrunkAvgReturnPct: number;
  /** Average calendar days held; undefined when lots lack entryAt/exitAt timestamps. */
  avgDaysHeld?: number;
  /** % of lots held < 365 days (short-term capital gains); undefined when no timestamp data. */
  shortTermPct?: number;
}

/**
 * Options for `getFactorScorecard`.
 * When `regime` is supplied, only closed lots whose `regime` field matches it are aggregated.
 * Default (no option / undefined regime): aggregate ALL closed lots regardless of regime
 * (backward-compatible behavior unchanged).
 */
export interface FactorScorecardOptions {
  regime?: string;
}

export function getFactorScorecard(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local",
  options?: FactorScorecardOptions,
  prefetched?: PrefetchedFills
): FactorScorecardStat[] {
  const { closedLots: allLots } = calculatePnl(fillsForSource(accountNumber, source, userId, prefetched), currentPrices);
  // Optional regime filter — default (no option) preserves the original all-lots behavior.
  // Exact-string join: `lot.regime` is the `entryMarketRegime` stamped from one of the
  // MARKET_REGIME_LABELS values (src/lib/macro.ts) — a persisted contract. See that const's
  // doc comment before renaming a label; existing rows would silently stop matching.
  const closedLots = options?.regime
    ? allLots.filter((lot) => lot.regime?.trim() === options.regime?.trim())
    : allLots;
  if (closedLots.length === 0) return [];

  const factorByKey = new Map<string, MarketFactor>();
  for (const event of listAudit(500, userId)) {
    if (event.kind !== "signal_snapshot") continue;
    const payload = event.payload as { runId?: string; signals?: Array<{ symbol?: string; chosen?: boolean; factorBreakdown?: MarketFactorBreakdown }> };
    if (!payload?.runId || !Array.isArray(payload.signals)) continue;
    for (const signal of payload.signals) {
      if (!signal.symbol || signal.chosen === false) continue;
      const factor = dominantFactor(signal.factorBreakdown);
      if (factor) factorByKey.set(`${payload.runId}|${normalizeSymbol(signal.symbol)}`, factor);
    }
  }

  const factorKey = (lot: ClosedLot) =>
    lot.entryRunId && lot.symbol ? `${lot.entryRunId}|${normalizeSymbol(lot.symbol)}` : undefined;

  // Resolve each lot's dominant entry factor. B5: prefer the value PERSISTED at entry on the fill raw
  // (`lot.dominantFactor`) — it survives even after the entry's signal_snapshot ages out of the 500-row
  // listAudit window (the real coverage-decay hazard). Fall back to the signal_snapshot lookup for legacy
  // lots that predate the stamp. A lot whose factor can't be resolved by EITHER path is DROPPED — never
  // silently attributed to "momentum" (mislabeling would corrupt the per-factor stats the tuner learns from).
  const resolveFactor = (lot: ClosedLot): MarketFactor | undefined => {
    if (lot.dominantFactor) return lot.dominantFactor;
    const key = factorKey(lot);
    return key ? factorByKey.get(key) : undefined;
  };

  return aggregateClosedLots(
    closedLots.filter((lot) => resolveFactor(lot) !== undefined),
    // Safe: the filter above guarantees a resolved factor here.
    (lot) => resolveFactor(lot) as MarketFactor,
    userId
  ).map(({ key, ...rest }) => ({ factor: key as MarketFactor, ...rest }));
}

export interface SkippedCandidateReturn {
  runId: string;
  symbol: string;
  asOf?: string;
  ageDays?: number;
  refPrice: number;
  currentPrice: number;
  returnPct: number;
  score?: number;
  sector?: string;
  regime?: string;
  dominantFactor?: MarketFactor;
  bulletins?: string[];
  /** SPY % return (item 4) over this row's OWN entry→now window, from the injected per-date SPY map.
   * Present only when `benchmarkReturnBySnapshotDate` was supplied AND had a value for this row's date. */
  benchmarkReturnPct?: number;
}

export function getSkippedCandidateReturns(
  currentPrices: Record<string, number>,
  userId: string = "local",
  options: { limit?: number; maxAgeDays?: number; connectedAccountId?: string; benchmarkReturnBySnapshotDate?: Map<string, number> } = {}
): SkippedCandidateReturn[] {
  const limit = options.limit ?? 12;
  const maxAgeDays = options.maxAgeDays ?? 14;
  const now = Date.now();
  // B4: SPY return (as a %) for a row's snapshot date, over the same entry→now window. Injected by the
  // caller (built once from the reused backtest SPY fetch); undefined when no SPY value for that date.
  const benchmarkPctFor = (asOf?: string): number | undefined => {
    if (!options.benchmarkReturnBySnapshotDate || !asOf) return undefined;
    const dateKey = asOf.slice(0, 10);
    const frac = options.benchmarkReturnBySnapshotDate.get(dateKey);
    return typeof frac === "number" ? Number((frac * 100).toFixed(2)) : undefined;
  };
  const seen = new Set<string>();
  const returns: SkippedCandidateReturn[] = listMaturedSkippedCounterfactuals(userId, limit * 3, options.connectedAccountId)
    .map((row): SkippedCandidateReturn | undefined => {
      if (!row.exitPrice || row.returnPct === undefined) return undefined;
      const asOfTime = new Date(row.snapshotAt).getTime();
      const ageDays = Number.isFinite(asOfTime) ? (now - asOfTime) / 86_400_000 : undefined;
      if (typeof ageDays === "number" && ageDays > maxAgeDays) return undefined;
      seen.add(row.symbol);
      return {
        runId: row.runId,
        symbol: row.symbol,
        asOf: row.snapshotAt,
        ...(typeof ageDays === "number" ? { ageDays: Number(ageDays.toFixed(1)) } : {}),
        refPrice: row.refPrice,
        currentPrice: row.exitPrice,
        returnPct: row.returnPct,
        score: row.score,
        sector: row.sector,
        regime: row.regime,
        dominantFactor: row.dominantFactor as MarketFactor | undefined,
        bulletins: row.bulletins,
        ...(benchmarkPctFor(row.snapshotAt) !== undefined ? { benchmarkReturnPct: benchmarkPctFor(row.snapshotAt) } : {})
      };
    })
    .filter((row): row is SkippedCandidateReturn => Boolean(row));

  for (const event of listAudit(500, userId)) {
    if (event.kind !== "signal_snapshot") continue;
    const payload = event.payload as {
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
    };
    if (!payload?.runId || !Array.isArray(payload.signals)) continue;
    const asOf = payload.asOf ?? event.createdAt;
    const asOfTime = new Date(asOf).getTime();
    const ageDays = Number.isFinite(asOfTime) ? (now - asOfTime) / 86_400_000 : undefined;
    if (typeof ageDays === "number" && ageDays > maxAgeDays) continue;

    for (const signal of payload.signals) {
      if (signal.chosen !== false || !signal.symbol || !positiveNumber(signal.refPrice)) continue;
      const symbol = normalizeSymbol(signal.symbol);
      if (seen.has(symbol)) continue;
      const currentPrice = positiveNumber(currentPrices[symbol]);
      if (!currentPrice) continue;
      seen.add(symbol);
      const refPrice = signal.refPrice as number;
      returns.push({
        runId: payload.runId,
        symbol,
        asOf,
        ...(typeof ageDays === "number" ? { ageDays: Number(ageDays.toFixed(1)) } : {}),
        refPrice,
        currentPrice,
        returnPct: Number((((currentPrice - refPrice) / refPrice) * 100).toFixed(2)),
        score: signal.score,
        sector: signal.sector,
        regime: signal.regime,
        dominantFactor: dominantFactor(signal.factorBreakdown),
        bulletins: signal.bulletins,
        ...(benchmarkPctFor(asOf) !== undefined ? { benchmarkReturnPct: benchmarkPctFor(asOf) } : {})
      });
    }
  }

  return returns.sort((a, b) => b.returnPct - a.returnPct).slice(0, limit);
}

/** One matured Red Team veto joined to its post-veto counterfactual return. */
export interface RedTeamVetoRecord {
  runId: string;
  symbol: string;
  side?: string;
  thesisTag?: string;
  reason?: string;
  model?: string;
  /** Realized % move since the veto, side-adjusted so positive = the veto avoided a loss / missed a gain
   *  is negative (mirrors returnSinceProposalPct's sign convention). */
  returnPct: number;
}

/**
 * Red Team (Bear) efficacy scorecard — advisory-only measurement of the adversary that can veto any
 * high-conviction proposal. Joins `proposal_rejected_by_red_team` audit events (the veto decision;
 * stamped with runId + model since 2026-07) to their matured counterfactual return in
 * `skipped_candidate_counterfactuals` (written by `recordRejectedProposalCounterfactual` at veto time,
 * same pipeline as policy blocks / human rejections) via the shared `(runId, symbol)` key. A veto whose
 * counterfactual return is NEGATIVE means the vetoed trade would have lost money — the Bear "added
 * value" by keeping the proposal out. A veto whose counterfactual return is POSITIVE means the vetoed
 * trade would have made money — the Bear's rejection MISSED a winner. Never gates anything; this is a
 * read-only scorecard for the approval-time debate prompt and the Results page (console wiring left for
 * the console lane — see docs/rollouts/2026-07-04-w1-learning-loops.md).
 */
export interface RedTeamEfficacy {
  /** Total Bear-veto audit events observed in the scanned window (matured or not). */
  totalVetoes: number;
  /** Vetoes whose post-veto counterfactual return has matured (resolvable — never fabricated). */
  maturedVetoes: number;
  /** Vetoes whose counterfactual terminally failed to resolve (delisted/renamed — kill-survivorship:
   *  counted in the denominator instead of silently dropping out of the scorecard). */
  unresolvableVetoes: number;
  /** maturedVetoes / totalVetoes (0 when no vetoes observed). Coverage, not a rejection rate. */
  maturedCoveragePct: number;
  /** Human coverage disclosure, e.g. "4/6 vetoes resolved (66.7%) — 1 unresolvable; may be survivor-biased". */
  coverage: string;
  /** Share of MATURED vetoes where the counterfactual return was negative (the veto avoided a loser). */
  vetoValueAddRate: number;
  /** Share of MATURED vetoes where the counterfactual return was positive (the veto missed a winner —
   *  the survivor-risk the Bear itself introduced by rejecting a trade that would have worked). */
  survivorRiskHitRate: number;
  /** Mean counterfactual return (%) across matured vetoes; negative is good (vetoes avoided losses). */
  avgReturnPct: number;
  /** Per red-team model breakdown (present only for models that stamped ≥1 matured veto). */
  byModel: Array<{
    model: string;
    maturedVetoes: number;
    vetoValueAddRate: number;
    survivorRiskHitRate: number;
    avgReturnPct: number;
  }>;
  /** The individual matured veto records, most recent counterfactual maturation first — bounded by `limit`. */
  records: RedTeamVetoRecord[];
}

export function getRedTeamEfficacy(
  userId: string = "local",
  options: { auditLimit?: number; limit?: number; connectedAccountId?: string } = {}
): RedTeamEfficacy {
  const auditLimit = options.auditLimit ?? 500;
  const limit = options.limit ?? 50;

  const vetoesByKey = new Map<string, { runId: string; symbol: string; side?: string; thesisTag?: string; reason?: string; model?: string }>();
  // Kind-scoped audit query (Codex review on PR #365): the LIMIT applies AFTER the kind
  // filter, so newer audit rows of other kinds can never push older Bear vetoes out of the
  // scanned window and zero the scorecard's history.
  for (const event of listAuditByKind("proposal_rejected_by_red_team", auditLimit, userId, options.connectedAccountId)) {
    const payload = event.payload as { runId?: string; symbol?: string; side?: string; thesisTag?: string; reason?: string; model?: string } | undefined;
    if (!payload?.runId || !payload.symbol) continue;
    // Opening sides only: the strategy audits EVERY Bear veto but records counterfactual
    // candidates only for vetoed buy/short OPENINGS (a vetoed exit is not a missed
    // opportunity), so counting exit vetoes here would permanently depress maturation
    // coverage with rows that can never mature. Legacy audits without a side are kept
    // (the writer has always been opening-scoped downstream).
    if (payload.side !== undefined && payload.side !== "buy" && payload.side !== "short") continue;
    const symbol = normalizeSymbol(payload.symbol);
    vetoesByKey.set(`${payload.runId}:${symbol}`, {
      runId: payload.runId,
      symbol,
      side: payload.side,
      thesisTag: payload.thesisTag,
      reason: payload.reason,
      model: payload.model
    });
  }

  const totalVetoes = vetoesByKey.size;
  // Keyed (runId, symbol) lookups rather than a return_pct-DESC top slice of all matured
  // rows: the top-return slice could drop exactly the low/negative-return vetoes (the
  // avoided losers) that vetoValueAddRate exists to count (Codex review on PR #365).
  const maturedPairs: Array<{ record: RedTeamVetoRecord; maturedAt: string }> = [];
  for (const veto of vetoesByKey.values()) {
    const row = getMaturedSkippedCounterfactualByRunSymbol(userId, veto.runId, veto.symbol);
    if (!row || row.returnPct === undefined) continue;
    const returnPct = veto.side === "short" ? -row.returnPct : row.returnPct;
    maturedPairs.push({
      record: {
        runId: veto.runId,
        symbol: veto.symbol,
        side: veto.side,
        thesisTag: veto.thesisTag,
        reason: veto.reason,
        model: veto.model,
        returnPct
      },
      maturedAt: row.updatedAt
    });
  }
  // Most recent counterfactual maturation first (the documented `records` ordering contract).
  maturedPairs.sort((a, b) => b.maturedAt.localeCompare(a.maturedAt));
  const records: RedTeamVetoRecord[] = maturedPairs.map((pair) => pair.record);

  // Kill-survivorship (Wave-2 outcome engine): terminally-unresolvable counterfactuals
  // (delisted/renamed vetoed names) stay in the denominator and in the disclosure instead
  // of vanishing from the scorecard.
  let unresolvableVetoes = 0;
  if (totalVetoes > 0) {
    for (const row of listSkippedCounterfactualsByStatus(userId, "unresolvable", Math.max(auditLimit, totalVetoes * 2))) {
      if (vetoesByKey.has(`${row.runId}:${normalizeSymbol(row.symbol)}`)) unresolvableVetoes += 1;
    }
  }

  const maturedVetoes = records.length;
  const valueAdds = records.filter((r) => r.returnPct < 0).length;
  const survivorHits = records.filter((r) => r.returnPct > 0).length;
  const avgReturnPct = maturedVetoes > 0 ? records.reduce((sum, r) => sum + r.returnPct, 0) / maturedVetoes : 0;

  const byModelMap = new Map<string, RedTeamVetoRecord[]>();
  for (const record of records) {
    if (!record.model) continue;
    const bucket = byModelMap.get(record.model);
    if (bucket) bucket.push(record);
    else byModelMap.set(record.model, [record]);
  }

  const resolvedDenominator = maturedVetoes + unresolvableVetoes;
  const coverage =
    totalVetoes > 0
      ? `${maturedVetoes}/${totalVetoes} vetoes resolved (${Number(((maturedVetoes / totalVetoes) * 100).toFixed(1))}%)${
          unresolvableVetoes > 0 ? ` — ${unresolvableVetoes} unresolvable; may be survivor-biased` : ""
        }${totalVetoes - resolvedDenominator > 0 ? `; ${totalVetoes - resolvedDenominator} still maturing` : ""}`
      : "no vetoes observed";

  return {
    totalVetoes,
    maturedVetoes,
    unresolvableVetoes,
    maturedCoveragePct: totalVetoes > 0 ? Number(((maturedVetoes / totalVetoes) * 100).toFixed(1)) : 0,
    coverage,
    vetoValueAddRate: maturedVetoes > 0 ? Number(((valueAdds / maturedVetoes) * 100).toFixed(1)) : 0,
    survivorRiskHitRate: maturedVetoes > 0 ? Number(((survivorHits / maturedVetoes) * 100).toFixed(1)) : 0,
    avgReturnPct: Number(avgReturnPct.toFixed(2)),
    byModel: Array.from(byModelMap.entries()).map(([model, modelRecords]) => {
      const modelValueAdds = modelRecords.filter((r) => r.returnPct < 0).length;
      const modelSurvivorHits = modelRecords.filter((r) => r.returnPct > 0).length;
      const modelAvg = modelRecords.reduce((sum, r) => sum + r.returnPct, 0) / modelRecords.length;
      return {
        model,
        maturedVetoes: modelRecords.length,
        vetoValueAddRate: Number(((modelValueAdds / modelRecords.length) * 100).toFixed(1)),
        survivorRiskHitRate: Number(((modelSurvivorHits / modelRecords.length) * 100).toFixed(1)),
        avgReturnPct: Number(modelAvg.toFixed(2))
      };
    }),
    records: records.slice(0, limit)
  };
}

/**
 * Coverage disclosure for the missed-opportunity readouts built on `getSkippedCandidateReturns` /
 * `summarizeMissedOpportunities`: how many skipped-candidate counterfactuals actually resolved vs
 * terminally failed ('unresolvable' — delisted/renamed names that would otherwise silently drop out
 * of the matured set, i.e. survivorship bias in the "what we missed" evidence). Render as
 * "N/M resolved (X%)" next to any missed-opportunity number.
 */
export function getMissedOpportunityCoverage(userId: string = "local", connectedAccountId?: string): SkippedCounterfactualCoverage {
  return getSkippedCounterfactualCoverage(userId, connectedAccountId);
}

/** One matured Red Team veto joined to its post-veto counterfactual return. */
export interface RedTeamVetoRecord {
  runId: string;
  symbol: string;
  side?: string;
  thesisTag?: string;
  reason?: string;
  model?: string;
  /** Realized % move since the veto, side-adjusted so positive = the veto avoided a loss / missed a gain
   *  is negative (mirrors returnSinceProposalPct's sign convention). */
  returnPct: number;
}

/**
 * Minimum closed lots before the auto-tuner is allowed to recommend factor-weight
 * shifts. Below this, suggestions are statistically untrustworthy and could overfit
 * a handful of trades (docs/phase-7-strategy.md §3.E guardrail).
 */
export const MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT = 20;

/**
 * Confidence calibration: realized win rate / avg return of closed BUY lots grouped by
 * the agent's entry `confidenceScore` band. Because confidence now drives position size,
 * this tells the agent whether its high-conviction calls actually win more than its
 * low-conviction ones (good calibration) or not (overconfidence) — so it can recalibrate.
 */
export interface ConfidenceCalibrationStat {
  band: string;
  trades: number;
  winRate: number;
  shrunkWinRate: number;
  avgReturnPct: number;
}

/** The confidence-calibration band label a confidenceScore (1–100) falls into. Exported so the sizer
 * can look up a proposal's realized band without duplicating the boundaries. */
export function confidenceBandOf(c: number): string {
  return c >= 85 ? "85-100 (high)" : c >= 70 ? "70-84" : c >= 50 ? "50-69" : "1-49 (low)";
}

/** Confidence bands from LOWEST to HIGHEST confidence — the order calibration must be monotonic in. */
const CONFIDENCE_BANDS_ASC = ["1-49 (low)", "50-69", "70-84", "85-100 (high)"] as const;

/**
 * Remap a proposal's raw conviction (confidenceScore/100) toward the account's REALIZED win rate for its
 * confidence band (item 6, panel-hardened). Properties:
 *  - Uses `shrunkWinRate` (Bayesian-shrunk toward 50%), never the raw win rate.
 *  - DOWNWARD-ONLY: never inflates conviction on the learner's say-so (a well-calibrated or under-confident
 *    band is left at raw).
 *  - ISOTONIC: realized rates are made non-decreasing across bands (low→high) via a pooled-adjacent-violators
 *    pass, so a low-N mid band whose realized rate dips can't invert the ordering and size a mid call above
 *    a high call.
 *  - Per-band SAMPLE-GATED: a band with fewer than `minTrades` closed lots is ignored (raw conviction).
 * Pure over (confidenceScore, calibration). Shorts have no long-only calibration and should not call this —
 * the sizer falls back to raw for them.
 */
export function calibratedConviction(
  confidenceScore: number,
  calibration: ConfidenceCalibrationStat[],
  minTrades = 5
): number {
  const raw = Math.max(0, Math.min(1, confidenceScore / 100));
  const band = confidenceBandOf(confidenceScore);
  const stat = calibration.find((c) => c.band === band);
  if (!stat || stat.trades < minTrades) return raw;

  // Build an isotonic (non-decreasing by band, low→high) realized-rate curve from sufficiently-sampled
  // bands, then read this band's isotonic value. Bands below the sample gate are skipped (not fabricated).
  const points = CONFIDENCE_BANDS_ASC
    .map((b) => calibration.find((c) => c.band === b))
    .map((c) => (c && c.trades >= minTrades ? Math.max(0, Math.min(1, c.shrunkWinRate / 100)) : undefined));
  const isotonic = poolAdjacentViolators(points);
  const bandIdx = CONFIDENCE_BANDS_ASC.indexOf(band as (typeof CONFIDENCE_BANDS_ASC)[number]);
  const realized = bandIdx >= 0 ? isotonic[bandIdx] : undefined;
  if (realized === undefined || realized >= raw) return raw;
  // Blend 50/50 toward realized so a single unlucky window can't zero out sizing, but persistent
  // over-confidence is meaningfully de-risked.
  return Number(((raw + realized) / 2).toFixed(4));
}

/**
 * Pool-adjacent-violators (isotonic regression, non-decreasing) over an ordered series with optional gaps.
 * `undefined` entries are treated as unknown and passed through unchanged (they are sample-gated-out bands);
 * the monotonic constraint is enforced only across the KNOWN entries. Pure.
 */
function poolAdjacentViolators(values: Array<number | undefined>): Array<number | undefined> {
  const idx = values.map((v, i) => (v === undefined ? -1 : i)).filter((i) => i >= 0);
  if (idx.length <= 1) return values.slice();
  // Collect known values with unit weights, then merge adjacent decreasing blocks by averaging.
  const blocks = idx.map((i) => ({ sum: values[i] as number, count: 1, indices: [i] }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < blocks.length - 1; i++) {
      if (blocks[i].sum / blocks[i].count > blocks[i + 1].sum / blocks[i + 1].count) {
        blocks[i] = {
          sum: blocks[i].sum + blocks[i + 1].sum,
          count: blocks[i].count + blocks[i + 1].count,
          indices: [...blocks[i].indices, ...blocks[i + 1].indices]
        };
        blocks.splice(i + 1, 1);
        merged = true;
        break;
      }
    }
  }
  const out = values.slice();
  for (const block of blocks) {
    const avg = block.sum / block.count;
    for (const i of block.indices) out[i] = avg;
  }
  return out;
}

export function getConfidenceCalibration(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local",
  prefetched?: PrefetchedFills
): ConfidenceCalibrationStat[] {
  const { closedLots } = calculatePnl(fillsForSource(accountNumber, source, userId, prefetched), currentPrices);
  return aggregateClosedLots(
    closedLots.filter((lot) => lot.side === "long" && typeof lot.confidence === "number"),
    (lot) => confidenceBandOf(lot.confidence as number),
    userId
  )
    .map(({ key, trades, winRate, shrunkWinRate, avgReturnPct }) => ({ band: key, trades, winRate, shrunkWinRate, avgReturnPct }))
    .sort((a, b) => b.band.localeCompare(a.band));
}

/** Open (unclosed) lots with entry dates, for holding-period and tax analysis. */
export function getOpenLots(
  accountNumber: string,
  source?: FillSource,
  userId: string = "local",
  prefetched?: PrefetchedFills
): OpenLot[] {
  return calculatePnl(fillsForSource(accountNumber, source, userId, prefetched)).openLots;
}

/**
 * Pseudo-count for Bayesian shrinkage of small-sample win rate / average return
 * toward a neutral prior (50% win, 0% return). With K=5, a single 100%-win trade
 * shrinks to ~58% rather than a misleading 100%, so the learning loop doesn't
 * overfit a handful of trades.
 */
const SHRINK_PRIOR = 5;

/** Shrinkage prior, overridable via policy.tuning.shrinkPrior (0 = no shrinkage); else the default. */
function resolveShrinkPrior(userId: string = "local"): number {
  try {
    const v = getPolicy(userId).tuning?.shrinkPrior;
    return typeof v === "number" && v >= 0 ? v : SHRINK_PRIOR;
  } catch {
    return SHRINK_PRIOR;
  }
}

function aggregateClosedLots(
  closedLots: ClosedLot[],
  keyFn: (lot: ClosedLot) => string,
  userId: string = "local"
): Array<{
  key: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  shrunkWinRate: number;
  shrunkAvgReturnPct: number;
  /** Average calendar days held across closed lots in this bucket (undefined when no entryAt/exitAt data). */
  avgDaysHeld: number | undefined;
  /** Percentage of lots held < 365 days (short-term for tax purposes). */
  shortTermPct: number | undefined;
}> {
  const prior = resolveShrinkPrior(userId);
  const byKey = new Map<string, {
    pnl: number;
    returnSum: number;
    wins: number;
    trades: number;
    daysHeldSum: number;
    daysHeldCount: number;
    shortTermCount: number;
  }>();
  for (const lot of closedLots) {
    const key = keyFn(lot);
    const cur = byKey.get(key) ?? { pnl: 0, returnSum: 0, wins: 0, trades: 0, daysHeldSum: 0, daysHeldCount: 0, shortTermCount: 0 };
    cur.pnl += lot.pnl;
    cur.returnSum += lot.returnPct;
    cur.wins += lot.pnl > 0 ? 1 : 0;
    cur.trades += 1;
    // Holding-period derived fields (read-only; not used in any weight-nudge math).
    if (lot.entryAt && lot.exitAt) {
      const entryMs = new Date(lot.entryAt).getTime();
      const exitMs = new Date(lot.exitAt).getTime();
      if (Number.isFinite(entryMs) && Number.isFinite(exitMs) && exitMs >= entryMs) {
        const daysHeld = (exitMs - entryMs) / (1000 * 60 * 60 * 24);
        cur.daysHeldSum += daysHeld;
        cur.daysHeldCount += 1;
        if (daysHeld < 365) cur.shortTermCount += 1;
      }
    }
    byKey.set(key, cur);
  }
  return Array.from(byKey.entries())
    .map(([key, s]) => ({
      key,
      trades: s.trades,
      winRate: Math.round((s.wins / s.trades) * 100),
      avgReturnPct: Number((s.returnSum / s.trades).toFixed(2)),
      totalPnl: Number(s.pnl.toFixed(2)),
      // Shrink toward neutral (0.5 win, 0% return) with `prior` pseudo-trades.
      shrunkWinRate: Math.round(((s.wins + 0.5 * prior) / (s.trades + prior)) * 100),
      shrunkAvgReturnPct: Number((s.returnSum / (s.trades + prior)).toFixed(2)),
      // Holding-period fields: undefined when no lots in this bucket have entryAt/exitAt data.
      avgDaysHeld: s.daysHeldCount > 0 ? Number((s.daysHeldSum / s.daysHeldCount).toFixed(1)) : undefined,
      shortTermPct: s.daysHeldCount > 0 ? Number(((s.shortTermCount / s.daysHeldCount) * 100).toFixed(1)) : undefined
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
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

const MARKET_FACTOR_KEYS = new Set<string>([
  "liquidity", "momentum", "value", "quality", "volatility", "sentiment", "positioning", "diversification"
]);

function thesisMetaFromFill(fill: FillEvent): { thesisTag?: string; regime?: string; confidence?: number; sector?: string; dominantFactor?: MarketFactor } {
  const raw = fill.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const proposal = r.proposal;
  const sector = typeof r.sector === "string" ? r.sector : undefined;
  // B5: dominant scan factor persisted at entry (mirrors the sector stamp). Validated against the known
  // factor keys so a malformed value never becomes a bogus bucket.
  const dominantFactor = typeof r.dominantFactor === "string" && MARKET_FACTOR_KEYS.has(r.dominantFactor)
    ? (r.dominantFactor as MarketFactor)
    : undefined;
  if (!proposal || typeof proposal !== "object") return { sector, dominantFactor };
  const p = proposal as Record<string, unknown>;
  return {
    thesisTag: typeof p.tradeThesisTag === "string" ? p.tradeThesisTag : undefined,
    regime: typeof p.entryMarketRegime === "string" ? p.entryMarketRegime : undefined,
    confidence: typeof p.confidenceScore === "number" ? p.confidenceScore : undefined,
    sector,
    dominantFactor
  };
}

function isAccountingFill(fill: FillEvent): boolean {
  if (fill.status === "filled") return true;
  if (fill.source !== "paper") return false;
  // Legacy/local Test rows used source=paper before executionMode existed, or carried the now-removed
  // "test/local" executionMode value (the local-simulation execution path was deleted; the string can
  // still appear on old persisted rows). They have no broker order id and were already simulated fills.
  // Broker-paper rows must wait for a filled broker state. Cast: "test/local" predates the ExecutionMode
  // type narrowing to "broker/paper" | "broker/live", so it's compared as a plain string here.
  const legacyMode = fill.executionMode as string | undefined;
  return !fill.brokerOrderId && (legacyMode === undefined || legacyMode === "test/local");
}

function syntheticPaperCurve(fills: FillEvent[]) {
  const accountingFills = fills
    .filter(isAccountingFill)
    .sort((a, b) => a.filledAt.localeCompare(b.filledAt));
  return accountingFills.map((fill, index) => {
    const realized = calculatePnl(accountingFills.slice(0, index + 1)).realized;
    return { timestamp: fill.filledAt, equity: 100 + realized, source: "paper" as const };
  });
}

function addAttribution(map: Map<string, RunAttribution>, fill: FillEvent, realizedPnl: number): void {
  const runId = fill.runId ?? "manual";
  const current = map.get(runId) ?? { runId, fillCount: 0, notional: 0, realizedPnl: 0 };
  current.fillCount += 1;
  current.notional += fill.notional;
  current.realizedPnl += realizedPnl;
  // Mirror realized P&L as exit-run credit (new additive field; existing realizedPnl unchanged).
  if (realizedPnl !== 0) current.realizedPnlAsExit = (current.realizedPnlAsExit ?? 0) + realizedPnl;
  map.set(runId, current);
}

/**
 * Dual-sided credit: ALSO credit the run whose ENTRY decision opened a now-closed lot, via a NEW
 * optional field (realizedPnlAsEntry). Does NOT touch realizedPnl / fillCount / notional — the
 * entry run's open fill already counted those at open time (see addAttribution on the buy/short
 * fill). Additive: leaves every existing field exactly as the exit-keyed path set it.
 */
function addEntryAttribution(map: Map<string, RunAttribution>, entryRunId: string, realizedPnl: number): void {
  const current = map.get(entryRunId) ?? { runId: entryRunId, fillCount: 0, notional: 0, realizedPnl: 0 };
  current.realizedPnlAsEntry = (current.realizedPnlAsEntry ?? 0) + realizedPnl;
  map.set(entryRunId, current);
}

function combineAttribution(...groups: RunAttribution[][]): RunAttribution[] {
  const map = new Map<string, RunAttribution>();
  for (const group of groups) {
    for (const item of group) {
      const current = map.get(item.runId) ?? { runId: item.runId, fillCount: 0, notional: 0, realizedPnl: 0 };
      current.fillCount += item.fillCount;
      current.notional += item.notional;
      current.realizedPnl += item.realizedPnl;
      if (item.realizedPnlAsEntry != null) current.realizedPnlAsEntry = (current.realizedPnlAsEntry ?? 0) + item.realizedPnlAsEntry;
      if (item.realizedPnlAsExit != null) current.realizedPnlAsExit = (current.realizedPnlAsExit ?? 0) + item.realizedPnlAsExit;
      map.set(item.runId, current);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.notional - a.notional);
}

function winRate(lots: ClosedLot[]): number {
  if (lots.length === 0) return 0;
  return (lots.filter((lot) => lot.pnl > 0).length / lots.length) * 100;
}

function averageReturn(lots: ClosedLot[]): number {
  if (lots.length === 0) return 0;
  return lots.reduce((sum, lot) => sum + lot.returnPct, 0) / lots.length;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function priceFromReview(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  return (
    positiveNumber(row.estimatedPrice) ??
    positiveNumber(row.estimated_price) ??
    positiveNumber(row.averagePrice) ??
    positiveNumber(row.average_price) ??
    positiveNumber(row.lastPrice) ??
    positiveNumber(row.last_price) ??
    positiveNumber(row.last_trade_price) ??
    positiveNumber(row.price)
  );
}
