import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let getAccountCalls = 0;
let getAccountDelayMs = 0;

vi.mock("@alpacahq/alpaca-trade-api", () => {
  class MockAlpaca {
      async getAccount() {
        getAccountCalls += 1;
        if (getAccountDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, getAccountDelayMs));
        }
        return {
          account_number: "294709855",
          portfolio_value: "10000",
          buying_power: "5000",
          equity: "8000",
          cash: "2000",
          shorting_enabled: false,
          account_type: "ira",
          account_sub_type: "roth"
        };
      }
      async getPositions() {
        return [];
      }
      async getOrders() {
        return [];
      }
  }
  return { Alpaca: MockAlpaca, default: MockAlpaca };
});

beforeEach(async () => {
  getAccountCalls = 0;
  getAccountDelayMs = 0;
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alpaca-acct-${randomUUID()}.db`)}`;

  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "roth-ira",
    userId: "local",
    broker: "alpaca",
    environment: "live",
    apiKey: "PK_ROTH",
    apiSecret: "secret",
    accountNumber: "294709855",
    isActive: true,
    label: "Roth IRA"
  });
  upsertConnectedAccount({
    id: "paper-acct",
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    apiKey: "PK_PAPER",
    apiSecret: "secret",
    accountNumber: "PA33IDTHMFK9",
    isActive: false,
    label: "Alpaca Paper"
  });
});

describe("Alpaca getAccount coalescing", () => {
  it("collapses parallel getAccounts + getPortfolio into one REST getAccount", async () => {
    getAccountDelayMs = 25;
    const { getAlpacaGateway, resetAlpacaAccountCacheForTests } = await import("../src/lib/alpaca");
    resetAlpacaAccountCacheForTests();
    const gateway = getAlpacaGateway("local", "roth-ira");
    const [accounts, portfolio] = await Promise.all([
      gateway.getAccounts(),
      gateway.getPortfolio("294709855")
    ]);
    expect(getAccountCalls).toBe(1);
    expect(accounts[0]?.accountNumber).toBe("294709855");
    expect(portfolio.accountNumber).toBe("294709855");
  });

  it("reuses the short TTL so a second dashboard-shaped read does not hit Alpaca again", async () => {
    const { getAlpacaGateway, resetAlpacaAccountCacheForTests } = await import("../src/lib/alpaca");
    resetAlpacaAccountCacheForTests();
    const gateway = getAlpacaGateway("local", "roth-ira");
    await gateway.getAccounts();
    await gateway.getPortfolio("294709855");
    expect(getAccountCalls).toBe(1);
  });

  it("does not share the cache across distinct connected accounts", async () => {
    const { getAlpacaGateway, resetAlpacaAccountCacheForTests } = await import("../src/lib/alpaca");
    resetAlpacaAccountCacheForTests();
    await getAlpacaGateway("local", "roth-ira").getAccounts();
    await getAlpacaGateway("local", "paper-acct").getAccounts();
    expect(getAccountCalls).toBe(2);
  });
});

describe("Alpaca credential and venue validation", () => {
  it("honors only the environment-matched REST host and ignores a mismatched one", async () => {
    const { resolveAlpacaRestBaseUrl } = await import("../src/lib/alpaca");
    expect(
      resolveAlpacaRestBaseUrl({ environment: "paper", storedBaseUrl: "https://paper-api.alpaca.markets/v2" })
    ).toBe("https://paper-api.alpaca.markets");
    expect(
      resolveAlpacaRestBaseUrl({ environment: "paper", storedBaseUrl: "https://api.alpaca.markets/v2" })
    ).toBeUndefined();
    expect(
      resolveAlpacaRestBaseUrl({ environment: "live", storedBaseUrl: "https://paper-api.alpaca.markets" })
    ).toBeUndefined();
    expect(resolveAlpacaRestBaseUrl({ environment: "paper", storedBaseUrl: "not a url" })).toBeUndefined();
  });

  it("rejects a REST key ID with no secret instead of sending it as OAuth", async () => {
    const { upsertConnectedAccount } = await import("../src/lib/db");
    upsertConnectedAccount({
      id: "nosecret-acct",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      apiKey: "PK_NOSECRET",
      accountNumber: "PA_NOSECRET",
      isActive: false,
      label: "Paper No Secret"
    });
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    expect(() => getAlpacaGateway("local", "nosecret-acct")).toThrow(/API secret is missing/);
  });

  it("fingerprints credentials for caches without exposing the secret", async () => {
    const { alpacaCredentialFingerprint } = await import("../src/lib/alpaca");
    const a = alpacaCredentialFingerprint("PK_ONE", "secret-one");
    const b = alpacaCredentialFingerprint("PK_ONE", "secret-two");
    expect(a).not.toBe(b);
    expect(a).not.toContain("secret");
  });
});
