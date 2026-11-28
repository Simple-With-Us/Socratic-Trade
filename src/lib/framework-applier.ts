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
//   - emission is a single atomic UPSERT keyed on the owner-scoped overlay id
//     (fw-accepted:<userId>:<frameworkId>), so concurrent accepts cannot race,
//     re-accept refreshes priority from the mapping, and the same framework accepted
//     by a second owner lands as that owner's own row.

import { getPolicy } from "./db";
import { listStrategyOverlays, updateStrategyOverlay, upsertStrategyOverlay } from "./db-overlays";
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

/** Deterministic, USER-SCOPED overlay id for a framework proposal.  Idempotency is
 *  per-owner: re-accepting the same framework upserts that owner's row in place, and
 *  a second owner accepting the SAME framework gets their own overlay instead of
 *  being denied by a first writer's id (Kody #5488 follow-up 68zvEh).  Cross-owner
 *  writes stay impossible via the user_id guard inside upsertStrategyOverlay.  */
export function frameworkOverlayId(userId: string, frameworkId: string): string {
  return `fw-accepted:${userId}:${frameworkId}`;
}

/** LEGACY (pre-68zvEh) global overlay id shape for a framework proposal.  Rows
 *  carrying this id predate the user-scoped key; applyAcceptedFrameworkProposal
 *  retires them on the next emission so an upgrade can never leave two enabled
 *  advisories for one owner+framework (Kody #5488 follow-up 689Ltb).  */
export function legacyFrameworkOverlayId(frameworkId: string): string {
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
  const id = frameworkOverlayId(framework.userId, framework.id);
  upsertStrategyOverlay({
    id,
    userId: framework.userId,
    name: title,
    marketRegimes: ["any"],
    instructions,
    priority: FRAMEWORK_PRIORITY[framework.priority],
    enabled: true
  });
  // One-time migration (Kody #5488 follow-up 689Ltb): retire any LEGACY global-keyed
  // overlay row (fw-accepted:<frameworkId>) for THIS owner so the user-scoped id
  // upgrade leaves exactly one enabled advisory per owner+framework.  The lookup is
  // user-scoped and updateStrategyOverlay writes only the owner's row, so another
  // user's legacy row is never touched.  The new per-user row stays authoritative.
  const legacyId = legacyFrameworkOverlayId(framework.id);
  const legacy = listStrategyOverlays(framework.userId).find((overlay) => overlay.id === legacyId);
  if (legacy && legacy.enabled) {
    updateStrategyOverlay(framework.userId, legacyId, { enabled: false });
  }
  return { emitted: true, overlayId: id };
}