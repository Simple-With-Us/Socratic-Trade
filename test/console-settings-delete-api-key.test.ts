/**
 * app/console/settings/lib.ts deleteApiKey: the DELETE /api/keys body is Zod-validated at the
 * client trust boundary (ST-4580), so a malformed body never reaches the Remove flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("deleteApiKey response validation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed body when the server sends success and deleted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true, deleted: false })));
    const { deleteApiKey } = await import("../app/console/settings/lib");
    await expect(deleteApiKey("fmp")).resolves.toEqual({ success: true, deleted: false });
  });

  it.each([
    ["missing deleted", { success: true }],
    ["non-boolean deleted", { success: true, deleted: "yes" }],
    ["unknown top-level field", { success: true, deleted: true, extra: 1 }],
    ["non-object body", "ok"]
  ])("rejects a malformed body (%s) with ConsoleApiError", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const { deleteApiKey } = await import("../app/console/settings/lib");
    const { ConsoleApiError } = await import("../app/console/lib/api");
    await expect(deleteApiKey("fmp")).rejects.toBeInstanceOf(ConsoleApiError);
  });
});
