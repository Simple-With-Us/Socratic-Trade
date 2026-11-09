import { describe, expect, it } from "vitest";
import { returnSinceProposalPct } from "../src/lib/performance";

describe("returnSinceProposalPct (performance/counterfactual since proposal date)", () => {
  it("computes a long's gain as the raw move", () => {
    expect(returnSinceProposalPct(100, 110, "buy")).toBe(10);
    expect(returnSinceProposalPct(100, 92, "buy")).toBe(-8);
  });

  it("inverts the sign for sell/short (the proposed direction working = price falling)", () => {
    expect(returnSinceProposalPct(100, 90, "short")).toBe(10); // shorted at 100, now 90 → +10% for us
    expect(returnSinceProposalPct(100, 110, "short")).toBe(-10);
    expect(returnSinceProposalPct(100, 90, "sell")).toBe(10);
  });

  it("rounds to 2 decimals", () => {
    expect(returnSinceProposalPct(100, 103.456, "buy")).toBe(3.46);
  });

  it("returns undefined when either price is missing or non-positive (no misleading 0)", () => {
    expect(returnSinceProposalPct(undefined, 110, "buy")).toBeUndefined();
    expect(returnSinceProposalPct(100, undefined, "buy")).toBeUndefined();
    expect(returnSinceProposalPct(0, 110, "buy")).toBeUndefined();
    expect(returnSinceProposalPct(100, 0, "buy")).toBeUndefined();
    expect(returnSinceProposalPct(-5, 110, "buy")).toBeUndefined();
  });
});
