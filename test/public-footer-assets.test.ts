import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const footer = readFileSync(join(root, "app/ui/public/public-footer.tsx"), "utf8");

describe("public footer assets", () => {
  it("only references bundled logo assets", () => {
    const sources = [...footer.matchAll(/src="(\/[^\"]+)"/g)].map((match) => match[1]);
    expect(sources).toEqual(["/swu-wordmark-light.webp", "/swu-wordmark-dark.webp"]);
    for (const src of sources) expect(existsSync(join(root, "public", src))).toBe(true);
  });

  it("keeps the attribution transparent, bounded, and theme-aware", () => {
    expect(footer).not.toContain("bg-white");
    expect(footer).toContain("dark:hidden");
    expect(footer).toContain("dark:block");
    expect(footer.match(/width=\{288\}/g)).toHaveLength(2);
    expect(footer.match(/height=\{30\}/g)).toHaveLength(2);
    expect(footer.match(/w-72 max-w-\[calc\(100vw-92px\)\]/g)).toHaveLength(2);
  });
});
