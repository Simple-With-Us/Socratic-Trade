import { describe, expect, it } from "vitest";
import {
  delayAdvantageUsd,
  delayedFallbackStampLabel,
  nameMovePct,
  pendingShowsDelayedFallback,
  resolveProposedPrice,
  resolveProposalTarget
} from "../src/lib/proposal-price-review";

describe("proposal price review", () => {
  it("prefers snapshot reference, then proposal reference, then limit", () => {
    expect(resolveProposedPrice({ proposalReferencePrice: 10, referencePrice: 11, limitPrice: 12 })).toBe(10);
    expect(resolveProposedPrice({ referencePrice: 11, limitPrice: 12 })).toBe(11);
    expect(resolveProposedPrice({ limitPrice: 12 })).toBe(12);
    expect(resolveProposedPrice({})).toBeUndefined();
  });

  it("uses scorecard take-profit when the bracket is missing", () => {
    expect(resolveProposalTarget({ scorecard: { sniperPoints: { takeProfit: 30 } } })).toBe(30);
    expect(resolveProposalTarget({ bracketTakeProfit: 28 })).toBe(28);
  });

  it("treats a rising buy as worse delay and a rising short as better", () => {
    expect(delayAdvantageUsd({ proposed: 200, now: 202.2, quantity: 7, side: "buy" })).toBeCloseTo(-15.4, 5);
    expect(delayAdvantageUsd({ proposed: 100, now: 102, quantity: 4, side: "short" })).toBeCloseTo(8, 5);
    expect(nameMovePct(200, 202.2)).toBeCloseTo(1.1, 5);
  });

  it("stamps Delayed Quote on the approval-card helper", () => {
    expect(delayedFallbackStampLabel()).toBe("Delayed Quote");
    expect(pendingShowsDelayedFallback({ delayedFallback: true })).toBe(true);
    expect(pendingShowsDelayedFallback({ proposal: { quoteDelayedFallback: true } })).toBe(true);
    expect(pendingShowsDelayedFallback({})).toBe(false);
  });
});
