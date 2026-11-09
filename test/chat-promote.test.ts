import { describe, expect, it } from "vitest";
import { chatDraftToProposal } from "../src/lib/chat/promote-draft";
import type { ChatDraft } from "../src/lib/chat/types";

const baseDraft = (over: Partial<ChatDraft> = {}): ChatDraft => ({
  draft_id: "d1",
  symbol: "AAPL",
  side: "buy",
  qty: 10,
  order_type: "market",
  limit_usd: null,
  rationale: "User asked to buy.",
  account_label: "Test (local)",
  is_real: false,
  blocked: false,
  warnings: [],
  executed: false,
  ...over
});

describe("chatDraftToProposal mapper", () => {
  it("maps a market buy to a complete TradeProposal (all required fields set — CLAUDE.md trap)", () => {
    const r = chatDraftToProposal(baseDraft());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.proposal;
    expect(p.symbol).toBe("AAPL");
    expect(p.side).toBe("buy");
    expect(p.type).toBe("market");
    expect(p.quantity).toBe(10);
    expect(p.timeInForce).toBe("gfd");
    expect(p.marketHours).toBe("regular_hours");
    expect(p.rationale).toBeTruthy();
    expect(p.tradeThesisTag).toBe("Manual-Chat");
    expect(p.entryMarketRegime).toBe("Manual");
  });

  it("maps a limit order with a limitPrice", () => {
    const r = chatDraftToProposal(baseDraft({ order_type: "limit", limit_usd: 199.5 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.proposal.type).toBe("limit");
      expect(r.proposal.limitPrice).toBe(199.5);
    }
  });

  it("rejects a limit order with no/zero limit price", () => {
    expect(chatDraftToProposal(baseDraft({ order_type: "limit", limit_usd: null })).ok).toBe(false);
    expect(chatDraftToProposal(baseDraft({ order_type: "limit", limit_usd: 0 })).ok).toBe(false);
  });

  it("rejects any side outside buy/sell (no chat-originated short/cover)", () => {
    const r = chatDraftToProposal(baseDraft({ side: "short" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("UNSUPPORTED_SIDE");
  });

  it("rejects non-positive qty and empty symbol", () => {
    expect(chatDraftToProposal(baseDraft({ qty: 0 })).ok).toBe(false);
    expect(chatDraftToProposal(baseDraft({ qty: -5 })).ok).toBe(false);
    expect(chatDraftToProposal(baseDraft({ symbol: "" })).ok).toBe(false);
  });

  it("canonicalizes the symbol", () => {
    const r = chatDraftToProposal(baseDraft({ symbol: " aapl " }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.proposal.symbol).toBe("AAPL");
  });
});
