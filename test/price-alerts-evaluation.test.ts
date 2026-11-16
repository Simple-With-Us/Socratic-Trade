import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPriceAlerts, createAlert } from "../src/lib/alerts";
import { getDb, listAudit, setPolicy } from "../src/lib/db";
import { DEFAULT_POLICY } from "../src/lib/defaults";

const mockFetchFreshQuotesCascade = vi.fn();
vi.mock("../src/lib/quotes-cascade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/quotes-cascade")>();
  return {
    ...actual,
    fetchFreshQuotesCascade: (...args: unknown[]) => mockFetchFreshQuotesCascade(...args)
  };
});

const mockSendNotification = vi.fn();
vi.mock("../src/lib/notifications", () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args)
}));

describe("checkPriceAlerts evaluation", () => {
  const userId = "price-alert-eval-user";

  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/price-alerts-eval-${Date.now()}.db`;
    getDb();
  });

  beforeEach(() => {
    mockFetchFreshQuotesCascade.mockReset();
    mockSendNotification.mockReset();
    mockSendNotification.mockResolvedValue({});
    setPolicy(
      {
        ...DEFAULT_POLICY,
        accountNumber: undefined,
        connectedAccountId: undefined,
        maxQuoteAgeSec: 120
      },
      userId
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("triggers with zero connected accounts using cascade market data alone", async () => {
    const created = createAlert(userId, { symbol: "AAPL", op: "<", price: 200 });
    expect("error" in created).toBe(false);
    if ("error" in created) return;

    const freshAsOf = new Date().toISOString();
    mockFetchFreshQuotesCascade.mockResolvedValue({
      AAPL: {
        symbol: "AAPL",
        price: 150,
        provider: "yahoo-finance",
        asOf: freshAsOf
      }
    });

    const triggered = await checkPriceAlerts(userId);
    expect(mockFetchFreshQuotesCascade).toHaveBeenCalledWith(["AAPL"], userId, undefined, undefined);
    expect(triggered).toHaveLength(1);
    expect(triggered[0]?.id).toBe(created.id);
    expect(triggered[0]?.status).toBe("triggered");
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
  });

  it("forwards the operating account (accountNumber + connectedAccountId) into the cascade", async () => {
    // The alert check must run against the OPERATING account's tape (Alpaca
    // PAPER `delayed_sip`), not a process-global default.
    setPolicy(
      {
        ...DEFAULT_POLICY,
        accountNumber: "PA33IDTHMFK9",
        connectedAccountId: "ap-paper",
        maxQuoteAgeSec: 120
      },
      userId
    );
    createAlert(userId, { symbol: "AAPL", op: "<", price: 200 });
    mockFetchFreshQuotesCascade.mockResolvedValue({
      AAPL: {
        symbol: "AAPL",
        price: 150,
        provider: "alpaca",
        asOf: new Date().toISOString()
      }
    });

    await checkPriceAlerts(userId);

    expect(mockFetchFreshQuotesCascade).toHaveBeenCalledWith(
      ["AAPL"],
      userId,
      "PA33IDTHMFK9",
      "ap-paper"
    );
  });

  it("logs and audits a cascade failure instead of returning silently", async () => {
    createAlert(userId, { symbol: "MSFT", op: ">", price: 100 });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockFetchFreshQuotesCascade.mockRejectedValue(new Error("provider outage"));

    const triggered = await checkPriceAlerts(userId);
    expect(triggered).toEqual([]);
    expect(consoleSpy).toHaveBeenCalled();
    expect(
      listAudit(20, userId).some((row) => {
        if (row.kind !== "alert.check_error") return false;
        const payload = row.payload as { error?: string };
        return payload.error?.includes("provider outage") ?? false;
      })
    ).toBe(true);

    consoleSpy.mockRestore();
  });

  it("does not trigger on a stale quote", async () => {
    const created = createAlert(userId, { symbol: "TSLA", op: "<", price: 300 });
    expect("error" in created).toBe(false);
    if ("error" in created) return;

    const staleAsOf = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    mockFetchFreshQuotesCascade.mockResolvedValue({
      TSLA: {
        symbol: "TSLA",
        price: 250,
        provider: "yahoo-finance",
        asOf: staleAsOf
      }
    });

    const triggered = await checkPriceAlerts(userId);
    expect(triggered).toEqual([]);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("rejects symbols that isValidAppSymbol rejects", () => {
    expect(createAlert(userId, { symbol: ".AAPL", op: "<", price: 100 })).toEqual({ error: "INVALID_SYMBOL" });
    expect(createAlert(userId, { symbol: "AAPL..", op: "<", price: 100 })).toEqual({ error: "INVALID_SYMBOL" });
  });
});
