// sell-to-fund.ts — PR 3: when a run's intended BUYs exceed available buying power, optionally
// raise cash by selling existing holdings. This module is the PURE decision core (no IO): given the
// shortfall and the current positions, it picks which holdings to trim and builds the sell proposals.
// The strategy loop decides what to DO with them based on the 3-way mode (see SellToFundBuyMode).
//
// SAFETY: "off" (the default) returns an empty plan, so the whole feature is a no-op until the user
// explicitly opts in. Selling prefers the largest unrealized LOSERS first (free cash from positions
// the thesis is already wrong about), never touches the buy targets, and only sells long positions.

import type { SellToFundBuyMode, TradeProposal } from "./types";

export type { SellToFundBuyMode };

export interface FundingPositionInput {
  symbol: string;
  quantity: number;
  marketValue: number;
  averageCost: number;
  /** Optional forward factor/conviction score (0–100); lower scores are liquidated first. */
  forwardScore?: number;
  /** Alias for forwardScore when a MarketQuote-like object is passed. */
  score?: number;
  /** Holding duration in days (>= 365 qualifies for long-term capital gains treatment on gains). */
  holdingDays?: number;
  /** True when selling this lot at a loss would trigger or forfeit a recent 30-day wash-sale window. */
  washSaleRisk?: boolean;
  /** Optional marginal tax rate override (%) for this lot. */
  marginalTaxRatePct?: number;
}

export interface PlanFundingSellsInput {
  mode: SellToFundBuyMode;
  /** Available buying power (cash for a non-margin/Test account). */
  buyingPower: number;
  /** Total notional of this run's intended opening orders (buys/shorts). */
  intendedOpeningNotional: number;
  positions: FundingPositionInput[];
  /** Latest prices by symbol (for share sizing); falls back to marketValue/quantity. */
  currentPrices: Record<string, number>;
  /** Symbols never to sell: the buy targets this run, plus any protected names. */
  excludeSymbols: string[];
  /** Optional forward scores by symbol (0–100); lowest forward score is liquidated first. */
  forwardScores?: Record<string, number>;
  /** Optional symbols with active wash-sale risk when harvested at a loss. */
  washSaleSymbols?: string[];
  /** Optional holding days by symbol for short-term vs long-term tax efficiency ranking. */
  holdingDaysBySymbol?: Record<string, number>;
  /** Short-term marginal capital-gains tax rate % (default 24). */
  shortTermTaxRatePct?: number;
  /** Long-term marginal capital-gains tax rate % (default 15). */
  longTermTaxRatePct?: number;
  /** Optional maximum overshoot factor/dollars when Math.ceil(remaining / price) of a high-priced share exceeds remaining shortfall. */
  maxOvershootRatio?: number;
}

export interface FundingSellPlan {
  /** USD shortfall the buys exceed buying power by (0 when none). */
  shortfall: number;
  /** Sell proposals that would cover (most of) the shortfall. Empty unless mode != "off" and short. */
  sells: TradeProposal[];
  /** Total market value the sells would raise. */
  raised: number;
  /** Human-readable plan summary (used for the suggest-mode note + audit). */
  summary: string;
}

const EMPTY: FundingSellPlan = { shortfall: 0, sells: [], raised: 0, summary: "" };

/**
 * Compute liquidation priority score (LOWER = liquidate first).
 * Combines:
 *  1. Forward conviction/factor score (0..100, default 50): sell low-forward-score laggards before high-score winners.
 *  2. Tax & wash-sale efficiency:
 *     - Tax-loss harvesting bonus (negative unrealized P&L without wash-sale risk reduces priority score -> sell earlier).
 *     - Wash-sale penalty (+25 priority points when selling would trigger/forfeit a wash-sale deduction).
 *     - Capital-gains tax drag penalty (short-term gain taxed at shortTermRatePct vs long-term gain at longTermRatePct).
 */
function computeLiquidationPriority(
  pos: FundingPositionInput,
  input: PlanFundingSellsInput,
  unrealized: number,
  costBasisTotal: number
): number {
  const sym = pos.symbol.trim().toUpperCase();
  const explicitScore =
    typeof pos.forwardScore === "number" && Number.isFinite(pos.forwardScore)
      ? pos.forwardScore
      : typeof pos.score === "number" && Number.isFinite(pos.score)
        ? pos.score
        : typeof input.forwardScores?.[pos.symbol] === "number" && Number.isFinite(input.forwardScores[pos.symbol]!)
          ? input.forwardScores[pos.symbol]!
          : typeof input.forwardScores?.[sym] === "number" && Number.isFinite(input.forwardScores[sym]!)
            ? input.forwardScores[sym]!
            : 50;

  const returnPct = costBasisTotal > 0 ? (unrealized / costBasisTotal) * 100 : 0;
  const washRisk =
    pos.washSaleRisk === true ||
    (input.washSaleSymbols ?? []).some((s) => s.trim().toUpperCase() === sym);
  const holdingDays =
    typeof pos.holdingDays === "number" && Number.isFinite(pos.holdingDays)
      ? pos.holdingDays
      : input.holdingDaysBySymbol?.[pos.symbol] ?? input.holdingDaysBySymbol?.[sym];
  const isLongTerm = typeof holdingDays === "number" && holdingDays >= 365;
  const stRate = (pos.marginalTaxRatePct ?? input.shortTermTaxRatePct ?? 24) / 100;
  const ltRate = (pos.marginalTaxRatePct ?? input.longTermTaxRatePct ?? 15) / 100;
  const effectiveTaxRate = isLongTerm ? ltRate : stRate;

  // Tax adjustment in score points:
  // - Unrealized loss without wash-sale risk gets a tax-shield harvest bonus (negative adjustment -> lower score -> sell first).
  // - Unrealized loss with wash-sale risk gets penalized (+25) because harvesting forfeits/defers the deduction.
  // - Unrealized gain incurs tax drag proportional to returnPct * effectiveTaxRate (short-term gains penalized more than long-term).
  let taxPenaltyPoints = 0;
  if (unrealized < 0) {
    if (washRisk) {
      taxPenaltyPoints += 25;
    } else {
      // Up to -20pt harvest bonus scaled by percentage loss and tax rate
      const harvestBenefit = Math.min(20, Math.abs(returnPct) * effectiveTaxRate * 1.2);
      taxPenaltyPoints -= harvestBenefit;
    }
  } else if (unrealized > 0) {
    // Gain tax drag: e.g. +50% gain at 24% ST rate -> +14.4pt penalty to hold winner; LT rate 15% -> +9pt
    const gainDrag = Math.min(30, returnPct * effectiveTaxRate * 1.2);
    taxPenaltyPoints += gainDrag;
    if (washRisk) {
      taxPenaltyPoints += 10;
    }
  } else if (washRisk) {
    taxPenaltyPoints += 15;
  }

  return explicitScore + taxPenaltyPoints;
}

/**
 * Plan funding sells for one run. Pure: no DB, no broker, no clock.
 * Returns an empty plan when disabled, when there's no shortfall, or when nothing is sellable.
 */
export function planFundingSells(input: PlanFundingSellsInput): FundingSellPlan {
  if (input.mode === "off") return EMPTY;

  const shortfall = round2(input.intendedOpeningNotional - Math.max(0, input.buyingPower));
  if (!(shortfall > 0)) return EMPTY;

  const exclude = new Set(input.excludeSymbols.map((s) => s.trim().toUpperCase()));
  const candidates = input.positions
    .filter((p) => p.quantity > 0 && p.marketValue > 0 && !exclude.has(p.symbol.trim().toUpperCase()))
    .map((p) => {
      const costBasisTotal = p.averageCost * p.quantity;
      const unrealized = p.marketValue - costBasisTotal;
      const unrealizedPct = costBasisTotal > 0 ? unrealized / costBasisTotal : 0;
      const priority = computeLiquidationPriority(p, input, unrealized, costBasisTotal);
      return { ...p, unrealized, unrealizedPct, priority };
    })
    // Lowest forward-score + tax/wash-sale priority first, then percentage return, then raw dollar P&L, then largest position.
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.unrealizedPct - b.unrealizedPct ||
        a.unrealized - b.unrealized ||
        b.marketValue - a.marketValue
    );

  const sells: TradeProposal[] = [];
  let raised = 0;
  const maxOvershootRatio = input.maxOvershootRatio ?? 2.0;

  for (let idx = 0; idx < candidates.length; idx++) {
    if (raised >= shortfall) break;
    const pos = candidates[idx]!;
    const price = positivePrice(input.currentPrices[pos.symbol]) ?? positivePrice(pos.marketValue / pos.quantity);
    if (!price) continue;
    const remaining = shortfall - raised;

    // Math.ceil overshoot guard: if 1 whole share of this high-priced stock would overshoot the
    // remaining shortfall by more than maxOvershootRatio (and at least $100) while a finer-grained
    // remaining candidate can cover the shortfall with less overshoot, defer to the finer-grained lot.
    const rawCeilShares = Math.ceil(remaining / price);
    const wholeAvail = Math.floor(pos.quantity);
    let shares = wholeAvail >= 1 ? Math.min(wholeAvail, rawCeilShares) : Math.min(pos.quantity, rawCeilShares);

    if (shares * price > remaining * maxOvershootRatio && shares * price - remaining >= 100) {
      const floorShares = Math.floor(remaining / price);
      const laterCanCoverCleaner = candidates.slice(idx + 1).some((other) => {
        const otherPrice = positivePrice(input.currentPrices[other.symbol]) ?? positivePrice(other.marketValue / other.quantity);
        if (!otherPrice) return false;
        const neededAfterFloor = remaining - floorShares * price;
        const otherShares = Math.min(Math.floor(other.quantity) || other.quantity, Math.ceil(neededAfterFloor / otherPrice));
        return otherShares > 0 && otherShares * otherPrice >= neededAfterFloor && otherShares * otherPrice < (shares - floorShares) * price;
      });
      if (laterCanCoverCleaner) {
        shares = floorShares;
      }
    }

    if (shares <= 0) continue;
    const proceeds = round2(shares * price);
    raised = round2(raised + proceeds);
    sells.push({
      symbol: pos.symbol,
      side: "sell",
      type: "market",
      quantity: shares,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: `Sell-to-fund-buy: raise ~$${proceeds.toFixed(2)} toward a $${shortfall.toFixed(2)} buying-power shortfall (ranked by lowest forward score and tax/wash-sale efficiency; largest unrealized loss trimmed first).`,
      tradeThesisTag: "Sell-to-Fund",
      entryMarketRegime: "Funding"
    });
  }

  if (sells.length === 0) return { ...EMPTY, shortfall };

  const symbols = sells.map((s) => `${s.quantity} ${s.symbol}`).join(", ");
  const summary =
    raised >= shortfall
      ? `Sell ${symbols} to raise ~$${raised.toFixed(2)}, covering the $${shortfall.toFixed(2)} buying-power shortfall.`
      : `Sell ${symbols} to raise ~$${raised.toFixed(2)} toward a $${shortfall.toFixed(2)} shortfall (best effort — holdings can't fully cover it).`;

  return { shortfall, sells, raised, summary };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function positivePrice(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}
