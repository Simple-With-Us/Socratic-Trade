/**
 * /api/policy enum validation for taxSettings.iraWashSaleHandling (IRA wash-sale disregard
 * setting). "disregard" (default), "auto", and "block" persist; anything else 400s.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ira-washsale-api-${randomUUID()}.db`)}`;
});

function putTaxSettings(taxSettings: Record<string, unknown>) {
  return new Request("http://localhost/api/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taxSettings })
  });
}

describe("/api/policy — taxSettings.iraWashSaleHandling validation", () => {
  it("defaults to 'disregard' on a fresh policy (owner decision 2026-07-03)", async () => {
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).taxSettings?.iraWashSaleHandling).toBe("disregard");
  });

  it("accepts and persists 'disregard'", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");

    const response = await PUT(putTaxSettings({ iraWashSaleHandling: "disregard" }));
    expect(response.status).toBe(200);
    const policy = await response.json();
    expect(policy.taxSettings.iraWashSaleHandling).toBe("disregard");
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).taxSettings?.iraWashSaleHandling).toBe("disregard");
  });

  it("accepts 'auto'", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const response = await PUT(putTaxSettings({ iraWashSaleHandling: "auto" }));
    expect(response.status).toBe(200);
    expect((await response.json()).taxSettings.iraWashSaleHandling).toBe("auto");
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).taxSettings?.iraWashSaleHandling).toBe("auto");
  });

  it("accepts tightening back to 'block'", async () => {
    const { PUT } = await import("../app/api/policy/route");
    await PUT(putTaxSettings({ iraWashSaleHandling: "disregard" }));
    const response = await PUT(putTaxSettings({ iraWashSaleHandling: "block" }));
    expect(response.status).toBe(200);
    expect((await response.json()).taxSettings.iraWashSaleHandling).toBe("block");
  });

  it("rejects any other value with a clear 400", async () => {
    const { PUT } = await import("../app/api/policy/route");
    for (const bad of ["ignore", "ask", "factor", "off", 1, true]) {
      const response = await PUT(putTaxSettings({ iraWashSaleHandling: bad }));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("taxSettings.iraWashSaleHandling must be block, auto, or disregard.");
    }
  });

  it("still validates washSaleHandling independently", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const response = await PUT(putTaxSettings({ washSaleHandling: "disregard" }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("taxSettings.washSaleHandling must be block, ask, or auto.");
  });
});
