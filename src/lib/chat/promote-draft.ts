// Pure mapper: a chat-assistant ChatDraft -> a canonical TradeProposal that can flow through the
// EXISTING insertProposal(status:'proposed') -> approve -> executeProposal rail. Kept OUT of
// tools.ts/orchestrator.ts so the chat module never gains an execution capability. Sets every
// non-optional TradeProposal field (CLAUDE.md cross-file trap: tradeThesisTag/entryMarketRegime
// are required) and rejects anything outside buy/sell so a malformed draft can't become an
// unvetted short/cover.

import { normalizeSymbol } from "../money";
import type { ChatDraft } from "./types";
import type { TradeProposal } from "../types";

export type PromoteResult = { ok: true; proposal: TradeProposal } | { ok: false; error: string };

export function chatDraftToProposal(draft: ChatDraft): PromoteResult {
  const symbol = normalizeSymbol(String(draft?.symbol ?? ""));
  if (!symbol) return { ok: false, error: "INVALID_SYMBOL" };
  if (draft.side !== "buy" && draft.side !== "sell") return { ok: false, error: `UNSUPPORTED_SIDE:${String(draft.side)}` };
  const quantity = Number(draft.qty);
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, error: "INVALID_QTY" };
  const type = draft.order_type === "limit" ? "limit" : "market";
  const limitPrice = type === "limit" && draft.limit_usd != null ? Number(draft.limit_usd) : undefined;
  if (type === "limit" && (limitPrice == null || !Number.isFinite(limitPrice) || limitPrice <= 0)) {
    return { ok: false, error: "LIMIT_PRICE_REQUIRED" };
  }
  const proposal: TradeProposal = {
    symbol,
    side: draft.side,
    type,
    quantity,
    limitPrice,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: typeof draft.rationale === "string" && draft.rationale.trim() ? draft.rationale.trim() : "Drafted via chat assistant.",
    tradeThesisTag: "Manual-Chat",
    entryMarketRegime: "Manual"
  };
  return { ok: true, proposal };
}
