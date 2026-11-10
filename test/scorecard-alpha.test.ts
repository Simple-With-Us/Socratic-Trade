import { describe, expect, it } from "vitest";
import { stampClosedLotAlpha, type ClosedLot } from "../src/lib/performance";

const lot = (partial: Partial<ClosedLot> & Pick<ClosedLot, "pnl" | "returnPct">): ClosedLot => ({
  ...partial
});

describe("stampClosedLotAlpha", () => {
  it("subtracts same-window benchmark return", () => {
    const stamped = stampClosedLotAlpha(
      [
        lot({
          pnl: 20,
          returnPct: 10,
          side: "long",
          entryAt: "2026-01-02T15:00:00.000Z",
          exitAt: "2026-01-10T15:00:00.000Z"
        })
      ],
      [
        { date: "2026-01-02", close: 100 },
        { date: "2026-01-10", close: 105 }
      ]
    );
    expect(stamped[0]?.alphaPct).toBe(5);
  });

  it("omits alpha when bars are missing", () => {
    const stamped = stampClosedLotAlpha([lot({ pnl: 1, returnPct: 3, entryAt: "2026-01-02T00:00:00.000Z" })], []);
    expect(stamped[0]?.alphaPct).toBeUndefined();
  });
});
