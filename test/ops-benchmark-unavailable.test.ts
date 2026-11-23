import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ops-benchmark-${randomUUID()}.db`)}`;
});
beforeAll(async () => {
  await import("../src/lib/ops-snapshot");
}, 120_000);

describe("ops snapshot: why the vs-S&P card is missing", () => {
  it("carries the benchmark_unavailable reason and detail so a remote read names the cause", async () => {
    const db = await import("../src/lib/db");
    const userId = `ops-bench-${randomUUID()}`;
    const accountId = `tradier-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "tradier",
      environment: "paper",
      accountNumber: "SBX-1",
      label: "Tradier Sandbox",
      isActive: true
    });
    db.audit("benchmark_unavailable", { benchmarkSymbol: "SPY", reason: "snapshot-timing-unknown", detail: "window cut" }, userId, accountId);
    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = await buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 10 });
    const row = snapshot.users.find((u) => u.userId === userId)?.recentAudit.find((a) => a.kind === "benchmark_unavailable");
    expect(row?.detail).toBe("snapshot-timing-unknown · window cut");
    expect(row?.accountLabel).toBe("Tradier Sandbox");
  });
});
