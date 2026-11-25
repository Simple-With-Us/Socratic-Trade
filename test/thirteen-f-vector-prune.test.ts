// OD-7 A4b: pure classification of 13F provider vectors — empty-ticker rows are the junk
// class; tickered rows and other doc types are kept. No provider access in this file.
import { describe, expect, it } from "vitest";
import {
  classifyThirteenFVector,
  planThirteenFVectorPrune,
  THIRTEEN_F_DOC_TYPE
} from "../src/lib/rag/thirteen-f-vector-prune";
import type { VectorMetadataInventoryRow } from "../src/lib/vector-db";

function row(id: string, metadata: Record<string, unknown>): VectorMetadataInventoryRow {
  return { id, metadata };
}

describe("classifyThirteenFVector", () => {
  it("deletes 13f-holdings rows with an empty-string symbol", () => {
    const decision = classifyThirteenFVector(row("v1", { doc_type: THIRTEEN_F_DOC_TYPE, symbol: "" }));
    expect(decision.action).toBe("delete");
    expect(decision.reason).toBe("empty-ticker");
  });

  it("deletes 13f-holdings rows with whitespace-only or missing symbols", () => {
    expect(classifyThirteenFVector(row("v2", { doc_type: THIRTEEN_F_DOC_TYPE, symbol: "  " })).action).toBe("delete");
    expect(classifyThirteenFVector(row("v3", { doc_type: THIRTEEN_F_DOC_TYPE })).action).toBe("delete");
    expect(classifyThirteenFVector(row("v4", { doc_type: THIRTEEN_F_DOC_TYPE, symbol: 7 })).action).toBe("delete");
  });

  it("keeps 13f-holdings rows that carry a real ticker", () => {
    const decision = classifyThirteenFVector(row("v5", { doc_type: THIRTEEN_F_DOC_TYPE, symbol: "BRK-B" }));
    expect(decision.action).toBe("keep");
    expect(decision.reason).toBe("keep-tickered");
  });

  it("keeps every other doc type, even with empty symbols", () => {
    expect(classifyThirteenFVector(row("v6", { doc_type: "10-k", symbol: "" })).action).toBe("keep");
    expect(classifyThirteenFVector(row("v7", { doc_type: "10-k", symbol: "" })).reason).toBe("keep-wrong-doc-type");
  });
});

describe("planThirteenFVectorPrune", () => {
  it("splits ids and counts by class", () => {
    const plan = planThirteenFVectorPrune([
      row("keep1", { doc_type: THIRTEEN_F_DOC_TYPE, symbol: "AAPL" }),
      row("drop1", { doc_type: THIRTEEN_F_DOC_TYPE, symbol: "" }),
      row("drop2", { doc_type: THIRTEEN_F_DOC_TYPE }),
      row("keep2", { doc_type: "8-k", symbol: "" })
    ]);
    expect(plan.deleteIds).toEqual(["drop1", "drop2"]);
    expect(plan.keepIds).toEqual(["keep1", "keep2"]);
    expect(plan.counts["empty-ticker"]).toBe(2);
    expect(plan.counts["keep-tickered"]).toBe(1);
    expect(plan.counts["keep-wrong-doc-type"]).toBe(1);
  });

  it("an empty inventory is an empty plan, never an all-clear error", () => {
    const plan = planThirteenFVectorPrune([]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.counts["empty-ticker"]).toBe(0);
  });
});