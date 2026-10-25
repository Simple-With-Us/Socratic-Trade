/**
 * app/console/settings/lib.ts deleteApiKey: the DELETE /api/keys body is strictly validated at the
 * client trust boundary (ST-4580) by a local guard (no zod in the client bundle), so a malformed
 * body never reaches the Remove flow as a success, and runRemoveKey always reloads the list.
 */
import { readFileSync } from "node:fs";
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

describe("ApiKeyDeleteResponseSchema", () => {
  it.each([
    [{ success: true, deleted: true }, true],
    [{ success: true, deleted: false }, true],
    [{ success: false, deleted: true }, false],
    [{ success: true }, false],
    [{ deleted: true }, false],
    [{ success: true, deleted: 1 }, false],
    [{ success: true, deleted: true, extra: null }, false],
    [{ success: true, extra: true }, false],
    [[true, false], false],
    [null, false],
    ["ok", false],
    [undefined, false]
  ])("parses %j -> %s", async (value, expected) => {
    const { ApiKeyDeleteResponseSchema } = await import("../app/console/settings/lib");
    expect(ApiKeyDeleteResponseSchema.safeParse(value).success).toBe(expected);
  });

  it("validates with zod/mini, never the full zod runtime, in the client-imported settings lib", () => {
    const source = readFileSync("app/console/settings/lib.ts", "utf8");
    expect(source).toMatch(/from\s+["']zod\/mini["']/);
    expect(source).not.toMatch(/from\s+["']zod["']/);
  });
});

describe("runRemoveKey", () => {
  const entry = { service: "fmp", label: "FMP", credentialName: "API key", source: "user" as const };

  it("reloads the list and reports success when the key was deleted", async () => {
    const { runRemoveKey } = await import("../app/console/settings/remove-key");
    const reload = vi.fn(async () => {});
    const push = vi.fn();
    const onSettled = vi.fn();
    await runRemoveKey(entry, { deleteApiKey: async () => ({ success: true, deleted: true }), reload, push, onSettled });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("pos", "FMP API key removed", expect.any(String));
  });

  it("still reloads the list when deleteApiKey rejects after the server ran the DELETE", async () => {
    const { runRemoveKey } = await import("../app/console/settings/remove-key");
    const { ConsoleApiError } = await import("../app/console/lib/api");
    const reload = vi.fn(async () => {});
    const push = vi.fn();
    const deleteApiKey = vi.fn(async () => {
      throw new ConsoleApiError("Unexpected response from the server while removing the key.", 200, { success: true, deleted: true, extra: 1 });
    });
    await runRemoveKey(entry, { deleteApiKey, reload, push });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    const [kind, title, detail] = push.mock.calls[0];
    expect(kind).toBe("neg");
    expect(title).toBe("Could not confirm FMP API key removal");
    expect(detail).toContain("may or may not have been removed");
    expect(detail).toContain("list was refreshed");
  });
});
