import { describe, expect, it } from "vitest";
import { parseProviderEmbeddingResponse } from "../src/lib/rag/embedding-response-schema";

describe("ProviderEmbeddingResponseSchema", () => {
  it("strips unknown keys while keeping id and embedding vectors", () => {
    const parsed = parseProviderEmbeddingResponse({
      id: "gen-fusion-embed-1",
      model: "should-drop",
      data: [{ embedding: [0.1, 0.2], index: 0, object: "drop-me" }]
    });
    expect(parsed.id).toBe("gen-fusion-embed-1");
    expect(parsed.data?.[0]?.embedding).toEqual([0.1, 0.2]);
    expect(Object.keys(parsed.data?.[0] ?? {})).toEqual(["embedding", "index"]);
  });
});
