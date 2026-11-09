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
    // Largest unrealized loss first (most negative P&L), then largest position — trim the losers first.
    .map((p) => ({ ...p, unrealized: p.marketValue - p.averageCost * p.quantity }))
    .sort((a, b) => a.unrealized - b.unrealized || b.marketValue - a.marketValue);

  const sells: TradeProposal[] = [];
  let raised = 0;
  for (const pos of candidates) {
    if (raised >= shortfall) break;
    const price = positivePrice(input.currentPrices[pos.symbol]) ?? positivePrice(pos.marketValue / pos.quantity);
    if (!price) continue;
    const remaining = shortfall - raised;
    // Sell just enough whole shares to cover the remaining shortfall, capped at the position size.
    const shares = Math.min(pos.quantity, Math.ceil(remaining / price));
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
      rationale: `Sell-to-fund-buy: raise ~$${proceeds.toFixed(2)} toward a $${shortfall.toFixed(2)} buying-power shortfall (largest unrealized loss trimmed first).`,
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
