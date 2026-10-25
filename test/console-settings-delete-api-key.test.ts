/**
 * app/console/settings/lib.ts deleteApiKey: the DELETE /api/keys body is strictly validated at the
 * client trust boundary (ST-4580) with the strict, tree-shakable ApiKeyDeleteResponseSchema from
 * zod/mini, so only the zod/mini runtime (never the full zod runtime) reaches the Settings client
 * bundle, a malformed body never reaches the Remove flow as a success, and runRemoveKey always
 * reloads the list.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The zod specifiers that ship the MINI build.  zod 4.6.2 exposes three of them — zod/mini,
 * zod/v4/mini and zod/v4-mini — and every one of them is the mini runtime.  Which entrypoint is
 * the mini one is a property of zod's exports map, NOT of the spelling, so the set is enumerated
 * here rather than pattern-matched: a future zod major's mini entrypoint has to be added on
 * purpose, and a full-runtime entrypoint can never slip past by looking mini-ish.
 */
const ZOD_MINI_SPECIFIERS = ["zod/mini", "zod/v4/mini", "zod/v4-mini"];

/**
 * Flags any import of a zod specifier that is NOT one of the mini entrypoints — zod, zod/v4,
 * zod/v4/classic, zod/v4/core, zod/v3, ... — because those pull in the full runtime, whether
 * imported statically, dynamically, or re-exported.
 */
const ZOD_FULL_RUNTIME_GUARD =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']zod(?!(?:\/mini|\/v4\/mini|\/v4-mini)["'])(?:\/[^"']*)?["']/;

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
    expect(source).not.toMatch(ZOD_FULL_RUNTIME_GUARD);
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

describe("the zod full-runtime guard", () => {
  const IMPORT_FORMS = [
    (specifier: string) => `import { z } from "${specifier}";`,
    (specifier: string) => `const z = await import("${specifier}");`,
    (specifier: string) => `const z = require("${specifier}");`,
    (specifier: string) => `import "${specifier}";`
  ];

  it.each(ZOD_MINI_SPECIFIERS)("allows the mini entrypoint %s in every import form", (specifier) => {
    for (const form of IMPORT_FORMS) {
      expect(form(specifier)).not.toMatch(ZOD_FULL_RUNTIME_GUARD);
    }
  });

  it.each(["zod", "zod/v4", "zod/v4/classic", "zod/v4/core", "zod/v3"])(
    "blocks the full runtime %s in every import form",
    (specifier) => {
      for (const form of IMPORT_FORMS) {
        expect(form(specifier)).toMatch(ZOD_FULL_RUNTIME_GUARD);
      }
    }
  );

  it("does not flag a relative or unrelated specifier", () => {
    expect(`import { z } from "./zod";`).not.toMatch(ZOD_FULL_RUNTIME_GUARD);
    expect(`import { z } from "some-other-zod";`).not.toMatch(ZOD_FULL_RUNTIME_GUARD);
  });
});
