import { getPolicy } from "./db";
import type { OrderSide, SystemState } from "./types";

export function systemStatePlacementBlockReason(
  systemState: SystemState,
  side: OrderSide
): string | undefined {
  if (systemState === "halted") {
    return "System was halted before broker submission. No new order was sent.";
  }
  if (
    (systemState === "close_only" || systemState === "liquidating") &&
    side !== "sell" &&
    side !== "cover"
  ) {
    return `System became ${systemState.replace("_", "-")} before broker submission. Only closing orders are allowed.`;
  }
  return undefined;
}

export type PlacementBlockSource = "autonomous" | "owner_approval";

/**
 * Re-read durable state at the last synchronous boundary before a broker call. Long strategy runs
 * keep an earlier policy snapshot for deterministic analysis, but that snapshot must never outrank
 * an owner Stop/close-only/liquidating command when capital is about to move.
 *
 * `owner_approval` is the human Approve path only. Exit-only still stops the agent from opening
 * new risk; the owner's click is the override for that one opening. Halted and liquidating stay
 * blocked — Stop means nothing new leaves, and winding-down stays exits-only.
 */
export function freshPlacementBlockReason(input: {
  userId: string;
  connectedAccountId?: string;
  side: OrderSide;
  source?: PlacementBlockSource;
}): string | undefined {
  const currentState = getPolicy(input.userId, input.connectedAccountId).systemState;
  if (input.source === "owner_approval") {
    if (currentState === "halted") {
      return systemStatePlacementBlockReason(currentState, input.side);
    }
    if (currentState === "liquidating" && input.side !== "sell" && input.side !== "cover") {
      return systemStatePlacementBlockReason(currentState, input.side);
    }
    return undefined;
  }
  return systemStatePlacementBlockReason(currentState, input.side);
}
