import { describe, expect, it } from "vitest";
import {
  createLivePineconeInferenceTransport,
  loadPineconeBenchmarkCases,
  runPineconeInferenceBenchmark,
  type BenchmarkCase,
  type Transport
} from "../scripts/eval/pinecone-inference-benchmark";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const cases: BenchmarkCase[] = [{
  id: "apple-products",
  query: "Which passage is about Apple products?",
  candidates: [
    { id: "fruit", text: "Apples are sweet fruit.", relevant: false },
    { id: "company", text: "Apple builds iPhone products.", relevant: true }
  ]
}];

function mockTransport(): Transport {
  return {
    async request(path, init) {
      if (path === "/models") return { models: [{ model: "llama-text-embed-v2", type: "embed", provider_name: "NVIDIA" }] };
      if (path === "/embed") {
        const body = init.body as { parameters: { input_type: string }; inputs: Array<{ text: string }> };
        if (body.parameters.input_type === "query") return { data: [{ values: [1, 0] }] };
        return { data: body.inputs.map((input) => input.text.includes("iPhone") ? { values: [1, 0] } : { values: [0, 1] }) };
      }
      if (path === "/rerank") return { data: [{ index: 1, score: 0.99 }, { index: 0, score: 0.01 }] };
      throw new Error(`unexpected ${path}`);
    }
  };
}

describe("Pinecone hosted-inference benchmark", () => {
  it("benchmarks dense and arbitrary rerank models while retaining no document text in output", async () => {
    let clock = 0;
    const report = await runPineconeInferenceBenchmark(cases, {
      transport: mockTransport(), embedModels: ["llama-text-embed-v2"], rerankModels: ["cohere-rerank-3.5"],
      includeInventory: true, limit: 2, now: () => (clock += 10)
    });
    expect(report.candidates).toHaveLength(2);
    for (const candidate of report.candidates) {
      expect(candidate.metrics).toEqual({ recallAtK: 1, mrr: 1, ndcgAtK: 1 });
      expect(candidate.cases[0]!.ranking.map((item) => item.id)).toEqual(["company", "fruit"]);
      expect(candidate.latencyMs).toBeGreaterThan(0);
    }
    expect(report.inventory).toEqual([{ model: "llama-text-embed-v2", type: "embed", providerName: "NVIDIA" }]);
    expect(JSON.stringify(report)).not.toContain("Apple builds iPhone products.");
  });

  it("loads frozen cases and rejects a case without a relevant label", () => {
    const path = join(process.env.TMPDIR!, "pinecone-benchmark-cases.json");
    writeFileSync(path, JSON.stringify({ cases }));
    expect(loadPineconeBenchmarkCases(path)).toEqual(cases);
    writeFileSync(path, JSON.stringify([{ ...cases[0], candidates: [{ ...cases[0]!.candidates[0], relevant: false }] }]));
    expect(() => loadPineconeBenchmarkCases(path)).toThrow("requires at least one relevant");
  });

  it("refuses to create a network transport without the explicit live gate", async () => {
    await expect(createLivePineconeInferenceTransport(false)).rejects.toThrow("--allow-live");
  });
});
