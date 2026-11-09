import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-clear-nulls-${randomUUID()}.db`)}`;
});

describe("stripNullsDeep (clearing an optional policy field)", () => {
  it("deletes null keys at the top level and inside nested objects, leaving real values + arrays intact", async () => {
    const { stripNullsDeep } = await import("../src/lib/policy-null-stripping");
    const obj: Record<string, unknown> = {
      maxGrossExposurePct: null, // cleared → should vanish
      maxNetExposurePct: 80, // kept
      riskRules: { maxDrawdownPct: null, takeProfitTrimPct: 50, trailingStopPct: null }, // mixed
      universeFloor: { minPrice: null, minMarketCapUsd: 100_000_000 }, // minPrice cleared
      permittedOrderTypes: ["market", "limit"], // array untouched
      systemState: "halted"
    };
    stripNullsDeep(obj);
    expect(obj).toEqual({
      maxNetExposurePct: 80,
      riskRules: { takeProfitTrimPct: 50 },
      universeFloor: { minMarketCapUsd: 100_000_000 },
      permittedOrderTypes: ["market", "limit"],
      systemState: "halted"
    });
    expect("maxGrossExposurePct" in obj).toBe(false);
    expect("maxDrawdownPct" in (obj.riskRules as object)).toBe(false);
    expect("minPrice" in (obj.universeFloor as object)).toBe(false);
  });
});
