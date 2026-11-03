// tickInner must yield the event loop between its synchronous phases so a
// pinned sweep cannot starve /api/live for the whole tick (SOCRATIC-TRADE-2Q
// stall class). Source-level guard, matching liveness-watchdog-config.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "..", "src", "lib", "scheduler.ts"), "utf8");
const tickInner = src.slice(src.indexOf("async function tickInner"), src.indexOf("async function tick()"));

describe("scheduler tickInner phase yields", () => {
  it("yields between tick phases via yieldIfDue", () => {
    const yields = tickInner.match(/await yieldIfDue\(tickYield\)/g) ?? [];
    expect(yields.length).toBeGreaterThanOrEqual(4);
    expect(tickInner).toContain("const tickYield = { ms: Date.now() }");
    expect(src).toContain("yieldIfDue } from \"./sqlite-event-loop\"");
  });

  it("yields after each stale sweep and before the material-event drain", () => {
    expect(tickInner.indexOf("stale-run sweep error")).toBeLessThan(tickInner.indexOf("await yieldIfDue(tickYield)"));
    expect(tickInner.indexOf("await yieldIfDue(tickYield)", tickInner.indexOf("material-event-drain") - 500)).toBeGreaterThan(-1);
  });
});
