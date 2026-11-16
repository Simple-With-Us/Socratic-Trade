/** The dashboard snapshot's smartMoney.congress cap must keep the most-recently-
 *  DISCLOSED trades (disclosure = when the market could act), not the most-recently-
 *  traded ones — a freshly disclosed older trade must survive the slice. */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CongressTrade } from "../src/lib/web-sources";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-smart-money-${randomUUID()}.db`)}`;
});

function trade(symbol: string, tradedAt: string, disclosedAt?: string): CongressTrade {
  return { symbol, member: "Test Member", chamber: "senate", side: "buy", tradedAt, disclosedAt, source: "test" };
}

describe("sliceCongressByDisclosure (snapshot smartMoney.congress cap)", () => {
  it("orders by disclosure date (fallback tradedAt) so a freshly disclosed older trade survives the cap", async () => {
    const { sliceCongressByDisclosure } = await import("../src/lib/dashboard");
    const trades = [
      trade("OLD-TRADE-NEW-DISC", "2026-06-01", "2026-07-02"), // oldest trade, newest disclosure
      trade("MID", "2026-06-30", "2026-06-30"),
      trade("NEW-TRADE-OLD-DISC", "2026-07-01", "2026-06-29"), // newest trade, older disclosure
      trade("NO-DISCLOSURE", "2026-06-28") // falls back to tradedAt
    ];

    const sliced = sliceCongressByDisclosure(trades, 3);

    // Trade-date ordering would put NEW-TRADE-OLD-DISC first and drop OLD-TRADE-NEW-DISC.
    expect(sliced.map((t) => t.symbol)).toEqual(["OLD-TRADE-NEW-DISC", "MID", "NEW-TRADE-OLD-DISC"]);
  });

  it("caps at 12 rows by default and does not mutate the input", async () => {
    const { sliceCongressByDisclosure } = await import("../src/lib/dashboard");
    const trades = Array.from({ length: 17 }, (_, i) =>
      trade(`S${i}`, "2026-06-01", `2026-06-${String(i + 1).padStart(2, "0")}`)
    );
    const original = [...trades];

    const sliced = sliceCongressByDisclosure(trades);

    expect(sliced).toHaveLength(12);
    expect(sliced[0].symbol).toBe("S16"); // most recently disclosed first
    expect(trades).toEqual(original);
  });
});
