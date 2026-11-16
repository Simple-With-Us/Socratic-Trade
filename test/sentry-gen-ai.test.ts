import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMock = vi.hoisted(() => ({
  startSpan: vi.fn((_opts: unknown, fn: () => unknown) => fn()),
  getActiveSpan: vi.fn(() => ({ setAttributes: vi.fn() }))
}));

vi.mock("@sentry/nextjs", () => ({
  startSpan: sentryMock.startSpan,
  getActiveSpan: sentryMock.getActiveSpan
}));

import {
  extractModelName,
  inferGenAiSystem,
  setGenAiUsageOnActiveSpan,
  withGenAiSpan
} from "../src/lib/sentry-gen-ai";

describe("sentry gen_ai helpers", () => {
  beforeEach(() => {
    vi.stubEnv("SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    sentryMock.startSpan.mockClear();
    sentryMock.getActiveSpan.mockClear();
  });

  it("infers provider system from URL host", () => {
    expect(inferGenAiSystem("https://openrouter.ai/api/v1/chat/completions")).toBe("openrouter");
    expect(inferGenAiSystem("https://api.openai.com/v1/chat/completions")).toBe("openai");
    expect(inferGenAiSystem("https://api.minimax.io/v1/chat/completions")).toBe("minimax");
    expect(inferGenAiSystem("https://api.voyageai.com/v1/embeddings")).toBe("voyage");
    expect(inferGenAiSystem("https://earningscalls.dev/api/v1/transcripts/1")).toBe("earningscalls");
  });

  it("extracts only the model field from a JSON body", () => {
    expect(
      extractModelName(
        JSON.stringify({ model: "openai/gpt-5.4-mini", messages: [{ role: "user", content: "secret ticker AAPL" }] })
      )
    ).toBe("openai/gpt-5.4-mini");
    expect(extractModelName("{not json")).toBeUndefined();
    expect(extractModelName({ model: "nope" })).toBeUndefined();
  });

  it("wraps fetch in a gen_ai span without recording prompt contents", async () => {
    const result = await withGenAiSpan(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: "x", messages: [{ content: "PII" }] }) },
      async () => "ok"
    );
    expect(result).toBe("ok");
    expect(sentryMock.startSpan).toHaveBeenCalled();
    const opts = sentryMock.startSpan.mock.calls[0][0] as {
      op: string;
      attributes: Record<string, unknown>;
    };
    expect(opts.op).toBe("gen_ai.chat");
    expect(opts.attributes["gen_ai.system"]).toBe("openrouter");
    expect(opts.attributes["gen_ai.request.model"]).toBe("x");
    expect(JSON.stringify(opts)).not.toContain("PII");
  });

  it("sets token usage on the active span", async () => {
    const setAttributes = vi.fn();
    sentryMock.getActiveSpan.mockReturnValueOnce({ setAttributes });
    setGenAiUsageOnActiveSpan({ provider: "openrouter", model: "x", promptTokens: 10, completionTokens: 4 });
    await vi.waitFor(() => expect(setAttributes).toHaveBeenCalled());
    expect(setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "gen_ai.system": "openrouter",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 4
      })
    );
  });
});
