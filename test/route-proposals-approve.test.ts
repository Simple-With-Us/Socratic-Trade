import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, it, expect, vi, beforeEach } from "vitest";
import { resetDbForTesting, setPolicy } from "../src/lib/db";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { POST } from "../app/api/proposals/[id]/approve/route";

beforeAll(() => {
  // Per-run temp DB (canonical repo pattern): keeps this test off the production
  // ./data/app.db and matches every other test that exercises setPolicy.
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-route-proposals-approve-${randomUUID()}.db`)}`;
  resetDbForTesting();
});

const executeProposal = vi.fn();

vi.mock("../src/lib/strategy-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/strategy-execution")>();
  return {
    ...actual,
    executeProposal: (...args: unknown[]) => executeProposal(...args)
  };
});

describe("POST /api/proposals/[id]/approve", () => {
  beforeEach(() => {
    resetDbForTesting();
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TEST_ACCOUNT", systemState: "active" }, "local");
    executeProposal.mockReset();
    executeProposal.mockResolvedValue({ status: "placed", orderId: "ord-1" });
  });

  it("should block if system is stopped", async () => {
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TEST_ACCOUNT", systemState: "halted" }, "local");

    const req = new Request("http://localhost/api/proposals/123/approve", {
      method: "POST",
      body: JSON.stringify({})
    });
    const res = await POST(req, { params: Promise.resolve({ id: "123" }) });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toBe("system_stopped");
  });

  it("should execute proposal", async () => {
    const req = new Request("http://localhost/api/proposals/123/approve", {
      method: "POST",
      body: JSON.stringify({})
    });
    const res = await POST(req, { params: Promise.resolve({ id: "123" }) });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status?: string; outcome?: string; orderId?: string };
    expect(data.status).toBe("placed");
    expect(data.outcome).toBe("placed");
    expect(data.orderId).toBe("ord-1");
  });

  it("does not report success when the order was not placed", async () => {
    executeProposal.mockResolvedValue({
      status: "not_placed",
      reasons: ["Broker reachable; no order carries our idempotency key. Safe to retry."]
    });
    const req = new Request("http://localhost/api/proposals/123/approve", {
      method: "POST",
      body: JSON.stringify({})
    });
    const res = await POST(req, { params: Promise.resolve({ id: "123" }) });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { status?: string; outcome?: string };
    expect(data.status).toBe("not_placed");
    expect(data.outcome).toBe("retryable");
  });

  it("keeps a retryable broker error off the success status", async () => {
    executeProposal.mockResolvedValue({
      status: "error",
      reasons: ["Alpaca order failed: HTTP 503 Service Unavailable"]
    });
    const req = new Request("http://localhost/api/proposals/123/approve", {
      method: "POST",
      body: JSON.stringify({})
    });
    const res = await POST(req, { params: Promise.resolve({ id: "123" }) });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { outcome?: string };
    expect(data.outcome).toBe("retryable");
  });

  it("keeps a terminal broker rejection off the success status", async () => {
    executeProposal.mockResolvedValue({
      status: "error",
      reasons: ["Broker declined the order (state: rejected)."]
    });
    const req = new Request("http://localhost/api/proposals/123/approve", {
      method: "POST",
      body: JSON.stringify({})
    });
    const res = await POST(req, { params: Promise.resolve({ id: "123" }) });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { outcome?: string };
    expect(data.outcome).toBe("rejected");
  });
});
