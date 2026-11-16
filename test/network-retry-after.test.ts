import { describe, expect, it } from "vitest";
import { retryAfterDelayMs } from "../src/lib/network-errors";

describe("retryAfterDelayMs", () => {
  it("parses Retry-After seconds", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const res = new Response(null, { status: 429, headers: { "Retry-After": "30" } });
    expect(retryAfterDelayMs(res, now)).toBe(30_000);
  });

  it("parses Retry-After HTTP-date", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const res = new Response(null, {
      status: 429,
      headers: { "Retry-After": "Wed, 01 Jan 2026 00:01:00 GMT" }
    });
    expect(retryAfterDelayMs(res, now)).toBe(60_000);
  });
});
