import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("vitest console intercept", () => {
  it("disables intercept so worker teardown cannot race onUserConsoleLog RPC", () => {
    const src = readFileSync(resolve(process.cwd(), "vitest.config.ts"), "utf8");
    expect(src).toMatch(/^\s*disableConsoleIntercept:\s*true/m);
    expect(src).not.toMatch(/^\s*onConsoleLog:/m);
  });
});
