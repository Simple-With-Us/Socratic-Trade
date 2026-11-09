/** Universe-group draft for Guardrails.  Extra symbols, blocklist, indices,
 *  order types, and sell-to-fund live here (not in usePolicyDraft), so Discard
 *  must reset this object or the next commit silently persists those edits. */

import type { IndexUniverse, OrderType, TradingPolicy } from "@/lib/types";
import type { PolicyPatchBody } from "../lib/api";

export type UniverseDraft = {
  includedIndices?: IndexUniverse[];
  additionalSymbols?: string;
  blocklist?: string;
  permittedOrderTypes?: OrderType[];
  sellToFundBuy?: string;
};

export function emptyUniverseDraft(): UniverseDraft {
  return {};
}

export function parseUniverseSymbols(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export function buildUniverseExtraPatch(
  universeDraft: UniverseDraft,
  policy: Pick<
    TradingPolicy,
    "includedIndices" | "additionalSymbols" | "blocklist" | "permittedOrderTypes" | "sellToFundBuy"
  >
): PolicyPatchBody {
  const extraPatch: PolicyPatchBody = {};
  if (universeDraft.includedIndices && universeDraft.includedIndices.join() !== policy.includedIndices.join()) {
    extraPatch.includedIndices = universeDraft.includedIndices;
  }
  if (
    universeDraft.additionalSymbols !== undefined &&
    parseUniverseSymbols(universeDraft.additionalSymbols).join() !== (policy.additionalSymbols ?? []).join()
  ) {
    extraPatch.additionalSymbols = parseUniverseSymbols(universeDraft.additionalSymbols);
  }
  if (
    universeDraft.blocklist !== undefined &&
    parseUniverseSymbols(universeDraft.blocklist).join() !== (policy.blocklist ?? []).join()
  ) {
    extraPatch.blocklist = parseUniverseSymbols(universeDraft.blocklist);
  }
  if (universeDraft.permittedOrderTypes && universeDraft.permittedOrderTypes.join() !== policy.permittedOrderTypes.join()) {
    extraPatch.permittedOrderTypes = universeDraft.permittedOrderTypes;
  }
  if (universeDraft.sellToFundBuy !== undefined && universeDraft.sellToFundBuy !== (policy.sellToFundBuy ?? "off")) {
    extraPatch.sellToFundBuy = universeDraft.sellToFundBuy;
  }
  return extraPatch;
}

/** Discard both the field draft and the Universe-group draft.  Clearing
 *  universeDraft to {} resets every universe input to the live policy value. */
export function discardAllDrafts(clearFieldDraft: () => void, resetUniverseDraft: (next: UniverseDraft) => void): void {
  clearFieldDraft();
  resetUniverseDraft(emptyUniverseDraft());
}
