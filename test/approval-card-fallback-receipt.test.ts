import { describe, expect, it } from "vitest";
import { fallbackProvenance, modelProvenance } from "../app/console/components/approval-card";
import { LLM_MODEL_ROTATION_SENTINEL } from "../src/lib/llm-request";
import type { TradeProposal, TradingPolicy } from "../src/lib/types";

// The approval card used to assert, for ANY rotating policy, "the served model is this run's
// rotation pick, not a failover".  That was an inference, not a fact: when the Green seat rotates
// and the owner has configured no fallbacks, the run appends implicit pool fallbacks
// (implicitGreenRotationFallbacks), so a 400 or a timeout on the pick is answered by a DIFFERENT
// model — and only the run record knew.  The card told the owner the opposite.
//
// The proposal now carries its own `greenServedByFallback` receipt, and that receipt outranks
// every inference the card can make.

function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol: "AAPL",
    side: "buy",
    type: "market",
    timeInForce: "day",
    marketHours: "regular",
    rationale: "test",
    tradeThesisTag: "momentum",
    entryMarketRegime: "neutral",
    ...overrides
  } as TradeProposal;
}

const rotatingPolicy = { llmModel: LLM_MODEL_ROTATION_SENTINEL } as TradingPolicy;
const fixedPolicy = { llmModel: "gpt-5.6-terra" } as TradingPolicy;

describe("approval card model provenance — rotation pick vs implicit fallback", () => {
  it("names the fallback and the cause when a rotating pick did not serve", () => {
    const p = proposal({
      proposedByModel: "gemini-flash-latest",
      greenServedByFallback: { fromModel: "gpt-5.6-terra", fromProvider: "openrouter", reason: "HTTP 400", attempt: 2, attempts: 3 }
    });

    const claim = fallbackProvenance(p, rotatingPolicy);
    expect(claim).toContain("gpt-5.6-terra");
    expect(claim).toContain("HTTP 400");
    expect(claim).toContain("gemini-flash-latest");
    expect(claim).toContain("attempt 2 of 3");
    // The exact sentence that was false.
    expect(claim).not.toContain("not a failover");

    const provenance = modelProvenance(p, rotatingPolicy);
    expect(provenance).toContain("rotation pick");
    expect(provenance).toContain("served by fallback gemini-flash-latest");
    expect(provenance).not.toContain("(this run's rotation pick)");
  });

  it("still reads as a plain rotation pick when no failover was recorded", () => {
    const p = proposal({ proposedByModel: "gemini-flash-latest" });
    expect(modelProvenance(p, rotatingPolicy)).toBe("configured to rotate; served gemini-flash-latest (this run's rotation pick)");
    expect(fallbackProvenance(p, rotatingPolicy)).not.toContain("failed");
    // It may still say a pick served — but only as a claim about the RECORD, never a denial that
    // a failover is possible under rotation.
    expect(fallbackProvenance(p, rotatingPolicy)).not.toContain("not a failover");
  });

  it("reports the cause on a non-rotating policy too", () => {
    const p = proposal({
      proposedByModel: "mistral-medium-latest",
      greenServedByFallback: { fromModel: "gpt-5.6-terra", reason: "transport error or timeout" }
    });
    const provenance = modelProvenance(p, fixedPolicy);
    expect(provenance).toContain("gpt-5.6-terra failed (transport error or timeout)");
    expect(provenance).toContain("served by fallback mistral-medium-latest");
  });

  it("degrades honestly when the cause was not captured", () => {
    const p = proposal({ proposedByModel: "mistral-small-latest", greenServedByFallback: { fromModel: "claude-opus-5" } });
    expect(fallbackProvenance(p, rotatingPolicy)).toContain("claude-opus-5 did not serve");
  });
});
