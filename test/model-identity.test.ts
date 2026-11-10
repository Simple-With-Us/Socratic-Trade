import { describe, expect, it } from "vitest";
import { canonicalModelId } from "../src/lib/model-identity";

describe("canonicalModelId — family identity for Results / price benchmarking / history", () => {
  it("collapses every Gemini Flash version onto gemini-flash-latest", () => {
    expect(canonicalModelId("gemini-flash-latest")).toBe("gemini-flash-latest");
    expect(canonicalModelId("gemini-3.7-flash")).toBe("gemini-flash-latest");
    expect(canonicalModelId("google/gemini-3.7-flash")).toBe("gemini-flash-latest");
    expect(canonicalModelId("openrouter/google/gemini-3.7-flash")).toBe("gemini-flash-latest");
    expect(canonicalModelId("gemini-3.6-flash")).toBe("gemini-flash-latest");
    expect(canonicalModelId("gemini-3.5-flash")).toBe("gemini-flash-latest");
    expect(canonicalModelId("gemini-2.5-flash")).toBe("gemini-flash-latest");
  });

  it("collapses every Gemini Flash Lite version onto gemini-flash-lite-latest", () => {
    expect(canonicalModelId("gemini-flash-lite-latest")).toBe("gemini-flash-lite-latest");
    expect(canonicalModelId("gemini-3.5-flash-lite")).toBe("gemini-flash-lite-latest");
    expect(canonicalModelId("google/gemini-3.1-flash-lite")).toBe("gemini-flash-lite-latest");
    expect(canonicalModelId("gemini-2.5-flash-lite")).toBe("gemini-flash-lite-latest");
  });

  it("collapses every Gemini Pro version onto gemini-pro-latest", () => {
    expect(canonicalModelId("gemini-pro-latest")).toBe("gemini-pro-latest");
    expect(canonicalModelId("gemini-3.1-pro-preview")).toBe("gemini-pro-latest");
    expect(canonicalModelId("google/gemini-2.5-pro")).toBe("gemini-pro-latest");
  });

  it("collapses every Claude Opus / Sonnet / Haiku / Fable onto the catalog family id", () => {
    expect(canonicalModelId("claude-opus-5-5")).toBe("claude-opus-latest");
    expect(canonicalModelId("claude-opus-5.5")).toBe("claude-opus-latest");
    expect(canonicalModelId("claude-opus-5")).toBe("claude-opus-latest");
    expect(canonicalModelId("claude-opus-4-8")).toBe("claude-opus-latest");
    expect(canonicalModelId("anthropic/claude-opus-latest")).toBe("claude-opus-latest");
    expect(canonicalModelId("claude-3-opus")).toBe("claude-opus-latest");
    expect(canonicalModelId("claude-sonnet-5")).toBe("claude-sonnet-latest");
    expect(canonicalModelId("claude-sonnet-4-6")).toBe("claude-sonnet-latest");
    expect(canonicalModelId("claude-sonnet-latest")).toBe("claude-sonnet-latest");
    expect(canonicalModelId("openrouter/~anthropic/claude-sonnet-latest")).toBe("claude-sonnet-latest");
    expect(canonicalModelId("claude-haiku-4.5")).toBe("claude-haiku-latest");
    expect(canonicalModelId("claude-haiku-4-5")).toBe("claude-haiku-latest");
    expect(canonicalModelId("claude-3-5-haiku")).toBe("claude-haiku-latest");
    expect(canonicalModelId("claude-fable-5")).toBe("claude-fable-latest");
    expect(canonicalModelId("anthropic/claude-fable-latest")).toBe("claude-fable-latest");
  });

  it("keeps distinct product lines separate (Flash vs Flash Lite vs Pro; Terra vs Luna vs Sol)", () => {
    expect(canonicalModelId("gemini-3.7-flash")).not.toBe(canonicalModelId("gemini-3.5-flash-lite"));
    expect(canonicalModelId("gemini-3.7-flash")).not.toBe(canonicalModelId("gemini-3.1-pro-preview"));
    expect(canonicalModelId("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(canonicalModelId("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(canonicalModelId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("keeps each OpenAI generation on its own identity, even for dated served ids (ST-4589)", () => {
    expect(canonicalModelId("gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(canonicalModelId("openai/gpt-6.1-sol-20261101")).toBe("gpt-6.1-sol");
    expect(canonicalModelId("openai/gpt-5.6-sol-20260701")).toBe("gpt-5.6-sol");
    expect(canonicalModelId("openai/gpt-6.1-terra")).toBe("gpt-6.1-terra");
    expect(canonicalModelId("openai/gpt-6-luna")).toBe("gpt-6-luna");
    expect(canonicalModelId("gpt-sol-latest")).toBe("gpt-6.1-sol");
    expect(canonicalModelId("openai/gpt-6-astra-pro")).toBe("gpt-6-astra-pro");
    expect(canonicalModelId("openai/gpt-6.1-sol-pro")).toBe("gpt-6.1-sol-pro");
    // Llama ids are no longer collapsed onto a llama catalog id.
    expect(canonicalModelId("meta-llama/llama-4-maverick")).toBe("llama-4-maverick");
  });
});

