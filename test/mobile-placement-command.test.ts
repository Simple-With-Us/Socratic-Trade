import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  purgePrivateVectorRecordsForUser: vi.fn(async () => ({ ids: [], contentHashes: [], deleted: 0 }))
}));

const executeProposalMock = vi.fn();

vi.mock("../src/lib/strategy-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/strategy-execution")>();
  return {
    ...actual,
    executeProposal: (...args: unknown[]) => executeProposalMock(...args)
  };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mobile-placement-${randomUUID()}.db`)}`;
});

describe("mobile proposal.approve placement command status", () => {
  it("marks only placed outcomes as succeeded and preserves placement status in result", async () => {
    const { processPendingMobileCommands, queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");
    const userId = `mobile-placement-${randomUUID()}`;

    executeProposalMock.mockResolvedValueOnce({
      status: "placed",
      orderId: "order-1",
      brokerState: "accepted"
    });
    queueMobileCommand({
      userId,
      commandType: "proposal.approve",
      payload: { proposalId: "proposal-placed" }
    });
    await processPendingMobileCommands({ limit: 1 });
    const placedDone = listMobileCommands({ userId }).find((c) => c.payload.proposalId === "proposal-placed");
    expect(placedDone?.status).toBe("succeeded");
    expect(placedDone?.result).toMatchObject({ status: "placed", outcome: "placed", orderId: "order-1" });
    expect(placedDone?.error).toBeUndefined();

    executeProposalMock.mockResolvedValueOnce({
      status: "busy",
      reasons: ["A strategy run is in progress; try again in a moment."]
    });
    queueMobileCommand({
      userId,
      commandType: "proposal.approve",
      payload: { proposalId: "proposal-busy" }
    });
    await processPendingMobileCommands({ limit: 1 });
    const busyDone = listMobileCommands({ userId }).find((c) => c.payload.proposalId === "proposal-busy");
    expect(busyDone?.status).toBe("failed");
    expect(busyDone?.result).toMatchObject({ status: "busy", outcome: "busy" });
    expect(busyDone?.error).toMatch(/strategy run is in progress/i);

    executeProposalMock.mockResolvedValueOnce({
      status: "not_placed",
      reasons: ["Broker rate-limited or timed out (HTTP 429). Safe to retry."]
    });
    queueMobileCommand({
      userId,
      commandType: "proposal.approve",
      payload: { proposalId: "proposal-retry" }
    });
    await processPendingMobileCommands({ limit: 1 });
    const retryDone = listMobileCommands({ userId }).find((c) => c.payload.proposalId === "proposal-retry");
    expect(retryDone?.status).toBe("failed");
    expect(retryDone?.result).toMatchObject({ status: "not_placed", outcome: "retryable" });
    expect(retryDone?.error).toMatch(/safe to retry/i);
  });
});
