/** Proposed / live / target / delay numbers for a pending proposal card.
 *  Mirrors ios/SocraticTrade/ProposalPriceReview.swift so website + iOS stay aligned. */

import { DELAYED_QUOTE_STAMP, delayedFallbackCardTitle } from "./quote-delayed-fallback";

export function pendingShowsDelayedFallback(pending: {
  delayedFallback?: boolean;
  quoteProvider?: string;
  proposal?: { quoteDelayedFallback?: boolean; quoteProvider?: string };
}): boolean {
  return pending.delayedFallback === true || pending.proposal?.quoteDelayedFallback === true;
}

export function delayedFallbackStampLabel(): string {
  return DELAYED_QUOTE_STAMP;
}

export function delayedFallbackStampTitle(): string {
  return delayedFallbackCardTitle();
}

export function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function resolveProposalTarget(proposal: {
  bracketTakeProfit?: number;
  scorecard?: { sniperPoints?: { takeProfit?: number } };
}): number | undefined {
  if (finitePositive(proposal.bracketTakeProfit)) return proposal.bracketTakeProfit;
  const take = proposal.scorecard?.sniperPoints?.takeProfit;
  if (finitePositive(take)) return take;
  return undefined;
}

export function resolveProposalStop(proposal: {
  bracketStopLoss?: number;
  scorecard?: { sniperPoints?: { stopLoss?: number } };
}): number | undefined {
  if (finitePositive(proposal.bracketStopLoss)) return proposal.bracketStopLoss;
  const stop = proposal.scorecard?.sniperPoints?.stopLoss;
  if (finitePositive(stop)) return stop;
  return undefined;
}

export function resolveProposedPrice(input: {
  proposalReferencePrice?: number;
  referencePrice?: number;
  limitPrice?: number;
}): number | undefined {
  if (finitePositive(input.proposalReferencePrice)) return input.proposalReferencePrice;
  if (finitePositive(input.referencePrice)) return input.referencePrice;
  if (finitePositive(input.limitPrice)) return input.limitPrice;
  return undefined;
}

export function delayAdvantageUsd(input: {
  proposed?: number;
  now?: number;
  quantity?: number;
  side: string;
}): number | undefined {
  const { proposed, now, quantity, side } = input;
  if (!finitePositive(proposed) || !finitePositive(now) || !finitePositive(quantity)) return undefined;
  const delta = now - proposed;
  return side === "buy" || side === "cover" ? -delta * quantity : delta * quantity;
}

export function nameMovePct(proposed?: number, now?: number): number | undefined {
  if (!finitePositive(proposed) || !finitePositive(now)) return undefined;
  return ((now - proposed) / proposed) * 100;
}
