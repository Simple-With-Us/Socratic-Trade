// framework-applier.ts — OD-9 D4b seam (ST-4684, owner-approved 2026-11-24).
// An ACCEPTED socratic framework proposal materializes as an enabled advisory
// strategy_overlays row and rides the existing overlay containment seam
// (loadActiveOverlays -> containData -> prompt DATA note -> appliedOverlayIds).
//
// Advisory throughout: the emitted overlay is prompt DATA for the proposer, the same
// trust tier as ownerCoaching.  It never mutates policy caps, sizing, or placement,
// and loadActiveOverlays still honors strategyOverlaysEnabled and maxActiveOverlays.
// Propose authority only — see shouldEmitAcceptedFrameworkAsOverlay in od9-seams.ts.
//
// Kody review #5488 hardening:
//   - the instructions carry ONLY the owner's confirmed text (ownerResponse).  A plain
//     accept without owner text emits nothing — the LLM's proposedChange is never
//     persisted as an enabled instruction (security finding).
//   - the write is sanitized and bounded (control-character strip + 800-char cap +
//     prompt containment quarantine) before it touches the overlay table.
//   - emission is a single atomic UPSERT keyed on the deterministic overlay id, so
//     concurrent accepts cannot race, and re-accept refreshes priority from the mapping.

import { getPolicy } from "./db";
import { upsertStrategyOverlay } from "./db-overlays";
import { shouldEmitAcceptedFrameworkAsOverlay } from "./od9-seams";
import { containPromptText } from "./prompt-safety";
import type { SocraticFrameworkProposal } from "./types";

const FRAMEWORK_OVERLAY_TITLE_CAP = 120;
const FRAMEWORK_INSTRUCTION_CAP = 800;

/** Overlays sort priority ASC (lower first), then run through maxActiveOverlays.  An owner
 *  ACCEPTED change ranks ahead of the default-100 owner-authored band, but behind the
 *  10-40 starter templates the owner curated by hand.  */
const FRAMEWORK_PRIORITY: Record<SocraticFrameworkProposal["priority"], number> = {
  high: 40,
  medium: 70,
  low: 100
};

/** Deterministic overlay id for a framework proposal: re-accepting the same
 *  proposal upserts its overlay in place instead of appending a duplicate row.  */
export function frameworkOverlayId(frameworkId: string): string {
  return `fw-accepted:${frameworkId}`;
}

export interface FrameworkApplyResult {
  emitted: boolean;
  overlayId?: string;
  skippedReason?: string;
}

/** Control-character strip + whitespace collapse + hard cap.  Returns undefined when
 *  nothing survives the clean so an empty/control-only payload can never emit a row.  */
function normalizeOwnerConfirmedText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = cleaned.length > FRAMEWORK_INSTRUCTION_CAP ? cleaned.slice(0, FRAMEWORK_INSTRUCTION_CAP) : cleaned;
  return bounded || undefined;
}

function normalizeTitle(value: string | undefined, fallback: string): string {
  if (!value || !value.trim()) return fallback;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, FRAMEWORK_OVERLAY_TITLE_CAP);
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
  // The ONLY permitted instruction source is the owner's confirmed text.  A rewrite
  // acceptance carries it by construction (the PATCH route enforces that); a plain
  // accept carries it only when the owner typed a response — otherwise nothing is
  // emitted, so the model-authored proposedChange never becomes an enabled instruction.
  const ownerText = normalizeOwnerConfirmedText(framework.ownerResponse);
  if (!ownerText) {
    return { emitted: false, skippedReason: "owner_text_required" };
  }
  const contained = containPromptText({ source: "coach", text: ownerText });
  const instructions = contained.sanitizedText.trim();
  if (!instructions) return { emitted: false, skippedReason: "empty_change" };
  const title = normalizeTitle(framework.title, `${framework.subsystem} framework change`);
  const id = frameworkOverlayId(framework.id);
  upsertStrategyOverlay({
    id,
    userId: framework.userId,
    name: title,
    marketRegimes: ["any"],
    instructions,
    priority: FRAMEWORK_PRIORITY[framework.priority],
    enabled: true
  });
  return { emitted: true, overlayId: id };
}