import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEightKContext, isEightKRefreshDue, parseCurrent8KFeed, parseCikTickerMap, parseEightKItemsFromHtml, getEightKSignals, getEightKSummaryBacklog, mergeEightK, refreshEightK } from "../src/lib/web-sources/sec8k";
import { getSymbolWebSignals } from "../src/lib/web-sources";

const mocks = vi.hoisted(() => ({
  storeContexts: vi.fn(),
  runStrategyOnce: vi.fn()
}));

vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/vector-db")>();
  return { ...actual, managedVectorLedgerAuthority: vi.fn(), storeContexts: mocks.storeContexts };
});

vi.mock("../src/lib/strategy", () => {
  return {
    runStrategyOnce: (...args: unknown[]) => mocks.runStrategyOnce(...args)
  };
});

vi.mock("../src/lib/market-hours", () => ({
  isRunAllowedNow: () => true
}));

import { resetDbForTesting } from "../src/lib/db";

beforeAll(() => {
  resetDbForTesting();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec8k-${randomUUID()}.db`)}`;
});
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.runStrategyOnce.mockResolvedValue({
    runId: randomUUID(),
    status: "completed",
    summary: "test strategy run completed",
    proposals: []
  });
  mocks.storeContexts.mockImplementation(async (contexts: unknown[]) => ({
    attempted: contexts.length,
    indexed: contexts.length
  }));
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  for (const { name } of tables) {
    try {
      db.prepare(`DELETE FROM "${name.replace(/"/g, '""')}"`).run();
    } catch {}
  }
  delete process.env.WEB_SOURCE_SEC8K;
  delete process.env.WEB_SOURCE_SEC8K_FULL_BODY;
  delete process.env.TRIGGER_ENGINE;
  delete process.env.TRIGGER_MODE;
  delete process.env.TRIGGER_MAX_BATCH;
  delete process.env.TRIGGER_GLOBAL_COOLDOWN_SEC;
  delete process.env.TRIGGER_QUEUE_MAX;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TRIGGER_ENGINE;
  delete process.env.TRIGGER_MODE;
  delete process.env.TRIGGER_MAX_BATCH;
  delete process.env.TRIGGER_GLOBAL_COOLDOWN_SEC;
  delete process.env.TRIGGER_QUEUE_MAX;
});

describe("8-K parsers", () => {
  it("parses CIKs + accessions from the current-8-K feed (deduped)", () => {
    const atom = `<feed>
      <entry><title>8-K - APPLE INC (0000320193) (Filer)</title><link href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/0000320193-26-000001-index.htm"/><updated>2026-06-17T10:00:00-04:00</updated></entry>
      <entry><title>8-K - APPLE INC (0000320193) (Filer)</title><link href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/0000320193-26-000001-index.htm"/><updated>2026-06-17T10:00:00-04:00</updated></entry>
    </feed>`;
    const rows = parseCurrent8KFeed(atom);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cik: "320193",
      accession: "0000320193-26-000001",
      filedAt: "2026-06-17",
      acceptedAt: "2026-06-17T14:00:00.000Z",
      filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/0000320193-26-000001-index.htm"
    });
  });
  it("parses the CIK->ticker map", () => {
    const map = parseCikTickerMap({ "0": { cik_str: 320193, ticker: "AAPL" }, "1": { cik_str: 1045810, ticker: "NVDA" } });
    expect(map["320193"]).toBe("AAPL");
    expect(map["1045810"]).toBe("NVDA");
  });
  it("merges + prunes by accession and window", () => {
    const now = Date.parse("2026-06-17T00:00:00Z");
    const merged = mergeEightK(
      [{ symbol: "AAPL", filedAt: "2026-06-16", accession: "a1" }],
      [{ symbol: "AAPL", filedAt: "2026-06-17", accession: "a2" }, { symbol: "OLD", filedAt: "2026-01-01", accession: "old" }],
      now, 4
    );
    expect(merged.map((e) => e.accession).sort()).toEqual(["a1", "a2"]); // old pruned
  });
  it("parses SEC filing item labels and builds useful RAG context", () => {
    const html = `<div class="formGrouping"><div class="infoHead">Items</div><div class="info">Item 2.02 Results of Operations and Financial Condition; Item 9.01 Financial Statements and Exhibits</div></div>`;
    expect(parseEightKItemsFromHtml(html)).toEqual([
      "Item 2.02 Results of Operations and Financial Condition",
      "Item 9.01 Financial Statements and Exhibits"
    ]);
    const context = buildEightKContext({
      symbol: "AAPL",
      filedAt: "2026-06-17",
      accession: "0000320193-26-000001",
      filingUrl: "https://www.sec.gov/example-index.htm",
      items: ["Item 2.02 Results of Operations and Financial Condition"]
    });
    expect(context).toContain("Reported item(s): Item 2.02 Results of Operations and Financial Condition.");
    expect(context).toContain("SEC filing page: https://www.sec.gov/example-index.htm.");
  });
});

describe("getEightKSignals + refresh", () => {
  it("surfaces a catalyst bulletin for symbols with a recent 8-K", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const today = new Date().toISOString().slice(0, 10);
    setInternalSetting("webSource:sec8k:dataset", { events: [{ symbol: "AAPL", filedAt: today, accession: "a1", items: ["Item 5.02 Departure of Directors or Certain Officers"] }], fetchedAt: new Date().toISOString(), recordCount: 1 });
    const sig = getEightKSignals(["AAPL", "MSFT"]);
    expect(sig.AAPL.bulletin).toContain("filed an 8-K");
    expect(sig.AAPL.bulletin).toContain("Item 5.02");
    expect(sig.MSFT).toBeUndefined();
    expect(getSymbolWebSignals(["AAPL"]).AAPL?.bulletins.some((b) => b.includes("8-K"))).toBe(true);
  });

  it("dedupes concurrent cold ticker→CIK map loads into a single company_tickers.json fetch", async () => {
    const { deleteInternalSetting } = await import("../src/lib/db");
    deleteInternalSetting("webSource:sec:tickerCikMap");
    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("company_tickers.json")) {
        fetchCount += 1;
        return new Response(JSON.stringify({ "0": { cik_str: 320193, ticker: "AAPL" } }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    const { loadTickerCikMap } = await import("../src/lib/web-sources/sec8k");
    const now = Date.now();
    const [a, b] = await Promise.all([loadTickerCikMap(now), loadTickerCikMap(now)]);
    expect(a.AAPL).toBe("320193");
    expect(b.AAPL).toBe("320193");
    expect(fetchCount).toBe(1); // shared in-flight promise — not two duplicate SEC requests
  });

  it("scrapes feed + CIK map and persists", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("company_tickers.json")) return new Response(JSON.stringify({ "0": { cik_str: 320193, ticker: "AAPL" } }), { status: 200 });
      if (u.includes("action=getcurrent")) return new Response(`<feed><entry><title>8-K - APPLE INC (0000320193) (Filer)</title><link href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000002/0000320193-26-000002-index.htm"/><updated>${new Date().toISOString()}</updated></entry></feed>`, { status: 200 });
      if (u.includes("0000320193-26-000002-index.htm")) return new Response(`<div class="formGrouping"><div class="infoHead">Items</div><div class="info">Item 2.02 Results of Operations and Financial Condition</div></div>`, { status: 200 });
      return new Response("nope", { status: 404 });
    });
    const result = await refreshEightK(Date.now(), true);
    expect(result.ok).toBe(true);
    expect(result.recordCount).toBe(1);
    expect(getEightKSignals(["AAPL"]).AAPL.count).toBe(1);
    expect(getEightKSignals(["AAPL"]).AAPL.bulletin).toContain("Item 2.02");
  });

  it("retains the exact summary backlog when another process owns the RAG lease", async () => {
    const acceptedAt = "2026-07-14T15:42:17.000Z";
    let feedFetches = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("company_tickers.json")) {
        return new Response(JSON.stringify({ "0": { cik_str: 320193, ticker: "AAPL" } }), { status: 200 });
      }
      if (u.includes("action=getcurrent")) {
        feedFetches += 1;
        return new Response(`<feed><entry><title>8-K - APPLE INC (0000320193) (Filer)</title><link href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000003/0000320193-26-000003-index.htm"/><updated>${acceptedAt}</updated></entry></feed>`, { status: 200 });
      }
      if (u.includes("0000320193-26-000003-index.htm")) {
        return new Response("<div>Item 2.02 Results of Operations and Financial Condition</div>", { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    const { OPERATION_LEASE_GROUPS, runWithOperationLease } = await import("../src/lib/operation-lease");
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const holder = runWithOperationLease(
      { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "test-rag-holder" },
      async () => {
        entered();
        await releasePromise;
      }
    );
    await enteredPromise;

    try {
      const result = await refreshEightK(Date.parse(acceptedAt), true);
      expect(result.warning).toContain("test-rag-holder");
      expect(getEightKSummaryBacklog()).toEqual([expect.objectContaining({
        symbol: "AAPL",
        accession: "0000320193-26-000003",
        acceptedAt
      })]);
    } finally {
      release();
      await holder;
    }

    const drained = await refreshEightK(Date.parse(acceptedAt) + 1_000, false);
    expect(drained).toMatchObject({ ok: true, skipped: true });
    expect(getEightKSummaryBacklog()).toEqual([]);
    expect(feedFetches).toBe(1);
    expect(mocks.storeContexts).toHaveBeenCalledTimes(1);
  });

  it("drains an atomically persisted discovery backlog on the next non-due tick after a RAG failure", async () => {
    const acceptedAt = "2026-07-14T16:42:17.000Z";
    let feedFetches = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("company_tickers.json")) {
        return new Response(JSON.stringify({ "0": { cik_str: 320193, ticker: "AAPL" } }), { status: 200 });
      }
      if (u.includes("action=getcurrent")) {
        feedFetches += 1;
        return new Response(`<feed><entry><title>8-K - APPLE INC (0000320193) (Filer)</title><link href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000004/0000320193-26-000004-index.htm"/><updated>${acceptedAt}</updated></entry></feed>`, { status: 200 });
      }
      if (u.includes("0000320193-26-000004-index.htm")) {
        return new Response("<div>Item 2.02 Results of Operations and Financial Condition</div>", { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    mocks.storeContexts.mockRejectedValueOnce(new Error("simulated crash boundary"));

    const first = await refreshEightK(Date.parse(acceptedAt), true);
    const { getInternalSetting } = await import("../src/lib/db");
    expect(first.warning).toContain("simulated crash boundary");
    expect(getInternalSetting<{ recordCount: number }>("webSource:sec8k:dataset")?.recordCount).toBe(1);
    expect(getEightKSummaryBacklog()).toEqual([
      expect.objectContaining({ accession: "0000320193-26-000004", acceptedAt })
    ]);

    const second = await refreshEightK(Date.parse(acceptedAt) + 1_000, false);
    expect(second).toMatchObject({ ok: true, skipped: true, recordCount: 1 });
    expect(second.warning).toBeUndefined();
    expect(getEightKSummaryBacklog()).toEqual([]);
    expect(feedFetches).toBe(1);
    expect(mocks.storeContexts).toHaveBeenCalledTimes(2);
  });

  it("replays an atomically enqueued material trigger on a non-due tick after delivery crashes", async () => {
    process.env.TRIGGER_ENGINE = "on";
    process.env.TRIGGER_MODE = "event";
    process.env.TRIGGER_MAX_BATCH = "1";
    process.env.TRIGGER_GLOBAL_COOLDOWN_SEC = "0";
    const acceptedAt = "2026-07-14T17:42:17.000Z";
    const userId = `sec8k-trigger-${randomUUID()}`;
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    setPolicy({ ...getPolicy(userId), systemState: "active", accountNumber: `ACC-${userId}` }, userId);
    let feedFetches = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("company_tickers.json")) {
        return new Response(JSON.stringify({ "0": { cik_str: 320193, ticker: "AAPL" } }), { status: 200 });
      }
      if (u.includes("action=getcurrent")) {
        feedFetches += 1;
        return new Response(`<feed><entry><title>8-K - APPLE INC (0000320193) (Filer)</title><link href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/0000320193-26-000005-index.htm"/><updated>${acceptedAt}</updated></entry></feed>`, { status: 200 });
      }
      if (u.includes("0000320193-26-000005-index.htm")) {
        return new Response("<div>Item 2.02 Results of Operations and Financial Condition</div>", { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    const triggers = await import("../src/lib/triggers");
    const drainSpy = vi.spyOn(triggers, "drainMaterialEventQueue")
      .mockImplementationOnce(() => {
        throw new Error("simulated trigger-dispatch crash");
      });

    try {
      const first = await refreshEightK(Date.parse(acceptedAt), true);
      expect(first.warning).toContain("simulated trigger-dispatch crash");
      expect(triggers.getDurableMaterialTriggerStatus(userId)).toMatchObject({
        pending: 1,
        receiptCount: 0
      });
      expect(mocks.runStrategyOnce).not.toHaveBeenCalled();
    } finally {
      drainSpy.mockRestore();
    }

    const second = await refreshEightK(Date.parse(acceptedAt) + 1_000, false);
    expect(second).toMatchObject({ ok: true, skipped: true, recordCount: 1 });
    await vi.waitFor(() => expect(mocks.runStrategyOnce).toHaveBeenCalledWith(userId));
    await vi.waitFor(() => expect(triggers.getDurableMaterialTriggerStatus(userId)).toMatchObject({
      pending: 0,
      receiptCount: 1
    }));
    expect(feedFetches).toBe(1);
  });

  it("rolls back the discovered dataset and RAG queues when atomic trigger enqueue cannot commit", async () => {
    process.env.TRIGGER_ENGINE = "on";
    process.env.TRIGGER_MODE = "event";
    process.env.TRIGGER_QUEUE_MAX = "1";
    const acceptedAt = "2026-07-14T18:42:17.000Z";
    const userId = `sec8k-trigger-full-${randomUUID()}`;
    const { getDb, getPolicy, getInternalSetting, setPolicy } = await import("../src/lib/db");
    setPolicy({ ...getPolicy(userId), systemState: "active", accountNumber: `ACC-${userId}` }, userId);
    const triggers = await import("../src/lib/triggers");
    const database = getDb();
    database.transaction(() => {
      triggers.enqueueMaterialEventsForUsersTx(database, [userId], [{
        type: "technical",
        symbol: "MSFT",
        sourceId: `prefill-${randomUUID()}`
      }], Date.parse(acceptedAt) - 1_000);
    }).immediate();

    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("company_tickers.json")) {
        return new Response(JSON.stringify({ "0": { cik_str: 320193, ticker: "AAPL" } }), { status: 200 });
      }
      if (u.includes("action=getcurrent")) {
        return new Response(`<feed><entry><title>8-K - APPLE INC (0000320193) (Filer)</title><link href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000006/0000320193-26-000006-index.htm"/><updated>${acceptedAt}</updated></entry></feed>`, { status: 200 });
      }
      if (u.includes("0000320193-26-000006-index.htm")) {
        return new Response("<div>Item 2.02 Results of Operations and Financial Condition</div>", { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });

    try {
      await expect(refreshEightK(Date.parse(acceptedAt), true)).rejects.toThrow(
        `Durable material-trigger queue is full for user ${userId}.`
      );
      expect(getInternalSetting("webSource:sec8k:dataset")).toBeUndefined();
      expect(getEightKSummaryBacklog()).toEqual([]);
      expect(triggers.getDurableMaterialTriggerStatus(userId)).toMatchObject({
        pending: 1,
        receiptCount: 0
      });
      expect(mocks.storeContexts).not.toHaveBeenCalled();
    } finally {
      database.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = ?")
        .run(userId, "material_trigger_state_v1");
    }
  });

  it.each([
    ["invalid attempt timestamp", "webSource:sec8k:lastAttempt", "not-a-timestamp"],
    ["non-string attempt state", "webSource:sec8k:lastAttempt", { persisted: "state" }],
    ["invalid dataset timestamp", "webSource:sec8k:dataset", { events: [], fetchedAt: "not-a-timestamp", recordCount: 0 }],
    ["non-string dataset timestamp", "webSource:sec8k:dataset", { events: [], fetchedAt: { persisted: "state" }, recordCount: 0 }]
  ])("fails open for a %s", async (_label, key, value) => {
    const { setInternalSetting } = await import("../src/lib/db");
    setInternalSetting(key, value);

    expect(() => isEightKRefreshDue()).not.toThrow();
    expect(isEightKRefreshDue()).toBe(true);
  });
});
