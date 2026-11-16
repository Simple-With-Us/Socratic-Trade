import { describe, expect, it } from "vitest";
import { classifyRerankIntent, planRerank, resolveRerankRoute } from "../src/lib/rag/rerank-policy";

describe("RAG rerank route", () => {
  it("defaults to the embedding provider without coupling the selectors permanently", () => {
    expect(resolveRerankRoute({
      embeddingProvider: "siliconflow",
      hasCredential: (provider) => provider === "siliconflow",
      env: {}
    })).toMatchObject({
      provider: "siliconflow",
      model: "Qwen/Qwen3-Reranker-8B",
      available: true,
      source: "embedding-provider"
    });
  });

  it("honors an explicit provider/model and reports a missing credential without silent fallback", () => {
    expect(resolveRerankRoute({
      embeddingProvider: "siliconflow",
      configuredProvider: "openrouter",
      hasCredential: () => false,
      env: { OPENROUTER_RERANK_MODEL: "cohere/rerank-v4.0-fast" }
    })).toEqual({
      provider: "openrouter",
      model: "cohere/rerank-v4.0-fast",
      available: false,
      source: "explicit",
      reason: "missing_credential"
    });
  });

  it("keeps recall available and reports an invalid explicit provider", () => {
    expect(resolveRerankRoute({
      embeddingProvider: "openrouter",
      configuredProvider: "voyage",
      hasCredential: () => true,
      env: {}
    })).toEqual({
      provider: "openrouter",
      model: "cohere/rerank-v3.5",
      available: false,
      source: "explicit",
      reason: "invalid_configuration"
    });
  });
});

describe("adaptive rerank depth", () => {
  it("classifies scout, deep, and exact financial queries", () => {
    expect(classifyRerankIntent("Significant catalysts for AAPL", 1)).toBe("scout");
    expect(classifyRerankIntent("Significant catalysts for AAPL", 8)).toBe("deep");
    expect(classifyRerankIntent("10-K Item 1A for 0000320193-24-000123", 8)).toBe("exact");
  });

  it("uses lower scout depth and wider deep depth only when adaptive mode is enabled", () => {
    expect(planRerank({
      query: "AAPL catalysts",
      limit: 1,
      availableCandidates: 200,
      enabled: true,
      adaptiveEnabled: true,
      env: {}
    })).toMatchObject({ shouldRerank: true, intent: "scout", candidateLimit: 40, reason: "adaptive_depth" });

    expect(planRerank({
      query: "AAPL catalysts",
      limit: 8,
      availableCandidates: 200,
      enabled: true,
      adaptiveEnabled: true,
      env: {}
    })).toMatchObject({ shouldRerank: true, intent: "deep", candidateLimit: 150 });
  });

  it("preserves legacy depth when adaptive mode is off and fails open on invalid tuning", () => {
    expect(planRerank({
      query: "AAPL",
      limit: 1,
      availableCandidates: 75,
      enabled: true,
      adaptiveEnabled: false,
      env: { VECTOR_RERANK_OVERFETCH_K: "not-a-number" }
    })).toMatchObject({ candidateLimit: 75, reason: "legacy_depth" });
  });

  it("reads adaptive mode from the supplied environment instead of ambient process state", () => {
    expect(planRerank({
      query: "AAPL catalysts",
      limit: 1,
      availableCandidates: 200,
      enabled: true,
      env: { RAG_ADAPTIVE_RERANK: "on" }
    })).toMatchObject({ candidateLimit: 40, reason: "adaptive_depth" });
  });

  it("does not rerank a singleton or a disabled route", () => {
    expect(planRerank({ query: "AAPL", limit: 1, availableCandidates: 1, enabled: true })).toMatchObject({
      shouldRerank: false,
      reason: "insufficient_candidates"
    });
    expect(planRerank({ query: "AAPL", limit: 1, availableCandidates: 50, enabled: false })).toMatchObject({
      shouldRerank: false,
      reason: "disabled"
    });
  });
});
