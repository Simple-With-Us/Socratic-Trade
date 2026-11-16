import { describe, expect, it } from "vitest";
import { selectItemsWithinWriteBudget } from "../src/lib/pinecone-write-budget";

describe("selectItemsWithinWriteBudget", () => {
  it("keeps documents that fit the remaining cap", () => {
    const docs = [
      { id: "a", wu: 10 },
      { id: "b", wu: 10 },
      { id: "c", wu: 10 }
    ];
    const result = selectItemsWithinWriteBudget(docs, (d) => d.wu, 0, 25);
    expect(result.kept.map((d) => d.id)).toEqual(["a", "b"]);
    expect(result.skipped).toBe(1);
    expect(result.requested).toBe(30);
  });

  it("accepts the first document of a zero-used window even when the estimate exceeds the cap", () => {
    const docs = [
      { id: "filing", wu: 28 },
      { id: "next", wu: 12 }
    ];
    const result = selectItemsWithinWriteBudget(docs, (d) => d.wu, 0, 15);
    expect(result.kept.map((d) => d.id)).toEqual(["filing"]);
    expect(result.skipped).toBe(1);
    expect(result.requested).toBe(40);
    expect(result.allowed).toBe(15);
  });

  it("does not use the one-document floor once any units have already been used", () => {
    const docs = [{ id: "filing", wu: 28 }];
    const result = selectItemsWithinWriteBudget(docs, (d) => d.wu, 10, 15);
    expect(result.kept).toEqual([]);
    expect(result.skipped).toBe(1);
  });
});
