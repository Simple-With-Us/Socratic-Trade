import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/csp-report/route";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/csp-report", () => {
  it("accepts a classic csp-report body and returns 204", async () => {
    const res = await POST(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          "csp-report": {
            "document-uri": "https://socratictrade.com/console",
            "violated-directive": "script-src",
            "blocked-uri": "https://evil.example/x.js"
          }
        })
      })
    );
    expect(res.status).toBe(204);
  });

  it("returns 204 on garbage / oversized bodies (never 5xx)", async () => {
    const bad = await POST(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        body: "not-json"
      })
    );
    expect(bad.status).toBe(204);

    const huge = await POST(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "content-length": String(50_000) },
        body: "x".repeat(100)
      })
    );
    expect(huge.status).toBe(204);
  });

  // The cap is the POINT of this endpoint being unauthenticated, so each way of
  // slipping past it gets its own test. Before the streaming rewrite, all three
  // of these reached `await request.text()` and buffered the whole body first.
  it("drops an oversized body that declares no content-length", async () => {
    const oversized = JSON.stringify({
      "csp-report": { "document-uri": "https://socratictrade.com/", "blocked-uri": "x".repeat(64_000) }
    });
    const res = await POST(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Deliberately no content-length: a chunked request omits it, so the
        // header can never be the enforcement point.
        body: oversized
      })
    );
    expect(res.status).toBe(204);
  });

  it("drops an oversized body that UNDER-declares its content-length", async () => {
    const res = await POST(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "10" },
        body: "y".repeat(64_000)
      })
    );
    expect(res.status).toBe(204);
  });

  it("measures BYTES, not UTF-16 code units", async () => {
    // 12k multi-byte chars = 12k `String.length` (under the 16_384 char cap the
    // old code checked) but 36_000 bytes — over the real byte cap.
    const multibyte = "€".repeat(12_000);
    const res = await POST(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "csp-report": { "blocked-uri": multibyte } })
      })
    );
    expect(res.status).toBe(204);
  });

  it("still accepts a multi-byte body that fits inside the byte cap", async () => {
    const res = await POST(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          "csp-report": {
            "document-uri": "https://socratictrade.com/console",
            "violated-directive": "script-src",
            "blocked-uri": `https://evil.example/${"é".repeat(100)}.js`
          }
        })
      })
    );
    expect(res.status).toBe(204);
  });

  it("logs each Reporting API array item instead of the array itself", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((message?: unknown, extra?: unknown) => {
      lines.push(`${String(message)} ${String(extra)}`);
    });
    const res = await POST(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/reports+json" },
        body: JSON.stringify([
          {
            type: "csp-violation",
            body: {
              documentURL: "https://socratictrade.com/welcome",
              effectiveDirective: "script-src",
              blockedURL: "https://evil.example/a.js"
            }
          },
          {
            type: "csp-violation",
            body: {
              documentURL: "https://socratictrade.com/privacy-policy",
              effectiveDirective: "img-src",
              blockedURL: "https://evil.example/b.png"
            }
          }
        ])
      })
    );
    expect(res.status).toBe(204);
    const logged = lines.filter((line) => line.startsWith("[csp-report] "));
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("script-src");
    expect(logged[0]).toContain("https://evil.example/a.js");
    expect(logged[0]).toContain("https://socratictrade.com/welcome");
    expect(logged[1]).toContain("img-src");
    expect(logged[1]).toContain("https://evil.example/b.png");
  });
});
