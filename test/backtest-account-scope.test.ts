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

    expect(dbMocks.listSignalSnapshotAuditAfter).toHaveBeenCalledWith(
      "user-a",
      undefined,
      500,
      "account-a"
    );
  });
});
