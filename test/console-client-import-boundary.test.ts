import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("console client import boundary", () => {
  it("brokers.tsx imports venue-contract-pure instead of venue-contract", () => {
    const source = readFileSync("app/console/settings/brokers.tsx", "utf8");
    expect(source).toContain('@/lib/venue-contract-pure');
    expect(source).not.toMatch(/@\/lib\/venue-contract["']/);
  });

  it("connections page only reaches brokers (no direct db imports)", () => {
    const source = readFileSync("app/console/connections/page.tsx", "utf8");
    expect(source).not.toMatch(/@\/lib\/db/);
    expect(source).not.toMatch(/@\/lib\/db-/);
  });

  it("results page imports tax-pure instead of tax (no db chain via performance)", () => {
    const source = readFileSync("app/console/results/page.tsx", "utf8");
    expect(source).toContain("@/lib/tax-pure");
    expect(source).not.toMatch(/@\/lib\/tax["']/);
  });
});
