import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-recoverable-${randomUUID()}.db`)}`;
});

describe("recordRecoverableIssue", () => {
  it("records a visible audit event and throttles repeated fallback noise", async () => {
    const { recordRecoverableIssue } = await import("../src/lib/recoverable-issue");
    const { listAudit } = await import("../src/lib/db");

    recordRecoverableIssue({
      source: "broker",
      operation: "dashboard.getPortfolioBundle",
      message: "No Robinhood MCP access token is stored.",
      fallback: "Dashboard snapshot continues without live portfolio, positions, and orders.",
      userId: "user-a",
      connectedAccountId: "acct-1",
      broker: "robinhood",
      accountNumber: "713670347",
      throttleMs: 60_000
    });
    recordRecoverableIssue({
      source: "broker",
      operation: "dashboard.getPortfolioBundle",
      message: "No Robinhood MCP access token is stored.",
      fallback: "Dashboard snapshot continues without live portfolio, positions, and orders.",
      userId: "user-a",
      connectedAccountId: "acct-1",
      broker: "robinhood",
      accountNumber: "713670347",
      throttleMs: 60_000
    });

    const events = listAudit(10, "user-a").filter((event) => event.kind === "recoverable_issue");
    expect(events).toHaveLength(1);
    expect(events[0]?.connectedAccountId).toBe("acct-1");
    expect(events[0]?.payload).toMatchObject({
      source: "broker",
      operation: "dashboard.getPortfolioBundle",
      fallback: "Dashboard snapshot continues without live portfolio, positions, and orders.",
      broker: "robinhood",
      accountNumber: "713670347"
    });
  });
});
