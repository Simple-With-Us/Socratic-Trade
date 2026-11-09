// Deterministic transaction-cost model for PAPER (broker-paper) fills.
//
// The learning loop's win-rate / average-return / edge — which then drive deterministic position
// sizing — are computed from closed lots. Paper fills recorded by this app (protective-stop exits,
// market replacements) are booked at the raw quote with no broker reconciliation, so without an
// adjustment the loop would certify a cost-free edge that may not survive a real fill (half-spread +
// market impact), sizing UP into exactly the thin, high-momentum names where live cost is worst.
// This model debits an estimated cost on those paper fills so the scorecards are net-of-cost.
//
// DEFAULT ON: with no env configured, executionCostConfig().enabled is true (20 bps base,
// dual-named to the OOS walk-forward constant, + sqrt market-impact). Paper trains live, so the
// paper floor matches the OOS 20 bps haircut rather than a 1 bp fiction. Opt out per box with
// PAPER_EXECUTION_COST_MODEL=off (or 0/false/no). Real broker (live) fills already carry their
// realized price and are never adjusted (no double-count) — only paper fills are affected.

import type { FillSource, OrderSide } from "./types";

export interface ExecutionCostInputs {
  /** (ask − bid)/mid × 1e4 — only when a real two-sided quote exists (else omitted, contributes 0). */
  spreadBps?: number;
  /** Dollar size of this fill. */
  orderNotional: number;
  /** The name's daily dollar volume (price × volume). Drives the sqrt market-impact term. */
  dollarVol?: number;
  /** Fixed slippage floor in bps. */
  baseSlippageBps: number;
  /** sqrt-impact coefficient (impactBps = coeff × sqrt(orderNotional / dollarVol)). */
  impactCoeff: number;
}

/** Total estimated round-trip-leg cost in basis points = base + half-spread + sqrt-impact. */
export function estimateExecutionCostBps(input: ExecutionCostInputs): number {
  const halfSpread = input.spreadBps && input.spreadBps > 0 ? input.spreadBps / 2 : 0;
  let impact = 0;
  if (input.impactCoeff > 0 && input.dollarVol && input.dollarVol > 0 && input.orderNotional > 0) {
    impact = input.impactCoeff * Math.sqrt(input.orderNotional / input.dollarVol);
  }
  return Math.max(0, input.baseSlippageBps + halfSpread + impact);
}

/** Adverse price adjustment: a buy/cover pays UP, a sell/short receives DOWN. */
export function applyExecutionCost(price: number, side: OrderSide, costBps: number): number {
  if (!(price > 0) || !(costBps > 0)) return price;
  const factor = costBps / 1e4;
  const paysUp = side === "buy" || side === "cover";
  return paysUp ? price * (1 + factor) : price * (1 - factor);
}

/**
 * OOS walk-forward / signal-health default: 20 bps round-trip (10 bps/leg).
 * Paper uses the same number as its per-fill floor — paper trains live, so a 1 bp paper
 * default was dishonest. Dual-named so the two cannot drift.
 */
export const OOS_ROUND_TRIP_COST_BPS = 20;
export const PAPER_DEFAULT_BASE_SLIPPAGE_BPS = OOS_ROUND_TRIP_COST_BPS;

/**
 * Read the cost-model config from env (DEFAULT ON for simulated fills).
 *
 * Enabled UNLESS `PAPER_EXECUTION_COST_MODEL` is explicitly set to a falsy value
 * ("0", "false", "off", "no"). This means:
 *   - No env → ON (default base of 20 bps, same as OOS_ROUND_TRIP_COST_BPS, + sqrt market-impact).
 *   - PAPER_EXECUTION_COST_MODEL=off → disabled (opt-out for edge cases / frictionless tests).
 *   - PAPER_EXECUTION_COST_BASE_BPS=8 → ON, overrides the default base.
 *   - PAPER_EXECUTION_IMPACT_COEFF=20 → override impact coefficient.
 *
 * Real broker (live) fills are never adjusted — only paper/simulated fills are affected.
 */
/**
 * B8 fix: apply the base execution cost to a PAPER EXIT fill priced at the raw quote.
 *
 * `recordFillFromProposal` already costs paper ENTRIES, but the two protective-exit writers
 * (`synthetic-stops.ts`, `order-replacement.ts`) insert paper fills at the raw price with NO cost —
 * so a paper lot exited via a synthetic stop pays no exit cost, overstating realized edge on the losing
 * tail that feeds the tuner + sizer. This applies the EXIT side's adverse adjustment (base slippage only —
 * no live scan quote is available at stop/replacement time, mirroring the entry path when spread/volume are
 * absent). LIVE fills are returned UNCHANGED (they carry a real reconciled price; double-costing would be
 * wrong), as are non-positive prices or a disabled model.
 */
export function applyPaperExitCost(price: number, side: OrderSide, source: FillSource | undefined): number {
  if (source !== "paper") return price; // broker-paper fills only — live fills are reconciled, not adjusted
  if (!(price > 0)) return price;
  const cfg = executionCostConfig();
  if (!cfg.enabled) return price;
  const costBps = estimateExecutionCostBps({ orderNotional: 0, baseSlippageBps: cfg.baseSlippageBps, impactCoeff: cfg.impactCoeff });
  return applyExecutionCost(price, side, costBps);
}

export function executionCostConfig(): { enabled: boolean; baseSlippageBps: number; impactCoeff: number } {
  const envFlag = String(process.env.PAPER_EXECUTION_COST_MODEL ?? "").trim().toLowerCase();
  // Explicit opt-out: treat "0", "false", "off", "no" as disabled.
  const explicitlyDisabled = ["0", "false", "off", "no"].includes(envFlag);
  const base = Number(process.env.PAPER_EXECUTION_COST_BASE_BPS);
  const coeff = Number(process.env.PAPER_EXECUTION_IMPACT_COEFF);
  const baseSlippageBps = Number.isFinite(base) && base > 0 ? base : PAPER_DEFAULT_BASE_SLIPPAGE_BPS;
  const impactCoeff = Number.isFinite(coeff) && coeff > 0 ? coeff : 10;
  return { enabled: !explicitlyDisabled, baseSlippageBps, impactCoeff };
}
