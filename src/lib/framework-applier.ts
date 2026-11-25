// framework-applier.ts — OD-9 D4b seam (ST-4684, owner-approved 2026-11-24).
// An ACCEPTED socratic framework proposal materializes as an enabled advisory
// strategy_overlays row and rides the existing overlay containment seam
// (loadActiveOverlays -> containData -> prompt DATA note -> appliedOverlayIds).
//
// Advisory throughout: the emitted overlay is prompt DATA for the proposer, the same
// trust tier as ownerCoaching.  It never mutates policy caps, sizing, or placement,
// and loadActiveOverlays still honors strategyOverlaysEnabled and maxActiveOverlays.
// Propose authority only — see shouldEmitAcceptedFrameworkAsOverlay in od9-seams.ts.

import { getPolicy } from "./db";
import { createStrategyOverlay, listStrategyOverlays, updateStrategyOverlay } from "./db-overlays";
import { shouldEmitAcceptedFrameworkAsOverlay } from "./od9-seams";
import type { SocraticFrameworkProposal } from "./types";

const FRAMEWORK_OVERLAY_TITLE_CAP = 120;

/** Overlays sort priority ASC (lower first), then run through maxActiveOverlays.  An owner
 *  ACCEPTED change ranks ahead of the default-100 owner-authored band, but behind the
 *  10-40 starter templates the owner curated by hand.  */
const FRAMEWORK_PRIORITY: Record<SocraticFrameworkProposal["priority"], number> = {
  high: 40,
  medium: 70,
  low: 100
};

/** Deterministic overlay id for a framework proposal: re-accepting (or rewriting) the same
 *  proposal updates its overlay in place instead of appending a duplicate row.  */
export function frameworkOverlayId(frameworkId: string): string {
  return `fw-accepted:${frameworkId}`;
}

export interface FrameworkApplyResult {
  emitted: boolean;
  overlayId?: string;
  skippedReason?: string;
}

export function applyAcceptedFrameworkProposal(framework: SocraticFrameworkProposal): FrameworkApplyResult {
  if (framework.status !== "accepted") {
    return { emitted: false, skippedReason: "not_accepted" };
  }
  const policy = getPolicy(framework.userId, framework.connectedAccountId);
  if (!shouldEmitAcceptedFrameworkAsOverlay(policy)) {
    return {
      emitted: false,
      skippedReason: policy.strategyAuthority === "propose" ? "tuning_disabled" : "not_propose_mode"
    };
  }
  // A REWRITTEN acceptance applies the owner's rewritten wording; a plain acceptance
  // applies the proposal's own proposedChange.
  const instructions =
    framework.ownerVerb === "rewrite" && framework.ownerResponse && framework.ownerResponse.trim()
      ? framework.ownerResponse.trim()
      : framework.proposedChange.trim();
  if (!instructions) return { emitted: false, skippedReason: "empty_change" };
  const title = (framework.title && framework.title.trim() ? framework.title.trim() : `${framework.subsystem} framework change`)
    .slice(0, FRAMEWORK_OVERLAY_TITLE_CAP);
  const id = frameworkOverlayId(framework.id);
  const existing = listStrategyOverlays(framework.userId).find((overlay) => overlay.id === id);
  if (existing) {
    updateStrategyOverlay(framework.userId, id, { name: title, instructions, enabled: true });
  } else {
    createStrategyOverlay({
      id,
      userId: framework.userId,
      name: title,
      marketRegimes: ["any"],
      instructions,
      priority: FRAMEWORK_PRIORITY[framework.priority],
      enabled: true
    });
  }
  return { emitted: true, overlayId: id };
}