/**
 * app/console/settings/lib.ts deleteApiKey: the DELETE /api/keys body is strictly validated at the
 * client trust boundary (ST-4580) with the strict, tree-shakable ApiKeyDeleteResponseSchema from
 * zod/mini, and no module in app/console/settings (including the "use client" page.tsx and
 * api-keys.tsx that import ./lib) imports the full zod runtime, so the Settings modules add only the
 * zod/mini runtime to the client bundle, a malformed body never reaches the Remove flow as a
 * success, and runRemoveKey always reloads the list.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
 * imported statically, dynamically, or re-exported, with any string-literal quote (" ' or `).
 * Run it on stripTypeOnlyImports(source): a type-only import is erased at compile time and adds
 * nothing to the bundle, so it must not trip the guard.
 */
const ZOD_FULL_RUNTIME_GUARD =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'`])zod(?!(?:\/mini|\/v4\/mini|\/v4-mini)\1)(?:\/[^"'`]*)?\1/;

/** Removes `import type ... from "x"` and `export type ... from "x"` statements, which TypeScript
 *  erases entirely.  Inline `import { type X }` is left alone on purpose: under
 *  verbatimModuleSyntax it still emits `import {} from "x"`, which loads the module. */
function stripTypeOnlyImports(source: string): string {
  return source.replace(/\b(?:import|export)\s+type\s+[^;]*?\bfrom\s*(["'`])[^"'`]*\1\s*;?/g, "");
}

const SETTINGS_DIR = "app/console/settings";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];

/** Every source module in the Settings directory: page.tsx and api-keys.tsx are "use client" and
 *  import ./lib, and the sibling panels ship in the same client bundle, so the guard covers the
 *  whole directory rather than lib.ts alone.  Shared modules outside it (../lib, @/lib) are owned
 *  and guarded elsewhere. */
function settingsClientSurface(): string[] {
  return readdirSync(SETTINGS_DIR)
    .filter((name) => SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)))
    .map((name) => join(SETTINGS_DIR, name))
    .sort();
}

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
  });

  it("keeps the full zod runtime out of every Settings module, not just lib.ts", () => {
    const surface = settingsClientSurface();
    expect(surface).toEqual(
      expect.arrayContaining([`${SETTINGS_DIR}/page.tsx`, `${SETTINGS_DIR}/api-keys.tsx`, `${SETTINGS_DIR}/lib.ts`])
    );
    const offenders = surface.filter((file) => ZOD_FULL_RUNTIME_GUARD.test(stripTypeOnlyImports(readFileSync(file, "utf8"))));
    expect(offenders).toEqual([]);
  });

  it.each([
    ['import { z } from "zod";', true],
    ["import { z } from 'zod/v4';", true],
    ["import { z } from `zod`;", true],
    ["import * as z from `zod/v4/classic`;", true],
    ['const z = await import("zod/v4/core");', true],
    ['export { z } from "zod";', true],
    ['import "zod";', true],
    ['import * as z from "zod/mini";', false],
    ["import * as z from `zod/v4-mini`;", false],
    ['import type { ZodType } from "zod";', false],
    ['export type { ZodType } from "zod/v4";', false],
    ['import type {\n  ZodType,\n  ZodObject\n} from "zod";', false]
  ])("guard on %j -> %s", (source, flagged) => {
    expect(ZOD_FULL_RUNTIME_GUARD.test(stripTypeOnlyImports(source))).toBe(flagged);
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
