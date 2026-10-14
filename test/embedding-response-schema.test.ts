import { describe, expect, it } from "vitest";
import { parseProviderEmbeddingResponse, SiliconFlowEmbedSchema } from "../src/lib/rag/embedding-response-schema";

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

describe("SiliconFlowEmbedSchema", () => {
  it("keeps the documented envelope and still requires a numeric embedding", () => {
    const parsed = SiliconFlowEmbedSchema.safeParse({
      object: "list",
      model: "BAAI/bge-m3",
      usage: { prompt_tokens: 3, total_tokens: 3 },
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }]
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.model).toBe("BAAI/bge-m3");
    expect(parsed.data.usage).toEqual({ prompt_tokens: 3, total_tokens: 3 });
    expect(parsed.data.data?.[0]?.embedding).toEqual([0.1, 0.2]);
    expect(parsed.data.data?.[0]?.index).toBe(0);
    expect(parsed.data.data?.[0]?.object).toBe("embedding");
  });

  it("rejects a non-numeric embedding instead of passing it through", () => {
    const parsed = SiliconFlowEmbedSchema.safeParse({
      object: "list",
      model: "BAAI/bge-m3",
      data: [{ object: "embedding", index: 0, embedding: ["not-a-number"] }]
    });
    expect(parsed.success).toBe(false);
  });
});
