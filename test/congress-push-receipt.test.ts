import { describe, expect, it } from "vitest";
import {
  buildCongressPushBatchReceipt,
  buildCongressPushReceipt,
  resolveCongressEventId,
  resolveCongressEventIds,
} from "../src/lib/congress-push-receipt";

describe("congress push receipt", () => {
  it("includes receiptVersion and consumed on success", () => {
    const receipt = buildCongressPushReceipt({ ok: true, applied: 2, type: "congress.trade" }, "evt-1");
    expect(receipt).toMatchObject({
      receiptVersion: 1,
      delivered: true,
      consumed: true,
      ok: true,
      eventId: "evt-1",
      applied: 2,
    });
  });

  it("marks consumption failure when ok is false", () => {
    const receipt = buildCongressPushReceipt({ ok: false, applied: 0, reason: "invalid-event" });
    expect(receipt.consumed).toBe(false);
  });

  it("aggregates batch receipts and fails closed on any bad event", () => {
    const receipt = buildCongressPushBatchReceipt(
      [
        { ok: true, applied: 1, type: "congress.trade" },
        { ok: false, applied: 0, reason: "unknown-type" },
      ],
      ["a", "b"],
    );
    expect(receipt.consumed).toBe(false);
    expect(receipt.count).toBe(2);
    expect(receipt.results?.[1].eventId).toBe("b");
  });

  it("resolves event ids from batch bodies", () => {
    expect(resolveCongressEventId({ id: " solo " })).toBe("solo");
    expect(resolveCongressEventIds({ events: [{ id: "x" }, { id: "y" }] })).toEqual(["x", "y"]);
  });
});
