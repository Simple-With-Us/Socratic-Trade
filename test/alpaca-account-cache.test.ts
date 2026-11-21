import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let getAccountCalls = 0;
let getAccountDelayMs = 0;
let repeatAccount: Record<string, unknown> | undefined;

vi.mock("@alpacahq/alpaca-trade-api", () => {
  class MockAlpaca {
      async getAccount() {
        getAccountCalls += 1;
        if (getAccountDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, getAccountDelayMs));
        }
        if (repeatAccount) return repeatAccount;
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
  repeatAccount = undefined;
  vi.useRealTimers();
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

describe("cash request provenance survives account cache paths", () => {
  it("keeps the original read start through an inflight join and a later cache hit", async () => {
    getAccountDelayMs = 40;
    const { getAlpacaGateway, resetAlpacaAccountCacheForTests } = await import("../src/lib/alpaca");
    resetAlpacaAccountCacheForTests();
    const gateway = getAlpacaGateway("local", "roth-ira");
    const before = Date.now();
    const first = gateway.getPortfolio("294709855");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const joinedAt = Date.now();
    const [a, b] = await Promise.all([first, gateway.getPortfolio("294709855")]);
    expect(Date.parse(a.cashRequestStartedAt!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(a.cashRequestStartedAt!)).toBeLessThanOrEqual(joinedAt);
    expect(a.cashRequestStartedAt).toBe(b.cashRequestStartedAt);
    const cached = await gateway.getPortfolio("294709855");
    expect(cached.cashRequestStartedAt).toBe(a.cashRequestStartedAt);
    expect(getAccountCalls).toBe(1);
  });

  it("does not turn a successful remote MCP response into local request proof", async () => {
    const { upsertConnectedAccount } = await import("../src/lib/db");
    upsertConnectedAccount({id:"mcp-cash",userId:"local",broker:"alpaca-mcp",environment:"paper",apiKey:"PK_MCP",apiSecret:"synthetic",accountNumber:"PA_MCP",baseUrl:"https://synthetic.invalid/mcp",isActive:false,label:"Synthetic MCP"});
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({result:{content:[{type:"text",text:JSON.stringify({account_number:"PA_MCP",portfolio_value:10000,buying_power:5000,equity:10000,cash:6000,cashRequestStartedAt:"2026-01-01T00:00:00Z"})}]}}),{status:200}));
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const result = await getAlpacaGateway("local", "mcp-cash").getPortfolio("PA_MCP");
    expect(result.cashRequestStartedAt).toBeUndefined();
    expect(getAccountCalls).toBe(0);
  });

  it("REST fallback after MCP failure keeps its existing cache-origin bound", async () => {
    const { upsertConnectedAccount } = await import("../src/lib/db");
    upsertConnectedAccount({id:"fallback-cash",userId:"local",broker:"alpaca-mcp",environment:"live",apiKey:"PK_FALLBACK",apiSecret:"synthetic",accountNumber:"294709855",baseUrl:"https://synthetic.invalid/mcp",isActive:false,label:"Synthetic fallback"});
    vi.stubGlobal("fetch", async () => new Response("unavailable",{status:503}));
    const { getAlpacaGateway, resetAlpacaAccountCacheForTests } = await import("../src/lib/alpaca");
    resetAlpacaAccountCacheForTests();
    const gateway = getAlpacaGateway("local", "fallback-cash");
    const first = await gateway.getPortfolio("294709855");
    const second = await gateway.getPortfolio("294709855");
    expect(first.cashRequestStartedAt).toMatch(/Z$/);
    expect(second.cashRequestStartedAt).toBe(first.cashRequestStartedAt);
    expect(getAccountCalls).toBe(1);
  });
});

it("real dashboard gateway and JSON serialization retain actual request metadata", async () => {
  const { getBrokerGateway } = await import("../src/lib/broker");
  const { DEFAULT_POLICY } = await import("../src/lib/defaults");
  const { resetAlpacaAccountCacheForTests } = await import("../src/lib/alpaca");
  resetAlpacaAccountCacheForTests();
  const gateway = getBrokerGateway({...DEFAULT_POLICY,activeBroker:"alpaca",connectedAccountId:"roth-ira",accountNumber:"294709855"},"local");
  const result = await gateway.getPortfolio("294709855");
  expect(result.cashRequestStartedAt).toMatch(/Z$/);
  expect(JSON.parse(JSON.stringify(result)).cashRequestStartedAt).toBe(result.cashRequestStartedAt);
  expect(getAccountCalls).toBe(1);
});

it("a reused REST object cannot acquire a newer request bound", async () => {
  repeatAccount = {account_number:"294709855",portfolio_value:"10000",buying_power:"5000",equity:"8000",cash:"2000"};
  vi.useFakeTimers({toFake:["Date"]});
  vi.setSystemTime(new Date("2026-11-20T19:00:00Z"));
  try {
    const { getAlpacaGateway,resetAlpacaAccountCacheForTests }=await import("../src/lib/alpaca");
    resetAlpacaAccountCacheForTests();
    const gateway=getAlpacaGateway("local","roth-ira");
    const first=await gateway.getPortfolio("294709855");
    vi.setSystemTime(new Date("2026-11-20T19:00:20Z"));
    const again=await gateway.getPortfolio("294709855");
    expect(getAccountCalls).toBe(2);
    expect(again.cashRequestStartedAt).toBe(first.cashRequestStartedAt);
    expect(first.cashRequestStartedAt).toBe("2026-11-20T19:00:00.000Z");
  } finally { vi.useRealTimers(); }
});
