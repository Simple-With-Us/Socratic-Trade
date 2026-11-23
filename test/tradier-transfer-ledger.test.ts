import { describe, expect, it } from "vitest";
import { tradierHistoryToActivities } from "../src/lib/tradier-transfer-ledger";
import { resolveExternalCashFlows, isBrokerTransferActivity } from "../src/lib/broker-cash-flows";

describe("Tradier transfer ledger", () => {
  it("maps only external-capital events, signed, and drops trades, dividends and zero amounts", () => {
    const rows = tradierHistoryToActivities([
      { type: "ach", date: "2026-11-02T00:00:00Z", amount: 5000, ach: {} },
      { type: "wire", date: "2026-11-05T00:00:00Z", amount: -1200.5 },
      { type: "trade", date: "2026-11-06T00:00:00Z", amount: -300 },
      { type: "dividend", date: "2026-11-07T00:00:00Z", amount: 12 },
      { type: "journal", date: "2026-11-08T00:00:00Z", amount: 0 },
      { type: "ach", date: "2026-11-02T00:00:00Z", amount: 5000 }
    ]);
    expect(rows.map((r) => [r.activity_type, r.net_amount, r.date])).toEqual([
      ["CSD", "5000", "2026-11-02"],
      ["CSW", "-1200.5", "2026-11-05"],
      ["CSD", "5000", "2026-11-02"]
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    expect(rows.every(isBrokerTransferActivity)).toBe(true);
  });

  it("a complete ledger with no transfers is an authoritative broker source; an incomplete one is not", () => {
    const curve = [
      { timestamp: "2026-11-02T20:00:00Z", equity: 100000 },
      { timestamp: "2026-11-03T20:00:00Z", equity: 100500 }
    ] as never;
    const complete = resolveExternalCashFlows({ equityCurve: curve, brokerActivities: [], brokerLedgerComplete: true });
    expect(complete.source).toBe("broker");
    expect(complete.flows.size).toBe(0);
    const unknown = resolveExternalCashFlows({ equityCurve: curve, brokerActivities: [] });
    expect(unknown.source).toBe("inferred");
  });

  it("transfers from the ledger become per-day flows", () => {
    const acts = tradierHistoryToActivities([{ type: "ach", date: "2026-11-02T00:00:00Z", amount: 250 }]);
    const out = resolveExternalCashFlows({ equityCurve: [], brokerActivities: acts, brokerLedgerComplete: true });
    expect(out.source).toBe("broker");
    expect(out.flows.get("2026-11-02")).toBe(250);
  });
});
