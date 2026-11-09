import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-test-sim-${randomUUID()}.db`)}`;
  // (vitest already runs with NODE_ENV=test; the no-fills cases below never fetch quotes.)
});

describe("TestBrokerGateway — funded test broker", () => {
  it("returns starting cash as buyingPower, cash, and totalMarketValue when there are no fills", async () => {
    const { getTestGateway } = await import("../src/lib/robinhood");
    const gateway = getTestGateway("local");

    const portfolio = await gateway.getPortfolio("TEST");

    expect(portfolio.buyingPower).toBe(100_000);
    expect(portfolio.cash).toBe(100_000);
    expect(portfolio.totalMarketValue).toBe(100_000);
    expect(portfolio.equityMarketValue).toBe(0);
    expect(portfolio.optionMarketValue).toBe(0);
    expect(portfolio.accountNumber).toBe("TEST");
  });

  it("returns empty positions when there are no fills", async () => {
    const { getTestGateway } = await import("../src/lib/robinhood");
    const gateway = getTestGateway("local");

    const positions = await gateway.getEquityPositions("TEST");

    expect(positions).toEqual([]);
  });

  it("returns 'Test broker' as the account label", async () => {
    const { getTestGateway } = await import("../src/lib/robinhood");
    const gateway = getTestGateway("local");

    const accounts = await gateway.getAccounts();

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.label).toBe("Test broker");
    expect(accounts[0]?.accountNumber).toBe("TEST");
  });
});
