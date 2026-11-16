/**
 * hyde-multiquery-retrieval (2026-07-05): HyDE hypothetical-passage generation.
 *
 * `generateHydePassages` drafts 1-3 short hypothetical filing passages via ONE cheap LLM call —
 * default OFF (RAG_HYDE), fails open (returns []) on ANY error so a HyDE outage never blocks
 * retrieval. Mirrors test/salience-llm.test.ts's mocking pattern: mock `getPolicy`/`resolveLlmEndpoint`
 * so no live network/DB is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPolicy: vi.fn(),
  resolveLlmEndpoint: vi.fn(),
  audit: vi.fn(),
  recordLlmUsage: vi.fn(),
  isOverLlmBudget: vi.fn()
}));

vi.mock("../src/lib/db", () => ({
  getPolicy: mocks.getPolicy,
  audit: mocks.audit
}));

vi.mock("../src/lib/llm-provider", () => ({
  resolveLlmEndpoint: mocks.resolveLlmEndpoint
}));

vi.mock("../src/lib/llm-usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/llm-usage")>();
  return { ...actual, recordLlmUsage: mocks.recordLlmUsage };
});

vi.mock("../src/lib/llm-budget", () => ({
  isOverLlmBudget: mocks.isOverLlmBudget
}));

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isOverLlmBudget.mockReturnValue(false);
  delete process.env.RAG_HYDE_MODEL;
  mocks.getPolicy.mockReturnValue({ llmModel: "gpt-5.4-mini" });
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.RAG_HYDE_MODEL;
});

describe("hydeEnabled (default-off flag)", () => {
  beforeEach(() => {
    delete process.env.RAG_HYDE;
  });
  afterEach(() => {
    delete process.env.RAG_HYDE;
  });

  it("is off by default", async () => {
    const { hydeEnabled } = await import("../src/lib/rag/multi-query");
    expect(hydeEnabled()).toBe(false);
  });
  it("turns on with RAG_HYDE=on", async () => {
    process.env.RAG_HYDE = "on";
    const { hydeEnabled } = await import("../src/lib/rag/multi-query");
    expect(hydeEnabled()).toBe(true);
  });
});

describe("generateHydePassages", () => {
  it("returns [] immediately for an empty queries array (no LLM call)", async () => {
    global.fetch = vi.fn(() => {
      throw new Error("should not be called for empty queries");
    }) as any;
    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages([]);
    expect(result).toEqual([]);
  });

  it("returns [] when no LLM credential resolves (no key)", async () => {
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://openrouter.ai/v1/chat/completions", key: undefined, model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() => {
      throw new Error("should not be called with no key");
    }) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual([]);
    expect(mocks.recordLlmUsage).not.toHaveBeenCalled();
  });

  it("drafts passages and records LLM usage under context 'rag-hyde' on success", async () => {
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://openrouter.ai/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", keyRef: "fp123", transport: "chat-completions" });
    const passages = ["Hypothetical risk-factor excerpt one.", "Hypothetical guidance excerpt two."];
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ passages }) } }],
          usage: { prompt_tokens: 120, completion_tokens: 80 }
        })
      })
    ) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors", "AAPL guidance"], { userId: "user-1" });

    expect(result).toEqual(passages);
    expect(mocks.recordLlmUsage).toHaveBeenCalledTimes(1);
    const call = mocks.recordLlmUsage.mock.calls[0][0];
    expect(call.context).toBe("rag-hyde");
    expect(call.userId).toBe("user-1");
    expect(call.provider).toBe("openai");
    expect(call.model).toBe("gpt-5.4-mini");
    expect(call.promptTokens).toBe(120);
    expect(call.completionTokens).toBe(80);
  });

  it("respects RAG_HYDE_MODEL override, and resolves the endpoint FOR that overridden model (not the policy's general llmModel)", async () => {
    process.env.RAG_HYDE_MODEL = "gpt-5.4";
    // Mirror resolveLlmEndpoint's real contract: the endpoint it returns is resolved FOR whatever
    // model is passed in `policy.llmModel` (2026-07-05 review fix, Finding 4) — echo that back so
    // this test would catch a regression to the old bug (endpoint resolved from the ambient
    // `policy.llmModel` while a DIFFERENT model, hydeModel(), is sent in the request body).
    mocks.resolveLlmEndpoint.mockImplementation((policy: { llmModel?: string | null }) => ({
      provider: "openai",
      url: "https://openrouter.ai/v1/chat/completions",
      key: "sk-test",
      model: policy?.llmModel ?? "gpt-5.4-mini",
      keySource: "user",
      transport: "chat-completions"
    }));
    global.fetch = vi.fn((_url: string, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.model).toBe("gpt-5.4");
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ passages: ["x"] }) } }] })
      });
    }) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual(["x"]);
    // resolveLlmEndpoint must have been called with the override baked into the policy it resolves
    // provider/URL/key from, not the ambient getPolicy() llmModel ("gpt-5.4-mini" per this file's
    // default beforeEach mock) — otherwise an Anthropic-policy user would get an OpenAI model routed
    // to openrouter.ai (the exact bug this fix closes).
    expect(mocks.resolveLlmEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: "gpt-5.4" }),
      "local",
      expect.any(String),
      "green"
    );
  });

  it("resolves the endpoint FOR the HyDE model even under an Anthropic policy.llmModel (Finding 4: prevents an OpenAI model id being sent to openrouter.ai)", async () => {
    // No RAG_HYDE_MODEL override -> default "gpt-5.4-mini". getPolicy() (mocked in beforeEach)
    // returns { llmModel: "gpt-5.4-mini" } for this describe block already, but assert explicitly
    // that resolveLlmEndpoint is called with the HyDE model, NOT whatever policy.llmModel says —
    // even if the ambient policy were "claude-*", the endpoint must still be resolved for the model
    // actually sent (hydeModel()), so provider/URL/transport stay coherent with the request body.
    mocks.getPolicy.mockReturnValue({ llmModel: "claude-opus-4-1" });
    mocks.resolveLlmEndpoint.mockImplementation((policy: { llmModel?: string | null }) => ({
      provider: "openai",
      url: "https://openrouter.ai/v1/chat/completions",
      key: "sk-test",
      model: policy?.llmModel ?? "gpt-5.4-mini",
      keySource: "user",
      transport: "chat-completions"
    }));
    global.fetch = vi.fn((_url: string, init: any) => {
      const body = JSON.parse(init.body);
      // Must be the HyDE model, never the unrelated Anthropic policy.llmModel.
      expect(body.model).toBe("gpt-5.4-mini");
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ passages: ["y"] }) } }] })
      });
    }) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual(["y"]);
    expect(mocks.resolveLlmEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: "gpt-5.4-mini" }),
      "local",
      expect.any(String),
      "green"
    );
  });

  it("returns [] and audits on a network error (fail-open, never throws)", async () => {
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://openrouter.ai/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() => Promise.reject(new Error("network down"))) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual([]);
    expect(mocks.audit).toHaveBeenCalledWith("rag_hyde_failed", expect.objectContaining({ reason: expect.any(String) }), "local");
    expect(mocks.recordLlmUsage).not.toHaveBeenCalled();
  });

  it("returns [] on a non-OK HTTP response, and audits rag_hyde_failed (2026-07-05 review fix: this path used to be silent)", async () => {
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://openrouter.ai/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 429, json: async () => ({}) })) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual([]);
    expect(mocks.audit).toHaveBeenCalledWith(
      "rag_hyde_failed",
      expect.objectContaining({ reason: "HTTP 429", provider: "openai", model: "gpt-5.4-mini" }),
      "local"
    );
    expect(mocks.recordLlmUsage).not.toHaveBeenCalled();
  });

  it("returns [] on malformed/unparseable JSON", async () => {
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://openrouter.ai/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "not valid json {{{" } }] }) })
    ) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual([]);
  });

  it("caps at 3 passages even when the model returns more", async () => {
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://openrouter.ai/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ passages: ["a", "b", "c", "d", "e"] }) } }] })
      })
    ) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("returns [] with no request when the user is over their daily LLM/RAG budget (2026-07-05 review fix, Finding 6: mirrors retrieveContextDetailed's own isOverLlmBudget gate)", async () => {
    mocks.isOverLlmBudget.mockReturnValue(true);
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://openrouter.ai/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() => {
      throw new Error("should not be called when over budget");
    }) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"], { userId: "user-1", connectedAccountId: "acct-1" });

    expect(result).toEqual([]);
    expect(mocks.isOverLlmBudget).toHaveBeenCalledWith("user-1", "acct-1");
    expect(mocks.resolveLlmEndpoint).not.toHaveBeenCalled();
  });
});
