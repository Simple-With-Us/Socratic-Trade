import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-r5-${randomUUID()}.db`)}`;
});

describe("trade_locks persistence", () => {
  it("upserts, covers, and expires", async () => {
    const { upsertTradeLock, getActiveTradeLocks, pruneExpiredTradeLocks } = await import("../src/lib/db-trade-locks");
    const now = "2026-08-14T12:00:00.000Z";
    upsertTradeLock({
      userId: "u",
      connectedAccountId: "acct",
      scope: "symbol",
      symbol: "AAPL",
      side: "*",
      trigger: "symbol_cooldown",
      reason: "cooldown",
      until: "2026-08-14T13:00:00.000Z",
      now
    });
    expect(getActiveTradeLocks("u", "acct", now)).toHaveLength(1);
    expect(pruneExpiredTradeLocks("2026-08-14T13:00:00.000Z")).toBe(1);
    expect(getActiveTradeLocks("u", "acct", "2026-08-14T13:00:01.000Z")).toHaveLength(0);
  });
});

describe("strategy_overlays persistence", () => {
  it("round-trips CRUD", async () => {
    const { createStrategyOverlay, listStrategyOverlays, deleteStrategyOverlay } = await import("../src/lib/db-overlays");
    const row = createStrategyOverlay({
      userId: "u",
      name: "Risk-on tilt",
      marketRegimes: ["risk-on"],
      instructions: "favor quality growth",
      priority: 1
    });
    expect(listStrategyOverlays("u").map((item) => item.id)).toEqual([row.id]);
    expect(deleteStrategyOverlay("u", row.id)).toBe(true);
    expect(listStrategyOverlays("u")).toEqual([]);
  });

  it("seeds starter templates once by name", async () => {
    const { seedStrategyOverlayTemplates, listStrategyOverlays } = await import("../src/lib/db-overlays");
    const first = seedStrategyOverlayTemplates("u");
    const second = seedStrategyOverlayTemplates("u");
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual([]);
    expect(listStrategyOverlays("u").every((row) => row.enabled === false)).toBe(true);
  });
});
