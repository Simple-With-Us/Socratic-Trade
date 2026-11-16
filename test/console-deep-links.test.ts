import { describe, expect, it } from "vitest";
import {
  proposalElementId,
  readProposalQuery,
  readSymbolQuery,
  symbolElementId
} from "../app/console/lib/deep-link-focus";

describe("console deep-link query parsers", () => {
  it("accepts the same proposal ids iOS honors", () => {
    expect(readProposalQuery("6a1f0f1e-2f2a-4c8b-9d0e-3b7a5c1d2e4f")).toBe(
      "6a1f0f1e-2f2a-4c8b-9d0e-3b7a5c1d2e4f"
    );
    expect(readProposalQuery("proposal-1")).toBe("proposal-1");
    expect(proposalElementId("proposal-1")).toBe("proposal-proposal-1");
    expect(proposalElementId("6a1f0f1e-2f2a-4c8b-9d0e-3b7a5c1d2e4f")).toBe(
      "proposal-6a1f0f1e-2f2a-4c8b-9d0e-3b7a5c1d2e4f"
    );
  });

  it("rejects empty, oversized, or unsafe proposal ids", () => {
    expect(readProposalQuery("")).toBeNull();
    expect(readProposalQuery("   ")).toBeNull();
    expect(readProposalQuery("not an id")).toBeNull();
    expect(readProposalQuery("../admin")).toBeNull();
    expect(readProposalQuery("a".repeat(65))).toBeNull();
    expect(readProposalQuery(null)).toBeNull();
  });

  it("uppercases a ticker and rejects junk", () => {
    expect(readSymbolQuery("aapl")).toBe("AAPL");
    expect(readSymbolQuery("BRK.B")).toBe("BRK.B");
    expect(readSymbolQuery(" tsLa ")).toBe("TSLA");
    expect(readSymbolQuery("")).toBeNull();
    expect(readSymbolQuery("TOO-LONG-TICKER")).toBeNull();
    expect(readSymbolQuery("AA PL")).toBeNull();
    expect(symbolElementId("AAPL")).toBe("symbol-AAPL");
    expect(symbolElementId("AAPL", "card")).toBe("symbol-AAPL-card");
  });
});
