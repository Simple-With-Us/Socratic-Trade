// od9-seams.ts — OD-9 learning-to-trading seams (ST-4684, owner-approved 2026-11-24).
// Two seams that move learned chat content into the proposal stage WITHOUT auto-execution:
//
//   D4a — chat-stated hard memory constraints (user_memory rows with hard=1) reach the
//         strategy PROPOSER and the Red reviewer as labeled DATA advisories.  They never
//         mutate caps, gates, sizing, or orders, and approving a proposal that conflicts
//         with one is the explicit owner override.  Propose authority only.
//   D4b — an ACCEPTED socratic framework proposal materializes as an advisory
//         strategy_overlays row (same trust tier as ownerCoaching) and rides the existing
//         overlay containment seam.  Propose authority only.
//
// Both seams carry an owner-adjustable preference (tuning knob) as the explicit override.
// Advisory throughout — this module surfaces DATA, never places or blocks anything.

import { listHardLiveMemory } from "./db";
import type { MemoryItem } from "./types";

export const HARD_CONSTRAINT_PROMPT_CAP = 6;
export const HARD_CONSTRAINT_VALUE_CAP = 240;

interface Od9GatePolicy {
  strategyAuthority?: string;
  tuning?: {
    chatHardConstraintsInPropose?: boolean;
    acceptedFrameworkProposalsToOverlays?: boolean;
  };
}

/**
 * D4a gate: hard memory constraints surface to the proposal prompt ONLY in propose
 * authority, and the `chatHardConstraintsInPropose` tuning knob is the explicit
 * owner-adjustable override (false disables the seam).  "Decide" (autonomous) authority
 * never sees them — the seam is propose-mode only, per the OD-9 ruling.
 */
export function shouldSurfaceMemoryHardConstraints(policy: Od9GatePolicy): boolean {
  return policy.strategyAuthority === "propose" && policy.tuning?.chatHardConstraintsInPropose !== false;
}

/**
 * D4b gate: an accepted framework proposal emits its advisory overlay ONLY while the
 * account runs propose authority, and `acceptedFrameworkProposalsToOverlays: false`
 * is the explicit owner-adjustable override that turns emission off.
 */
export function shouldEmitAcceptedFrameworkAsOverlay(policy: Od9GatePolicy): boolean {
  return policy.strategyAuthority === "propose" && policy.tuning?.acceptedFrameworkProposalsToOverlays !== false;
}

/**
 * Live hard memory rows for the proposal prompt: hard-flagged rows only, newest
 * asserted first, deduped by subject (first subject wins the cap slot).  Bounded by
 * `HARD_CONSTRAINT_PROMPT_CAP` so chat memory can never crowd the prompt budget.
 * The filter/order/dedupe/limit run in SQL (`listHardLiveMemory`) so proposeTrades
 * cost does not grow with the size of the user's memory history (Kody #5488).
 */
export function listHardMemoryConstraints(
  userId: string,
  limit: number = HARD_CONSTRAINT_PROMPT_CAP
): MemoryItem[] {
  return listHardLiveMemory(userId, limit);
}