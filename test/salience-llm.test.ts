/**
 * Item 7 (2026-07-01 RAG workstream): structured-output LLM salience extractor + ticker validation.
 *
 * extractLearnedCandidates() (salience.ts) is an admitted regex stand-in whose TICKER_RE
 * (`\b([A-Z]{1,5})\b`) matches ANY 1-5 char uppercase token, so "I", "A", "CEO" etc. attach as a
 * symbol whenever they appear near a pattern/decision-triggering phrase. This suite covers the new
 * extractLearnedCandidatesLLM(): default OFF (flag), falls back to regex on any failure, and
 * validates any LLM-proposed symbol against the REAL known-universe check (isIndexMemberSymbol)
 * rather than accepting any uppercase token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPolicy: vi.fn(),
  resolveLlmEndpoint: vi.fn()
}));

vi.mock("../src/lib/db", () => ({
  getPolicy: mocks.getPolicy
}));

vi.mock("../src/lib/llm-provider", () => ({
  resolveLlmEndpoint: mocks.resolveLlmEndpoint
}));

const originalFetch = global.fetch;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env.LLM_SALIENCE_EXTRACTOR;
  mocks.getPolicy.mockReturnValue({ llmModel: "gpt-5.4-mini" });
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.LLM_SALIENCE_EXTRACTOR;
});

describe("llmSalienceExtractorEnabled (default-off flag)", () => {
  it("is off by default", async () => {
    delete process.env.LLM_SALIENCE_EXTRACTOR;
    const { llmSalienceExtractorEnabled } = await import("../src/lib/memory/salience-llm");
    expect(llmSalienceExtractorEnabled()).toBe(false);
  });
  it("turns on with LLM_SALIENCE_EXTRACTOR=on", async () => {
    process.env.LLM_SALIENCE_EXTRACTOR = "on";
    const { llmSalienceExtractorEnabled } = await import("../src/lib/memory/salience-llm");
    expect(llmSalienceExtractorEnabled()).toBe(true);
  });
});

describe("extractLearnedCandidatesLLM: flag-off / fallback behavior (regex stays the deterministic default)", () => {
  it("uses the regex extractor (no LLM call) when the flag is off", async () => {
    delete process.env.LLM_SALIENCE_EXTRACTOR;
    global.fetch = vi.fn(() => {
      throw new Error("should not be called when the flag is off");
    }) as any;

    const { extractLearnedCandidatesLLM } = await import("../src/lib/memory/salience-llm");
    const { extractLearnedCandidates } = await import("../src/lib/memory/salience");

    const message = "NVDA is the sole supplier of this component.";
    const result = await extractLearnedCandidatesLLM(message);
    expect(result).toEqual(extractLearnedCandidates(message));
  });

  it("falls back to regex when the flag is on but no LLM credential resolves (no key)", async () => {
    process.env.LLM_SALIENCE_EXTRACTOR = "on";
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: undefined, model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() => {
      throw new Error("should not be called with no key");
    }) as any;

    const { extractLearnedCandidatesLLM } = await import("../src/lib/memory/salience-llm");
    const { extractLearnedCandidates } = await import("../src/lib/memory/salience");

    const message = "TSLA always drifts up after earnings.";
    const result = await extractLearnedCandidatesLLM(message);
    expect(result).toEqual(extractLearnedCandidates(message));
  });

  it("falls back to regex when the LLM call throws (network error / timeout)", async () => {
    process.env.LLM_SALIENCE_EXTRACTOR = "on";
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() => Promise.reject(new Error("network down"))) as any;

    const { extractLearnedCandidatesLLM } = await import("../src/lib/memory/salience-llm");
    const { extractLearnedCandidates } = await import("../src/lib/memory/salience");

    const message = "AAPL always drifts up after earnings.";
    const result = await extractLearnedCandidatesLLM(message);
    expect(result).toEqual(extractLearnedCandidates(message));
  });

  it("falls back to regex on a non-OK HTTP response", async () => {
    process.env.LLM_SALIENCE_EXTRACTOR = "on";
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 429, json: async () => ({}) })) as any;

    const { extractLearnedCandidatesLLM } = await import("../src/lib/memory/salience-llm");
    const { extractLearnedCandidates } = await import("../src/lib/memory/salience");

    const message = "MSFT is the dominant supplier in this market.";
    const result = await extractLearnedCandidatesLLM(message);
    expect(result).toEqual(extractLearnedCandidates(message));
  });

  it("falls back to regex on malformed/unparseable LLM JSON", async () => {
    process.env.LLM_SALIENCE_EXTRACTOR = "on";
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "not valid json {{{" } }] }) })
    ) as any;

    const { extractLearnedCandidatesLLM } = await import("../src/lib/memory/salience-llm");
    const { extractLearnedCandidates } = await import("../src/lib/memory/salience");

    const message = "GOOGL is the dominant supplier in this market.";
    const result = await extractLearnedCandidatesLLM(message);
    expect(result).toEqual(extractLearnedCandidates(message));
  });
});

describe("extractLearnedCandidatesLLM: ticker validation against the real known-universe check", () => {
  function mockFetchWithCandidates(candidates: unknown[]) {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ candidates }) } }] })
      })
    ) as any;
  }

  beforeEach(() => {
    process.env.LLM_SALIENCE_EXTRACTOR = "on";
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
  });

  it("attaches a REAL, known-universe ticker (e.g. AAPL) as the candidate's symbol", async () => {
    mockFetchWithCandidates([{ kind: "decision", value: "AAPL is the dominant supplier of premium smartphones.", symbol: "AAPL" }]);
    const { extractLearnedCandidatesLLM } = await import("../src/lib/memory/salience-llm");

    const result = await extractLearnedCandidatesLLM("AAPL is the dominant supplier of premium smartphones.");
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("AAPL");
    expect(result[0]!.subject).toBe("fact:AAPL");
  });

  it("DROPS a hallucinated/pseudo-ticker symbol (e.g. 'CEO') instead of attaching it — the TICKER_RE bug this fixes", async () => {
    mockFetchWithCandidates([{ kind: "decision", value: "The CEO always talks up guidance on earnings calls.", symbol: "CEO" }]);
    const { extractLearnedCandidatesLLM } = await import("../src/lib/memory/salience-llm");

    const result = await extractLearnedCandidatesLLM("The CEO always talks up guidance on earnings calls.");
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBeNull();
    expect(result[0]!.subject).toBe("fact"); // no symbol suffix when the ticker doesn't validate
  });

  it("drops a single-letter pseudo-ticker ('I') the same way", async () => {
    mockFetchWithCandidates([{ kind: "pattern", value: "I always buy the dip after a selloff.", symbol: "I" }]);
    const { extractLearnedCandidatesLLM } = await import("../src/lib/memory/salience-llm");

    const result = await extractLearnedCandidatesLLM("I always buy the dip after a selloff.");
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBeNull();
  });

  it("treats a null symbol from the model as no symbol (not an error)", async () => {
    mockFetchWithCandidates([{ kind: "pattern", value: "Markets tend to rally into quad-witching.", symbol: null }]);
    const { extractLearnedCandidatesLLM } = await import("../src/lib/memory/salience-llm");

    const result = await extractLearnedCandidatesLLM("Markets tend to rally into quad-witching.");
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBeNull();
  });

  it("drops candidates with an invalid kind and returns an empty array when the model proposes nothing durable", async () => {
    mockFetchWithCandidates([]);
    const { extractLearnedCandidatesLLM } = await import("../src/lib/memory/salience-llm");
    const result = await extractLearnedCandidatesLLM("What's the weather like today?");
    expect(result).toEqual([]);
  });
});
