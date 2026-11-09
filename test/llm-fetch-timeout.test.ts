import { afterEach, describe, expect, it, vi } from "vitest";
import { llmFetch, LLM_TIMEOUT_MS } from "../src/lib/llm-request";

afterEach(() => vi.unstubAllGlobals());

describe("llmFetch — bounded LLM fetch", () => {
  it("injects an AbortSignal timeout when the caller provides none", async () => {
    const spy = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", spy);
    await llmFetch("https://example.com", { method: "POST" });
    expect(spy).toHaveBeenCalledOnce();
    const init = spy.mock.calls[0][1]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe("POST"); // passes through other init fields
  });

  it("respects a caller-supplied signal instead of overriding it", async () => {
    const spy = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", spy);
    const ctrl = new AbortController();
    await llmFetch("https://example.com", { signal: ctrl.signal });
    expect(spy.mock.calls[0][1]!.signal).toBe(ctrl.signal);
  });

  it("uses a positive wall-clock timeout", () => {
    expect(LLM_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
