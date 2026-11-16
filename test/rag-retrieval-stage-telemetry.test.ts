import { describe, expect, it } from "vitest";
import { RetrievalStageTrace } from "../src/lib/rag/retrieval-stage-telemetry";

function clock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

describe("RetrievalStageTrace", () => {
  it("records repeatable stages, candidate counts, and a text-free query digest", () => {
    const trace = new RetrievalStageTrace(
      { query: "AAPL Item 1A risk factors", symbol: "aapl", route: "openrouter" },
      clock([0, 1, 6, 7, 12, 20])
    );
    const endDense = trace.start("dense_query", { namespace: "managed", candidatesIn: 0 });
    endDense({ candidatesOut: 80 });
    const endDenseTwo = trace.start("dense_query", { namespace: "legacy", candidatesIn: 0 });
    endDenseTwo({ candidatesOut: 20, dropped: -4 });

    const snapshot = trace.snapshot(8);
    expect(snapshot).toMatchObject({
      traceVersion: 1,
      symbol: "AAPL",
      route: "openrouter",
      wallDurationMs: 20,
      finalCandidates: 8
    });
    expect(snapshot.queryHash).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(snapshot)).not.toContain("risk factors");
    expect(snapshot.stages).toEqual([
      expect.objectContaining({ stage: "dense_query", ordinal: 1, durationMs: 5, ok: true, namespace: "managed", candidatesOut: 80 }),
      expect.objectContaining({ stage: "dense_query", ordinal: 2, durationMs: 5, ok: true, namespace: "legacy", candidatesOut: 20, dropped: 0 })
    ]);
  });

  it("records an error kind without swallowing the failure", async () => {
    const trace = new RetrievalStageTrace({ query: "MSFT", symbol: "MSFT" }, clock([0, 2, 9, 10]));
    await expect(trace.measure("rerank", { provider: "openrouter", candidatesIn: 40 }, async () => {
      throw new TypeError("secret provider response");
    })).rejects.toThrow("secret provider response");

    expect(trace.snapshot().stages[0]).toMatchObject({
      stage: "rerank",
      ok: false,
      errorKind: "TypeError",
      durationMs: 7
    });
    expect(JSON.stringify(trace.snapshot())).not.toContain("secret provider response");
  });

  it("makes a stage end callback idempotent", () => {
    const trace = new RetrievalStageTrace({ query: "NVDA", symbol: "NVDA" }, clock([0, 1, 3, 7]));
    const end = trace.start("fusion");
    end({ candidatesIn: 30, candidatesOut: 12 });
    end({ candidatesIn: 999, candidatesOut: 999 });
    expect(trace.snapshot().stages).toHaveLength(1);
    expect(trace.snapshot().stages[0]).toMatchObject({ candidatesIn: 30, candidatesOut: 12 });
  });
});
