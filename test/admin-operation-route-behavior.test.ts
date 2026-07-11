import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ADMIN_OPERATION_LIMITS, resetAdminOperationInFlight } from "../src/lib/admin-operation-guard";
import { rateLimit, resetRateLimiter } from "../src/lib/rate-limit";
import { AUTHENTICATED_EMAIL_HEADER, resolveRequestUserFromEmail } from "../src/lib/request-user";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listIngestedAccessions: vi.fn(),
  refreshFilingBodies: vi.fn(),
  getVectorStoreStats: vi.fn(),
  getEightKDataset: vi.fn(),
  reindexEightKDataset: vi.fn(),
  refreshEightK: vi.fn(),
  getCongressDataset: vi.fn(),
  refreshCongress: vi.fn(),
  congressTradeToken: vi.fn(),
  isCongressShareAutoEnabled: vi.fn(),
  runCongressDailyShare: vi.fn(),
  robinhoodMcpDataEnabled: vi.fn(),
  callRobinhoodMcpTool: vi.fn()
}));

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/db")>(),
  listIngestedAccessions: mocks.listIngestedAccessions
}));
vi.mock("@/lib/web-sources/sec-filings", () => ({ refreshFilingBodies: mocks.refreshFilingBodies }));
vi.mock("@/lib/vector-db", () => ({ getVectorStoreStats: mocks.getVectorStoreStats }));
vi.mock("@/lib/web-sources/sec8k", () => ({
  getEightKDataset: mocks.getEightKDataset,
  reindexEightKDataset: mocks.reindexEightKDataset,
  refreshEightK: mocks.refreshEightK
}));
vi.mock("@/lib/web-sources/congress", () => ({
  getCongressDataset: mocks.getCongressDataset,
  refreshCongress: mocks.refreshCongress
}));
vi.mock("@/lib/congress-share", () => ({
  congressTradeToken: mocks.congressTradeToken,
  isCongressShareAutoEnabled: mocks.isCongressShareAutoEnabled,
  runCongressDailyShare: mocks.runCongressDailyShare
}));
vi.mock("@/lib/robinhood", () => ({
  robinhoodMcpDataEnabled: mocks.robinhoodMcpDataEnabled,
  callRobinhoodMcpTool: mocks.callRobinhoodMcpTool
}));

import { POST as reindexTenK } from "../app/api/admin/reindex-10k/route";
import { POST as reindexEightK } from "../app/api/admin/reindex-8k/route";
import { POST as shareCongress } from "../app/api/admin/congress-share/route";
import { POST as refreshWebSource } from "../app/api/admin/refresh-websource/route";
import { GET as probeRobinhood } from "../app/api/admin/robinhood-probe/route";

const EMAIL = "route-budget@example.com";
const USER_ID = resolveRequestUserFromEmail(EMAIL).userId;

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-admin-route-behavior-${randomUUID()}.db`)}`;
});

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://socratictrade.com${path}`, {
    ...init,
    headers: {
      [AUTHENTICATED_EMAIL_HEADER]: EMAIL,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
}

function nextRequest(path: string): NextRequest {
  return new NextRequest(`https://socratictrade.com${path}`, {
    headers: { [AUTHENTICATED_EMAIL_HEADER]: EMAIL }
  });
}

function expectFullBudget(operation: keyof typeof ADMIN_OPERATION_LIMITS): void {
  const config = ADMIN_OPERATION_LIMITS[operation];
  for (let i = 0; i < config.limit; i += 1) {
    expect(rateLimit(`${USER_ID}:admin:${operation}`, config).allowed).toBe(true);
  }
  expect(rateLimit(`${USER_ID}:admin:${operation}`, config).allowed).toBe(false);
}

beforeEach(() => {
  resetRateLimiter();
  resetAdminOperationInFlight();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireAdmin.mockReturnValue(null);
  mocks.getVectorStoreStats.mockResolvedValue({});
  mocks.getEightKDataset.mockReturnValue(null);
  mocks.reindexEightKDataset.mockResolvedValue({ indexed: 1 });
  mocks.refreshEightK.mockResolvedValue({ ok: true });
  mocks.getCongressDataset.mockReturnValue(null);
  mocks.refreshCongress.mockResolvedValue({ ok: true });
  mocks.refreshFilingBodies.mockResolvedValue({ errors: [] });
  mocks.congressTradeToken.mockReturnValue("configured");
  mocks.isCongressShareAutoEnabled.mockReturnValue(false);
  mocks.runCongressDailyShare.mockResolvedValue({ ok: true });
  mocks.robinhoodMcpDataEnabled.mockReturnValue(true);
  mocks.callRobinhoodMcpTool.mockResolvedValue({ ok: true });
});

afterEach(() => {
  resetRateLimiter();
  resetAdminOperationInFlight();
});

describe("expensive admin route admission behavior", () => {
  it("authorizes before parsing or admitting an invalid request", async () => {
    mocks.requireAdmin.mockReturnValueOnce(new Response("forbidden", { status: 403 }));
    const response = await reindexTenK(request("/api/admin/reindex-10k", {
      method: "POST",
      body: "not-json"
    }));

    expect(response.status).toBe(403);
    expect(mocks.refreshFilingBodies).not.toHaveBeenCalled();
    expectFullBudget("reindex-10k");
  });

  it("does not debit quota for an empty 10-K request", async () => {
    const response = await reindexTenK(request("/api/admin/reindex-10k", {
      method: "POST",
      body: JSON.stringify({ symbols: [] })
    }));

    expect(response.status).toBe(400);
    expect(mocks.refreshFilingBodies).not.toHaveBeenCalled();
    expectFullBudget("reindex-10k");
  });

  it("does not debit quota when Congress sharing is not configured", async () => {
    mocks.congressTradeToken.mockReturnValue("");
    const response = await shareCongress(request("/api/admin/congress-share", {
      method: "POST",
      body: "{}"
    }));

    expect(response.status).toBe(400);
    expect(mocks.runCongressDailyShare).not.toHaveBeenCalled();
    expectFullBudget("congress-share");
  });

  it("does not debit quota for an unknown web-source id", async () => {
    const response = await refreshWebSource(request("/api/admin/refresh-websource", {
      method: "POST",
      body: JSON.stringify({ id: "unknown" })
    }));

    expect(response.status).toBe(400);
    expect(mocks.refreshCongress).not.toHaveBeenCalled();
    expect(mocks.refreshEightK).not.toHaveBeenCalled();
    expectFullBudget("refresh-websource");
  });

  it("does not debit quota when the Robinhood MCP adapter is disabled", async () => {
    mocks.robinhoodMcpDataEnabled.mockReturnValue(false);
    const response = await probeRobinhood(nextRequest("/api/admin/robinhood-probe?symbol=AAPL"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(mocks.callRobinhoodMcpTool).not.toHaveBeenCalled();
    expectFullBudget("robinhood-probe");
  });

  it("suppresses provider work when a valid request is over budget", async () => {
    expectFullBudget("reindex-10k");
    const response = await reindexTenK(request("/api/admin/reindex-10k", {
      method: "POST",
      body: JSON.stringify({ symbols: ["AAPL"] })
    }));

    expect(response.status).toBe(429);
    expect(mocks.refreshFilingBodies).not.toHaveBeenCalled();
  });

  it("suppresses the conflicting paid reindex at the invoked route boundary", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.reindexEightKDataset.mockImplementationOnce(async () => {
      await held;
      return { indexed: 1 };
    });

    const first = reindexEightK(request("/api/admin/reindex-8k", {
      method: "POST",
      body: JSON.stringify({ limit: 1 })
    }));
    await vi.waitFor(() => expect(mocks.reindexEightKDataset).toHaveBeenCalledOnce());

    const blocked = await reindexTenK(request("/api/admin/reindex-10k", {
      method: "POST",
      body: JSON.stringify({ symbols: ["AAPL"] })
    }));
    expect(blocked.status).toBe(409);
    expect(mocks.refreshFilingBodies).not.toHaveBeenCalled();

    release();
    expect((await first).status).toBe(200);
  });
});
