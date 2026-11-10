// Approval-time re-anchor for ORDINARY pending limit proposals (entries and regular-hours exits,
// any side: buy, sell, short, cover) — the sibling of the protective-exit reprice in
// protective-exit-routing.ts. Under propose authority a card can wait hours/overnight for a human
// Approve; the stored limitPrice was anchored to the generation-time quote (referencePrice), so
// placing it verbatim executes yesterday's price level into today's market. The re-anchor preserves
// the proposal's intended aggressiveness — the stored limit-to-anchor RATIO (patient discount,
// marketable premium) — against the fresh approval-time quote:
//
//   newLimit = freshQuotePrice * (storedLimit / storedAnchor)
//
// Precedence: the protective-exit reprice (repriceStoredProtectiveExit) OWNS extended-hours
// protective exits. This module declines them even when that path returned the proposal unchanged
// (its routing priced the SAME marketable limit off the fresh bid/ask — ratio-re-anchoring that off
// the composite price would overwrite a deliberate spread-crossing decision), and the call site in
// executeProposal additionally only invokes this when the protective path did not mutate the object.
//
// Consent mirrors the protective-exit semantics exactly (no new consent machinery): drift beyond the
// validated marketable-limit buffer tolerance is MATERIAL, and the call site routes a material
// reprice on a live typed-confirmation account back to the human instead of placing.

import {
  isApprovalRepriceProtectiveExit,
  roundLimitOutwardToTick,
  validatedMarketableLimitBufferBps,
  type ProtectiveExitQuote
} from "./protective-exit-routing";
import type { TradeProposal, TradingPolicy } from "./types";

/** Mirrors ProtectiveExitRepriceDrift: the materiality verdict for the live typed-confirmation
 * invariant, against the same validated marketable-limit buffer tolerance the protective-exit
 * reprice uses (policy.tuning.marketableLimitBufferBps, default 15 bps). */
export interface ApprovalLimitRepriceDrift {
  material: boolean;
  toleranceBps: number;
  /** Anchor move (fresh quote vs the stored anchor) in bps. Because the reprice is ratio-preserving,
   * this equals the relative limit change (pre tick rounding). Absent when unverifiable. */
  anchorDriftBps?: number;
}

export interface ApprovalLimitReprice {
  /** The repriced proposal, or the SAME object reference as the input when no reprice applies —
   * callers detect "repriced" by reference inequality, like repriceStoredProtectiveExit. */
  proposal: TradeProposal;
  drift: ApprovalLimitRepriceDrift;
}

const usable = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

const dollars = (price: number): string => (price < 1 ? price.toFixed(4) : price.toFixed(2));

/**
 * Re-anchor a STORED pending limit proposal to the fresh approval-time quote. Returns the input
 * object unchanged (same reference) when: the proposal is not a limit order; the protective-exit
 * path claims it; the stored limit, anchor, or fresh composite quote is missing/nonpositive (fails
 * safe to the reviewed stored order — never guesses); or the re-anchored price rounds to the stored
 * limit (sub-tick churn floor, mirroring the protective path's equality-after-rounding skip).
 *
 * A repriced proposal carries `repriceAnchorPrice` (= the fresh quote) so a LATER reprice — e.g. a
 * second approval after a material re-queue — measures ratio and drift from the last anchor instead
 * of compounding the same move off the original referencePrice, which stays untouched.
 */
export function repriceStoredLimitProposal(
  proposal: TradeProposal,
  policy: TradingPolicy,
  quote: ProtectiveExitQuote | undefined
): ApprovalLimitReprice {
  const toleranceBps = validatedMarketableLimitBufferBps(policy);
  const unchanged: ApprovalLimitReprice = { proposal, drift: { material: false, toleranceBps } };
  if (proposal.type !== "limit") return unchanged;
  if (isApprovalRepriceProtectiveExit(proposal)) return unchanged;
  const storedLimit = usable(proposal.limitPrice);
  const anchor = usable(proposal.repriceAnchorPrice) ?? usable(proposal.referencePrice);
  // The composite fresh price, matching the measure referencePrice was stamped from at generation
  // time — a bid/ask side would skew the ratio the anchor semantics depend on.
  const fresh = usable(quote?.price);
  if (storedLimit === undefined || anchor === undefined || fresh === undefined) return unchanged;
  // Anchor provenance: db-proposals' ensureReferencePrice stamps referencePriceProvenance at
  // insert — "limit-fallback" means the reference is a defensive COPY of the limit price
  // (chat/manual paths that never saw a quote): that is a hard price and ratio-re-anchoring it
  // would turn a reviewed "$50 limit" into a current-market limit. "provided" means a genuine
  // decision-time quote — reprice-eligible even when the LLM set the limit exactly at it. Rows
  // predating the marker fall back to the conservative equality heuristic (a 48h-TTL-bounded
  // legacy window); a carried repriceAnchorPrice (a real quote from a prior reprice) always
  // restores eligibility.
  if (proposal.referencePriceProvenance === "limit-fallback") return unchanged;
  if (
    proposal.referencePriceProvenance === undefined &&
    anchor === storedLimit &&
    usable(proposal.repriceAnchorPrice) === undefined
  ) {
    return unchanged;
  }
  const anchorDriftBps = (Math.abs(fresh - anchor) / anchor) * 10_000;
  // Strictly-beyond-tolerance, with a float-noise guard: a quote landing EXACTLY on the tolerance
  // must not read as material because (fresh - anchor) picked up ~1e-13 of representation error.
  const drift: ApprovalLimitRepriceDrift = { material: anchorDriftBps > toleranceBps + 1e-9, toleranceBps, anchorDriftBps };
  // Same tick model and outward rounding as the protective-exit reprice: buy-side (buy/cover) up,
  // sell-side (sell/short) down — never less marketable than the exact ratio price.
  const repricedLimit = roundLimitOutwardToTick(
    fresh * (storedLimit / anchor),
    proposal.side === "buy" || proposal.side === "cover" ? "up" : "down"
  );
  if (repricedLimit === undefined || repricedLimit === storedLimit) return { proposal, drift };
  // Bracket legs are ABSOLUTE prices anchored to the same generation-time quote as the entry limit.
  // Re-anchoring the entry alone compresses (or inverts — the broker 422s a take-profit through the
  // entry) the bracket's geometry, so every present leg scales by the same fresh/anchor ratio the
  // entry used — R:R is preserved to within a tick. Exit legs round toward the entry, then are
  // CLAMPED to at least one tick beyond the rounded entry: rounding alone cannot guarantee
  // separation (the entry rounds outward while legs round inward, so a post-scale gap under ~2
  // ticks collides — TP == entry — and the broker rejects the bracket; adversarial probes hit this
  // at the $1 tick-factor boundary and on tight stop gaps).
  const scale = fresh / anchor;
  const buyEntry = proposal.side === "buy" || proposal.side === "cover";
  const tick = 1 / (repricedLimit < 1 ? 10_000 : 100); // matches roundLimitOutwardToTick's factor
  const minAbove = roundLimitOutwardToTick(repricedLimit + tick, "up");
  const maxBelow = roundLimitOutwardToTick(repricedLimit - tick, "down");
  const scaleLeg = (
    leg: number | undefined,
    direction: "up" | "down",
    clamp: "aboveEntry" | "belowEntry"
  ): number | undefined => {
    const stored = usable(leg);
    if (stored === undefined) return leg;
    const rounded = roundLimitOutwardToTick(stored * scale, direction);
    if (rounded === undefined) return leg;
    if (clamp === "aboveEntry") return minAbove !== undefined ? Math.max(rounded, minAbove) : rounded;
    return maxBelow !== undefined && maxBelow > 0 ? Math.min(rounded, maxBelow) : rounded;
  };
  // Buy-entry bracket: TP is a sell limit above the entry, SL a sell stop below — mirrored for a
  // short entry (buy-side exits: TP below, SL above).
  let repricedTakeProfit = buyEntry
    ? scaleLeg(proposal.bracketTakeProfit, "down", "aboveEntry")
    : scaleLeg(proposal.bracketTakeProfit, "up", "belowEntry");
  let repricedStopLoss = buyEntry
    ? scaleLeg(proposal.bracketStopLoss, "up", "belowEntry")
    : scaleLeg(proposal.bracketStopLoss, "down", "aboveEntry");
  let repricedStopLimit = buyEntry
    ? scaleLeg(proposal.bracketStopLimit, "up", "belowEntry")
    : scaleLeg(proposal.bracketStopLimit, "down", "aboveEntry");
  let hasBracket = usable(proposal.bracketTakeProfit) !== undefined || usable(proposal.bracketStopLoss) !== undefined;
  // Native brackets require >= 1 whole share (the gateways floor dollarAmount/limitPrice and 422
  // on zero). A dollar-sized bracket that was placeable at the stored limit can become sub-share
  // once the limit reprices upward — mirror the generation path (enrichOpeningProposal): place
  // the order WITHOUT the bracket legs, protection stays with the synthetic-stop monitors.
  let bracketStrippedSubShare = false;
  if (
    hasBracket &&
    proposal.quantity == null &&
    typeof proposal.dollarAmount === "number" &&
    Math.floor(proposal.dollarAmount / repricedLimit) < 1
  ) {
    repricedTakeProfit = undefined;
    repricedStopLoss = undefined;
    repricedStopLimit = undefined;
    hasBracket = false;
    bracketStrippedSubShare = true;
  }
  // Repeated reprices (e.g. a material re-queue approved later) must not stack an unbounded chain
  // of re-anchor tags onto the rationale — replace any previous tag with the current one.
  const baseRationale = proposal.rationale.replace(/\s*\[Limit re-anchored from [^\]]*\]/g, "");
  return {
    proposal: {
      ...proposal,
      limitPrice: repricedLimit,
      bracketTakeProfit: repricedTakeProfit,
      bracketStopLoss: repricedStopLoss,
      bracketStopLimit: repricedStopLimit,
      repriceAnchorPrice: fresh,
      repricedFromLimit: storedLimit,
      rationale: `${baseRationale} [Limit re-anchored from $${dollars(storedLimit)} to $${dollars(repricedLimit)}${hasBracket ? " (bracket legs re-anchored by the same ratio)" : ""}${bracketStrippedSubShare ? " (bracket removed: the repriced limit makes the dollar size sub-one-share; synthetic stops still protect the position)" : ""}: the quote moved ${anchorDriftBps.toFixed(1)} bps to $${dollars(fresh)} while the proposal awaited approval.]`
    },
    drift
  };
}
