/**
 * Tests for humanizeLlmError — raw provider error → plain-English, provider-aware message.
 * Pure function; no DB/network.
 */
import { describe, expect, it } from "vitest";
import { humanizeLlmError, humanizeLlmTransportError, providerFromText, providerLabel } from "../src/lib/llm-errors";

describe("providerLabel / providerFromText", () => {
  it("maps internal provider ids to display names", () => {
    expect(providerLabel("xai")).toBe("xAI (Grok)");
    expect(providerLabel("gemini")).toBe("Google (Gemini)");
    expect(providerLabel("mistral")).toBe("Mistral");
    expect(providerLabel("anthropic")).toBe("Anthropic (Claude)");
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel(undefined)).toBe("the LLM");
  });

  it("detects the provider from raw error text (host/family hints)", () => {
    expect(providerFromText("openai 401: Incorrect API key provided")).toBe("OpenAI");
    expect(providerFromText("gemini 400: generativelanguage.googleapis.com error")).toBe("Google (Gemini)");
    expect(providerFromText("mistral 401: unauthorized")).toBe("Mistral");
    expect(providerFromText("xai 403: x.ai forbidden")).toBe("xAI (Grok)");
    expect(providerFromText("anthropic 401")).toBe("Anthropic (Claude)");
  });
});

describe("humanizeLlmError", () => {
  it("explains a rejected key (401 / incorrect key) with the right provider", () => {
    const msg = humanizeLlmError("gemini 401: API key not valid. Please pass a valid API key.");
    expect(msg).toContain("Google (Gemini)");
    expect(msg.toLowerCase()).toContain("rejected the api key");
    expect(msg).toContain("Settings → Connections");
  });

  it("uses an explicit provider + status over text sniffing", () => {
    const msg = humanizeLlmError("nope", { provider: "mistral", status: 401 });
    expect(msg).toContain("Mistral");
    expect(msg.toLowerCase()).toContain("rejected the api key");
  });

  it("maps 429 to a rate-limit/quota message", () => {
    const msg = humanizeLlmError("openai 429: You exceeded your current quota", { provider: "openai" });
    expect(msg.toLowerCase()).toMatch(/rate limit|quota|credit/);
    expect(msg).toContain("OpenAI");
  });

  it("maps 5xx to a temporary server-error message", () => {
    expect(humanizeLlmError("", { provider: "xai", status: 503 }).toLowerCase()).toContain("temporarily unavailable");
  });

  it("maps 403 to an access/region message and 404 to model-not-available", () => {
    expect(humanizeLlmError("forbidden", { provider: "openai", status: 403 }).toLowerCase()).toContain("access");
    expect(humanizeLlmError("model_not_found", { provider: "openai", status: 404 }).toLowerCase()).toContain("isn't available");
  });

  it("falls back to the raw text (single line, provider-prefixed) for unrecognized errors", () => {
    const msg = humanizeLlmError("some weird\n  multi-line   detail", { provider: "openai" });
    expect(msg).toContain("OpenAI error:");
    expect(msg).not.toContain("\n");
  });

  it("handles empty input gracefully", () => {
    expect(humanizeLlmError("")).toContain("the LLM");
    expect(humanizeLlmError(null)).toContain("the LLM");
  });

  it("adds step/model context for transport timeouts", () => {
    const msg = humanizeLlmTransportError(new Error("The operation was aborted due to timeout"), {
      provider: "openai",
      model: "gpt-5.5",
      stepLabel: "Green Team proposal",
      timeoutMs: 60_000
    });

    expect(msg).toBe("Green Team proposal timed out after 60s using OpenAI gpt-5.5. Lower reasoning effort, choose a faster model, or retry.");
  });
});
