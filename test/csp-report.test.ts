import { describe, expect, it } from "vitest";
import { POST } from "../app/api/csp-report/route";

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
});
