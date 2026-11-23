import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;
afterAll(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});
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
    db.audit("benchmark_timing_unknown", { benchmarkSymbol: "SPY", reason: "snapshot-timing-unknown", detail: "window cut" }, userId, accountId);
    db.audit("benchmark_unavailable", { benchmarkSymbol: "SPY", reason: "fetch-failed", detail: "boom" }, userId, accountId);
    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = await buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 10 });
    const rows = snapshot.users.find((u) => u.userId === userId)?.recentAudit ?? [];
    expect(rows.find((a) => a.kind === "benchmark_timing_unknown")?.detail).toBe("snapshot-timing-unknown · window cut");
    expect(rows.find((a) => a.kind === "benchmark_unavailable")?.detail).toBe("fetch-failed · boom");
    expect(rows.find((a) => a.kind === "benchmark_unavailable")?.accountLabel).toBe("Tradier Sandbox");
  });
});
