import { describe, expect, it } from "vitest";
import { PayloadTooLargeError, readBodyWithLimit, readJsonWithLimit } from "../src/lib/bounded-body";

describe("readBodyWithLimit", () => {
  it("reads a body under the cap", async () => {
    const req = new Request("http://x/y", { method: "POST", body: "hello world" });
    await expect(readBodyWithLimit(req, 1000)).resolves.toBe("hello world");
  });

  it("returns an empty string for a bodyless request", async () => {
    const req = new Request("http://x/y", { method: "GET" });
    await expect(readBodyWithLimit(req, 1000)).resolves.toBe("");
  });

  it("rejects (413-worthy) via a declared content-length that exceeds the cap, without reading the stream", async () => {
    // No actual body attached — proves the declared-length fast path alone is enough to reject,
    // it doesn't require ever touching req.body.
    const req = new Request("http://x/y", {
      method: "POST",
      headers: { "content-length": String(10 * 1024 * 1024) }
    });
    await expect(readBodyWithLimit(req, 1024)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("rejects an actually-oversized body even with NO content-length header (streaming abort)", async () => {
    const big = "a".repeat(2000);
    const req = new Request("http://x/y", { method: "POST", body: big });
    // Sanity: fetch's Request does not surface an implicit content-length header here — this
    // genuinely exercises the streaming byte-count path, not the declared-header fast path.
    expect(req.headers.get("content-length")).toBeNull();
    await expect(readBodyWithLimit(req, 1000)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("rejects an actually-oversized body when content-length UNDERSTATES the real size (a lying header)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(60)));
        controller.enqueue(new TextEncoder().encode("a".repeat(60)));
        controller.close();
      }
    });
    const req = new Request("http://x/y", {
      method: "POST",
      // @ts-expect-error -- duplex is required by undici for a streaming body but missing from the DOM lib types
      duplex: "half",
      body: stream,
      headers: { "content-length": "10" } // lies — real body is 120 bytes
    });
    await expect(readBodyWithLimit(req, 100)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("accepts a body right at the cap boundary", async () => {
    const exact = "a".repeat(100);
    const req = new Request("http://x/y", { method: "POST", body: exact });
    await expect(readBodyWithLimit(req, 100)).resolves.toBe(exact);
  });

  it("rejects a body one byte over the cap", async () => {
    const req = new Request("http://x/y", { method: "POST", body: "a".repeat(101) });
    await expect(readBodyWithLimit(req, 100)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("preserves multi-byte UTF-8 content within the cap", async () => {
    const text = "héllo wörld 🎉";
    const req = new Request("http://x/y", { method: "POST", body: text });
    await expect(readBodyWithLimit(req, 1000)).resolves.toBe(text);
  });
});

describe("readJsonWithLimit", () => {
  it("parses valid JSON under the cap", async () => {
    const req = new Request("http://x/y", { method: "POST", body: JSON.stringify({ a: 1 }) });
    await expect(readJsonWithLimit(req, 1000)).resolves.toEqual({ a: 1 });
  });

  it("throws PayloadTooLargeError for an oversized body before ever attempting JSON.parse", async () => {
    const req = new Request("http://x/y", { method: "POST", body: JSON.stringify({ a: "x".repeat(2000) }) });
    await expect(readJsonWithLimit(req, 100)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("throws a SyntaxError for malformed JSON under the cap (distinguishable from PayloadTooLargeError)", async () => {
    const req = new Request("http://x/y", { method: "POST", body: "not json" });
    await expect(readJsonWithLimit(req, 1000)).rejects.toBeInstanceOf(SyntaxError);
  });
});
