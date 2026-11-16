// /api/policy — benchmarkMode enum validation (r4: index-vs-ETF/sector benchmark basis).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-benchmark-mode-route-${randomUUID()}.db`)}`;
});

function putPolicy(body: Record<string, unknown>) {
  return new Request("http://localhost/api/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("/api/policy — benchmarkMode", () => {
  it("defaults to 'market' when never touched", async () => {
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).benchmarkMode).toBe("market");
  });

  it("accepts 'sector' and persists it", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");

    const response = await PUT(putPolicy({ benchmarkMode: "sector" }));
    expect(response.status).toBe(200);
    expect((await response.json()).benchmarkMode).toBe("sector");
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).benchmarkMode).toBe("sector");
  });

  it("rejects an unrecognized value with a 400, not a silent coercion", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const response = await PUT(putPolicy({ benchmarkMode: "spy_only" }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("benchmarkMode must be market or sector.");
  });
});
