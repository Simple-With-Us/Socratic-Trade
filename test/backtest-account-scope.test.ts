import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  listSignalSnapshotAuditAfter: vi.fn()
}));

vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return { ...actual, listSignalSnapshotAuditAfter: dbMocks.listSignalSnapshotAuditAfter };
});

import { runWalkForwardOOS } from "../src/lib/backtest";

beforeEach(() => {
  dbMocks.listSignalSnapshotAuditAfter.mockReset().mockReturnValue([]);
});

describe("walk-forward account scoping", () => {
  it("forwards the connected account id into signal-snapshot observation loading", async () => {
    await expect(runWalkForwardOOS("user-a", {
      connectedAccountId: "account-a",
      fetchOHLC: async () => null
    })).resolves.toBeNull();

    // OD-3 (ST-4680): DEFAULT_AUDIT_LIMIT raised 500 → 5000.
    expect(dbMocks.listSignalSnapshotAuditAfter).toHaveBeenCalledWith(
      "user-a",
      undefined,
      5000,
      "account-a"
    );
  });
});

describe("OD-3 (ST-4680) walk-forward defaults", () => {
  // Ten consecutive trading days (Jun 1-5, 8-12 2026), two names each, flat closes so every
  // forward return resolves to 0. trainFraction 0.7 → cutIdx 7; horizonDays 2 → the purge drops
  // the last 2 train buckets and the embargo drops the first 2 test buckets (1 test date survives).
  const dates = [
    "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05",
    "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12"
  ];
  const rows = dates.map((date, i) => ({
    rowid: i + 1,
    id: `snap-${date}`,
    createdAt: `${date}T15:00:00Z`,
    payload: {
      runId: `run-${date}`,
      asOf: `${date}T15:00:00Z`,
      signals: ["A", "B"].map((symbol) => ({ symbol, refPrice: 100, factorBreakdown: { momentum: 50 } }))
    }
  }));
  // Flat daily closes covering every entry AND every horizon-2 exit (last exit = 2026-06-16).
  const bars: Array<{ time: string; close: number }> = [];
  for (let d = Date.UTC(2026, 4, 29); d <= Date.UTC(2026, 5, 30); d += 86_400_000) {
    bars.push({ time: new Date(d).toISOString().slice(0, 10), close: 100 });
  }
  const fetchOHLC = async () => bars;
  const now = Date.parse("2026-07-01T00:00:00Z");

  it("purgeEmbargo defaults ON: the train side is purged at the boundary", async () => {
    dbMocks.listSignalSnapshotAuditAfter.mockReturnValue(rows);
    const result = await runWalkForwardOOS("user-purge", { horizonDays: 2, now, fetchOHLC });
    expect(result).not.toBeNull();
    expect(result!.window.purgedTrainDates).toBe(2);
    expect(result!.window.embargoDates).toBe(2);
    expect(result!.trainDates).toBe(5);
    expect(result!.testDates).toBe(1);
  });

  it("explicit purgeEmbargo=false restores the legacy embargo-only split", async () => {
    dbMocks.listSignalSnapshotAuditAfter.mockReturnValue(rows);
    const result = await runWalkForwardOOS("user-purge-off", { horizonDays: 2, now, fetchOHLC, purgeEmbargo: false });
    expect(result).not.toBeNull();
    expect(result!.window.purgedTrainDates).toBe(0);
    expect(result!.window.embargoDates).toBe(2);
    expect(result!.trainDates).toBe(7);
    expect(result!.testDates).toBe(1);
  });
});
