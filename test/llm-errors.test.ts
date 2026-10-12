/**
 * Tests for humanizeLlmError — raw provider error → plain-English, provider-aware message.
 * Pure function; no DB/network.
 */
import { describe, expect, it } from "vitest";
import { describeProviderErrorDetail, humanizeLlmError, humanizeLlmTransportError, providerFromText, providerLabel } from "../src/lib/llm-errors";

describe("providerLabel / providerFromText", () => {
  it("maps internal provider ids to display names", () => {
    expect(providerLabel("xai")).toBe("xAI (Grok)");
    expect(providerLabel("gemini")).toBe("Google (Gemini)");
    expect(providerLabel("mistral")).toBe("Mistral");
    expect(providerLabel("anthropic")).toBe("Anthropic (Claude)");
    expect(providerLabel("minimax")).toBe("MiniMax");
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel(undefined)).toBe("the LLM");
  });

  it("detects the provider from raw error text (host/family hints)", () => {
    expect(providerFromText("openai 401: Incorrect API key provided")).toBe("OpenAI");
    expect(providerFromText("gemini 400: openrouter.ai error")).toBe("Google (Gemini)");
    expect(providerFromText("mistral 401: unauthorized")).toBe("Mistral");
    expect(providerFromText("xai 403: x.ai forbidden")).toBe("xAI (Grok)");
    expect(providerFromText("anthropic 401")).toBe("Anthropic (Claude)");
    expect(providerFromText("minimax 401: unauthorized")).toBe("MiniMax");
  });
});

describe("humanizeLlmError", () => {
  it("explains a rejected key (401 / incorrect key) with the right provider", () => {
    const msg = humanizeLlmError("gemini 401: API key not valid. Please pass a valid API key.");
    expect(msg).toContain("Google (Gemini)");
    expect(msg.toLowerCase()).toContain("rejected the api key");
    expect(msg).toContain("Connections");
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

  it("explains MiniMax insufficient balance after envelope normalization", () => {
    const msg = humanizeLlmError('minimax 402: {"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}');
    expect(msg).toContain("MiniMax");
    expect(msg.toLowerCase()).toMatch(/billing|credits/);
  });

  it("maps 5xx to a temporary server-error message", () => {
    expect(humanizeLlmError("", { provider: "xai", status: 503 }).toLowerCase()).toContain("temporarily unavailable");
  });

  it("maps 403 to an access/region message and 404 model_not_found to a bad slug", () => {
    expect(humanizeLlmError("forbidden", { provider: "openai", status: 403 }).toLowerCase()).toContain("access");
    const missing = humanizeLlmError("model_not_found", { provider: "openai", status: 404 });
    expect(missing.toLowerCase()).toContain("isn't valid");
    expect(missing.toLowerCase()).not.toContain("isn't available on your");
  });

  it("does not blame the OpenRouter account for a 400 Provider returned error", () => {
    const raw = JSON.stringify({ error: { message: "Provider returned error", code: 400 } });
    const msg = humanizeLlmError(raw, { provider: "openrouter", status: 400 });
    expect(msg.toLowerCase()).toContain("provider returned error");
    expect(msg.toLowerCase()).not.toContain("isn't available on your");
    expect(msg.toLowerCase()).not.toContain("openrouter account");
    expect(msg).toContain("OpenRouter");
  });

  it("does not blame the OpenRouter account for a require_parameters No endpoints 404", () => {
    const routing = humanizeLlmError("No endpoints found matching your request", { provider: "openrouter", status: 404 });
    expect(routing.toLowerCase()).toContain("no compatible endpoint");
    expect(routing.toLowerCase()).not.toContain("isn't available on your");
    expect(routing.toLowerCase()).not.toContain("openrouter account");
    const wrapped = humanizeLlmError(
      JSON.stringify({ error: { message: "No endpoints found matching your request", code: 404 } }),
      { provider: "openrouter", status: 404 }
    );
    expect(wrapped.toLowerCase()).toContain("no compatible endpoint");
    expect(wrapped.toLowerCase()).not.toContain("isn't available on your");
    const bare = humanizeLlmError("", { provider: "openrouter", status: 404 });
    expect(bare.toLowerCase()).toContain("couldn't complete");
    expect(bare.toLowerCase()).not.toContain("openrouter account");
  });

  it("treats a true model_not_found as a bad slug, not an account miss", () => {
    const msg = humanizeLlmError("model_not_found", { provider: "openrouter", status: 404 });
    expect(msg.toLowerCase()).toContain("isn't valid");
    expect(msg).toContain("OpenRouter");
    expect(msg.toLowerCase()).not.toContain("isn't available on your");
    expect(msg.toLowerCase()).not.toContain("openrouter account");
  });

  it("maps Anthropic's workspace usage-limit error to a plain-English message (not raw JSON)", () => {
    const raw = '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC."},"request_id":"req_011Ccm8KXQnpRLjFAULndY1w"}';
    const msg = humanizeLlmError(raw, { provider: "anthropic", status: 400 });
    expect(msg).toContain("Anthropic (Claude)");
    expect(msg.toLowerCase()).toContain("usage limit");
    expect(msg).toContain("2026-08-01");
    expect(msg).toContain("regain access on 2026-08-01");
    expect(msg).not.toContain("{");
    expect(msg).not.toContain("request_id");
  });

  it("falls back to the raw text (single line, provider-prefixed) for unrecognized errors", () => {
    const msg = humanizeLlmError("some weird\n  multi-line   detail", { provider: "openai" });
    expect(msg).toContain("OpenAI error:");
    expect(msg).not.toContain("\n");
  });

  // ── Structured provider-error capture (2026-07-09 Roth Bull 400 forensics) ────────────────────
  // Gemini 400s arrive as an ARRAY-wrapped google.rpc error, sometimes with a `details` array that
  // is the ONLY actionable content. The old fallback sliced everything to 240 chars, so the details
  // never reached the persisted run summary — these lock in full capture.

  it("surfaces a Gemini array-wrapped error's code/status/message (the INVALID_ARGUMENT shape)", () => {
    const raw = '[{ "error": { "code": 400, "message": "Request contains an invalid argument.", "status": "INVALID_ARGUMENT" } } ]';
    const msg = humanizeLlmError(raw, { provider: "gemini", status: 400 });
    expect(msg).toBe("Google (Gemini) error 400 INVALID_ARGUMENT: Request contains an invalid argument.");
  });

  it("captures the FULL google.rpc details array (not truncated at 240 chars)", () => {
    const details = [
      {
        "@type": "type.googleapis.com/google.rpc.BadRequest",
        fieldViolations: Array.from({ length: 6 }, (_, i) => ({
          field: `generation_config.response_schema.properties.proposals.items.property_${i}`,
          description: `Schema field violation number ${i} with a reasonably long explanation string attached to it.`
        }))
      }
    ];
    const raw = JSON.stringify([{ error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT", details } }]);
    const msg = humanizeLlmError(raw, { provider: "gemini", status: 400 });
    expect(msg).toContain("details:");
    expect(msg).toContain("property_5"); // the LAST violation survives — nothing was sliced at 240
    expect(msg.length).toBeGreaterThan(240);
  });

  it("surfaces an OpenAI-style structured error's own message instead of a truncated JSON dump", () => {
    const raw = '{"error":{"message":"Invalid schema for response_format: maxItems is not permitted.","type":"invalid_request_error","code":null}}';
    const msg = humanizeLlmError(raw, { provider: "openai", status: 400 });
    expect(msg).toBe("OpenAI error invalid_request_error: Invalid schema for response_format: maxItems is not permitted.");
  });

  it("is idempotent on already-humanized text (no 'Gemini error: Gemini error:' stutter)", () => {
    const once = humanizeLlmError('[{ "error": { "code": 400, "message": "Request contains an invalid argument.", "status": "INVALID_ARGUMENT" } } ]', {
      provider: "gemini",
      status: 400
    });
    const twice = humanizeLlmError(once, { provider: "gemini", status: 400 });
    expect(twice).toBe(once);
  });

  it("handles empty input gracefully", () => {
    expect(humanizeLlmError("")).toContain("the LLM");
    expect(humanizeLlmError(null)).toContain("the LLM");
  });

  it("adds step/model context for transport timeouts", () => {
    const msg = humanizeLlmTransportError(new Error("The operation was aborted due to timeout"), {
      provider: "openai",
      model: "openai/gpt-5.5",
      stepLabel: "Green Team proposal",
      timeoutMs: 60_000
    });

    expect(msg).toBe("Green Team proposal timed out after 60s using OpenAI gpt-5.5. Lower reasoning effort, choose a faster model, or retry.");
  });
});

describe("provider error detail (#4535)", () => {
  const body = (error: Record<string, unknown>) => JSON.stringify({ error });

  it("keeps the friendly 403 sentence and appends status, code, model and provider message", () => {
    const out = humanizeLlmError(body({ code: 403, message: "Your account is not allowed to use this model in your region", metadata: { provider_name: "Azure" } }), {
      provider: "openrouter",
      status: 403,
      model: "openai/gpt-5.6-sol"
    });
    expect(out).toContain("doesn't have access to this model or region");
    expect(out).toContain("[provider detail: HTTP 403; model openai/gpt-5.6-sol; code 403; upstream Azure;");
    expect(out).toContain("not allowed to use this model in your region");
  });

  it("keeps different 403 causes distinguishable after humanizing", () => {
    const region = humanizeLlmError(body({ code: "unsupported_country_region_territory", message: "Country, region, or territory not supported" }), { provider: "openrouter", status: 403, model: "m/x" });
    const moderation = humanizeLlmError(body({ code: 403, message: "Input flagged by moderation", metadata: { reasons: ["violence"], provider_name: "OpenAI" } }), { provider: "openrouter", status: 403, model: "m/x" });
    const allowlist = humanizeLlmError(body({ code: 403, message: "Key not permitted for this model: plan restriction" }), { provider: "openrouter", status: 403, model: "m/x" });
    expect(region).toContain("unsupported_country_region_territory");
    expect(moderation).toContain("reasons violence");
    expect(moderation).toContain("upstream OpenAI");
    expect(allowlist).toContain("plan restriction");
    expect(new Set([region, moderation, allowlist]).size).toBe(3);
  });

  it("redacts API keys, bearer tokens and auth headers", () => {
    const detail = describeProviderErrorDetail(
      body({ code: 401, message: "Bad key sk-or-v1-abcdef1234567890abcdef1234567890 sent with Authorization: Bearer abcdef1234567890XYZ and api_key=zzzzzzzzzzzz1234" }),
      { status: 401 }
    );
    expect(detail).not.toContain("abcdef1234567890");
    expect(detail).not.toContain("zzzzzzzzzzzz1234");
    expect(detail).toContain("[redacted]");
    const long = "A".repeat(45);
    expect(describeProviderErrorDetail(`plain body ${long}`, { status: 500 })).not.toContain(long);
  });

  it("bounds oversized bodies", () => {
    const huge = "word ".repeat(2000);
    const detail = describeProviderErrorDetail(huge, { status: 502 });
    expect(detail.length).toBeLessThan(500);
    expect(detail).toContain("...");
    const structured = describeProviderErrorDetail(body({ message: huge, code: 403 }), { status: 403 });
    expect(structured.length).toBeLessThan(600);
  });

  it("does not stutter when an already-detailed message is humanized again", () => {
    const once = humanizeLlmError(body({ code: 403, message: "nope" }), { provider: "openrouter", status: 403, model: "m/x" });
    expect(humanizeLlmError(once, { provider: "openrouter" })).toBe(once);
    expect(humanizeLlmTransportError(new Error(once), { provider: "openrouter", model: "m/x", stepLabel: "Bull" })).toContain(once);
  });

  it("does not skip humanizing a raw body that only mentions the detail marker", () => {
    const out = humanizeLlmError('forbidden [provider detail: fake] trailing words', { provider: "openrouter", status: 403 });
    expect(out).toContain("doesn't have access to this model or region");
  });

  it("returns nothing extra when there is no status, model or body", () => {
    expect(describeProviderErrorDetail("", {})).toBe("");
    expect(humanizeLlmError("", { provider: "xai", status: 503 })).toContain("[provider detail: HTTP 503]");
  });

  it("still maps unrecognized text and older plain records unchanged", () => {
    expect(humanizeLlmError("something odd", { provider: "openai" })).toBe("OpenAI error: something odd");
  });
});
