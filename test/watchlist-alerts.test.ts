import { beforeAll, describe, expect, it } from "vitest";
import { createAlert, listAlerts, normalizeAlertOp, removeAlert } from "../src/lib/alerts";
import { getDb } from "../src/lib/db";
import { addToWatchlist, listWatchlist, removeFromWatchlist } from "../src/lib/watchlist";

describe("watchlist", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/watchlist-alerts-test-${Date.now()}.db`;
    getDb();
  });

  it("adds, dedupes, lists, and removes symbols", () => {
    const userId = "watchlist-user";
    const first = addToWatchlist(userId, "nvda");
    expect(first.symbol).toBe("NVDA");
    expect(first.deduped).toBe(false);

    const second = addToWatchlist(userId, "NVDA");
    expect(second.deduped).toBe(true);
    expect(listWatchlist(userId).map((item) => item.symbol)).toEqual(["NVDA"]);

    expect(removeFromWatchlist(userId, "NVDA")).toBe(true);
    expect(listWatchlist(userId)).toEqual([]);
  });
});

describe("price alerts", () => {
  it("normalizes comparison operators", () => {
    expect(normalizeAlertOp("below")).toBe("<");
    expect(normalizeAlertOp("OVER")).toBe(">");
    expect(normalizeAlertOp("maybe")).toBeNull();
  });

  it("creates, lists, and deletes alerts", () => {
    const userId = "alerts-user";
    const created = createAlert(userId, { symbol: "AAPL", op: "<", price: 150, note: "buy zone" });
    expect("error" in created).toBe(false);
    if ("error" in created) return;

    const alerts = listAlerts(userId, "armed");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.symbol).toBe("AAPL");
    expect(alerts[0]?.note).toBe("buy zone");

    expect(removeAlert(userId, created.id)).toBe(true);
    expect(listAlerts(userId, "armed")).toEqual([]);
  });

  it("rejects invalid alert input", () => {
    const invalid = createAlert("alerts-user", { symbol: "", op: "nope", price: -1 });
    expect(invalid).toEqual({ error: "INVALID_SYMBOL" });
  });
});
