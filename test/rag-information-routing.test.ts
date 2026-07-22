import { describe, expect, it } from "vitest";
import { routeInformationNeeds, strategyInformationRouting } from "../src/lib/rag/information-routing";

describe("information routing boundary", () => {
  it("keeps current facts, portfolio state, and orders out of semantic retrieval", () => {
    const plan = routeInformationNeeds([
      "current_market_quote",
      "portfolio_state",
      "open_orders",
      "financial_facts",
      "insider_transactions"
    ]);

    expect(plan.structured.sourceKinds).toEqual([
      "market",
      "portfolio",
      "orders",
      "financial_facts",
      "insider_transactions"
    ]);
    expect(plan.semantic).toEqual({ needs: [], documentTypes: [] });
  });

  it("gives mixed, caller-declared needs both independent paths", () => {
    const plan = routeInformationNeeds(["financial_facts", "filing_narrative", "earnings_transcript_narrative"]);

    expect(plan.structured).toEqual({ needs: ["financial_facts"], sourceKinds: ["financial_facts"] });
    expect(plan.semantic).toEqual({
      needs: ["filing_narrative", "earnings_transcript_narrative"],
      documentTypes: ["10-k", "10-q", "8-k", "earnings-transcript"]
    });
  });

  it("fails closed for undeclared needs instead of guessing from free text", () => {
    const plan = routeInformationNeeds(["financial_facts", "what is the current price and outlook?", null]);

    expect(plan.structured.needs).toEqual(["financial_facts"]);
    expect(plan.semantic.documentTypes).toEqual([]);
    expect(plan.rejected).toEqual(["what is the current price and outlook?", "<non-string>"]);
  });

  it("only adds transcript vectors when the caller has enabled that narrative source", () => {
    expect(strategyInformationRouting(false).semantic.documentTypes).toEqual(["10-k", "10-q", "8-k"]);
    expect(strategyInformationRouting(true).semantic.documentTypes).toEqual([
      "10-k",
      "10-q",
      "8-k",
      "earnings-transcript"
    ]);
  });
});
