import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db";
import { makeOrchestrator } from "../src/lib/chat/orchestrator";
import { MockLLM } from "../src/lib/chat/llm";
import { listTurns } from "../src/lib/chat-history";
import { listMemories } from "../src/lib/memory/store";
import { addToWatchlist } from "../src/lib/watchlist";
import { createAlert as alertsCreateAlert } from "../src/lib/alerts";
import type { ToolDeps } from "../src/lib/chat/tools";
import type { ChatLLM } from "../src/lib/chat/types";

const deps: ToolDeps = {
  getQuote: async (symbol) => ({ symbol, price_usd: 200, change_pct: 1.2, as_of: "2024-01-15T00:00:00Z", source: "stub", session: "regular" }),
  searchKnowledge: async () => [],
  createAlert: (userId, input) => {
    const r = alertsCreateAlert(userId, input);
    return "error" in r ? r : { symbol: r.symbol, op: r.op, price: r.price };
  },
  watchlistAdd: (userId, symbol) => {
    try {
      return { ok: true, item: addToWatchlist(userId, symbol) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "ERR" };
    }
  },
  accountLabel: "Test (local)"
};

describe("chat orchestrator (MockLLM)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-orch-test-${Date.now()}.db`;
    getDb();
  });

  const orchestrate = makeOrchestrator(deps, new MockLLM());

  it("quote turn is grounded (as_of + citation + disclaimer), no draft", async () => {
    const r = await orchestrate({ userId: "o1", message: "AAPL price" });
    expect(r.text).toMatch(/as of/i);
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.text).toContain("not personalized financial advice");
    expect(r.draft).toBeNull();
  });

  it("order intent drafts, never executes", async () => {
    const r = await orchestrate({ userId: "o2", message: "buy 10 AAPL at 200" });
    expect(r.draft).toBeTruthy();
    expect(r.draft!.executed).toBe(false);
    expect(r.text).not.toMatch(/\b(placed|executed|filled|submitted)\b/i);
  });

  it("persists user+assistant turns and ingests memory", async () => {
    await orchestrate({ userId: "o3", message: "no options ever" });
    expect(listTurns("o3").length).toBeGreaterThanOrEqual(2);
    expect(listMemories("o3").some((m) => m.subject === "no_options")).toBe(true);
  });

  it("records the model on the assistant reply and turn (user turns carry none)", async () => {
    const r = await orchestrate({ userId: "o_model", message: "AAPL price" });
    expect(r.model).toBe("mock"); // MockLLM.modelName
    const turns = listTurns("o_model");
    const assistant = turns.filter((t) => t.role === "assistant").pop();
    expect(assistant?.model).toBe("mock");
    const user = turns.find((t) => t.role === "user");
    expect(user?.model ?? null).toBeNull();
  });

  it("a retry with the same clientTurnId records the user turn exactly once but still answers", async () => {
    const userId = "o_idem";
    const first = await orchestrate({ userId, message: "AAPL price", clientTurnId: "ct-retry-1" });
    const retry = await orchestrate({ userId, message: "AAPL price", clientTurnId: "ct-retry-1" });
    expect(first.text.length).toBeGreaterThan(0);
    expect(retry.text.length).toBeGreaterThan(0); // the retry's point is getting a reply
    const userTurns = listTurns(userId).filter((t) => t.role === "user");
    expect(userTurns.length).toBe(1);
    expect(userTurns[0]!.clientTurnId).toBe("ct-retry-1");
    // Both provider calls produced an assistant turn — only the user turn is deduped.
    expect(listTurns(userId).filter((t) => t.role === "assistant").length).toBe(2);
  });

  it("two sends with distinct clientTurnIds record two user turns", async () => {
    const userId = "o_idem2";
    await orchestrate({ userId, message: "AAPL price", clientTurnId: "ct-a" });
    await orchestrate({ userId, message: "AAPL price", clientTurnId: "ct-b" });
    const userTurns = listTurns(userId).filter((t) => t.role === "user");
    expect(userTurns.length).toBe(2);
  });

  it("sends without a clientTurnId are never deduped (legacy behavior preserved)", async () => {
    const userId = "o_idem3";
    await orchestrate({ userId, message: "AAPL price" });
    await orchestrate({ userId, message: "AAPL price" });
    expect(listTurns(userId).filter((t) => t.role === "user").length).toBe(2);
  });
});

describe("chat orchestrator — NOW-tranche fixes (I1/I2/I3)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-orch-fixes-${Date.now()}.db`;
    getDb();
  });

  it("I1: a quote with no change/session is narrated WITHOUT a fabricated 0% or session", async () => {
    const noChangeDeps: ToolDeps = {
      ...deps,
      getQuote: async (symbol) => ({ symbol, price_usd: 200, as_of: "2024-01-15", source: "broker" })
    };
    const r = await makeOrchestrator(noChangeDeps, new MockLLM())({ userId: "f1", message: "AAPL price" });
    expect(r.text).toMatch(/as of/i);
    expect(r.text).not.toMatch(/\d+(\.\d+)?%/); // no fabricated percentage
    expect(r.text).not.toMatch(/session/i); // no fabricated session label
  });

  it("I2: the disclaimer is appended server-side even when the model omits it", async () => {
    const noDisclaimer: ChatLLM = { run: async () => ({ text: "Here is some neutral info.", toolCalls: [], citations: [] }) };
    const r = await makeOrchestrator(deps, noDisclaimer)({ userId: "f2", message: "what is a stock?" });
    expect(r.text).toContain("Here is some neutral info.");
    expect(r.text).toContain("not personalized financial advice");
  });

  it("I3: prior turns are replayed to the model on the next turn (multi-turn memory)", async () => {
    let captured: Array<{ role: string; text: string }> = [];
    const recorder: ChatLLM = {
      run: async (a) => {
        captured = (a.history ?? []).map((h) => ({ role: h.role, text: h.text }));
        return { text: "ok", toolCalls: [], citations: [] };
      }
    };
    const orch = makeOrchestrator(deps, recorder);
    await orch({ userId: "f3", message: "my first message here" });
    expect(captured.length).toBe(0); // first turn: no prior history
    await orch({ userId: "f3", message: "my second message" });
    expect(captured.length).toBeGreaterThanOrEqual(2); // user1 + assistant1
    expect(captured.some((h) => h.text.includes("my first message here"))).toBe(true);
    expect(captured[0]!.role).toBe("user"); // history must start with a user turn (Anthropic requirement)
  });
});

describe("chat read-only state tools (I6)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-state-tools-${Date.now()}.db`;
    getDb();
  });

  const stateDeps: ToolDeps = {
    ...deps,
    getPositions: async () => [{ symbol: "AAPL", quantity: 10, averageCost: 150, marketValue: 1800 }],
    getPortfolio: async () => ({ accountNumber: "T", totalMarketValue: 10000, buyingPower: 8000, equityMarketValue: 1800, optionMarketValue: 0, cash: 8200 }),
    listWatchlist: () => [
      { symbol: "NVDA", addedAt: "2024-01-01" },
      { symbol: "TSLA", addedAt: "2024-01-02" }
    ],
    listAlerts: () => [
      { id: "a1", userId: "s", symbol: "AAPL", op: "<", price: 180, note: "", status: "armed", createdAt: "2024-01-01", triggeredAt: null, triggeredPrice: null }
    ],
    listOpenProposals: () => [],
    getFundamentals: async (symbol) => ({ companyName: "Apple Inc.", peRatio: 30, analystRating: "Buy" }),
    getMarketSignals: async () => ({ marketBreadthPct: 62.5, marketTopGainers: [{ sym: "AAPL", pct: 4.5 }] })
  };
  const orch = makeOrchestrator(stateDeps, new MockLLM());

  it("reads positions + portfolio for a 'my positions' query", async () => {
    const r = await orch({ userId: "s1", message: "how are my positions doing?" });
    expect(r.text).toMatch(/AAPL/);
    expect(r.text).toMatch(/Account value/i);
  });

  it("reads the watchlist", async () => {
    const r = await orch({ userId: "s2", message: "what's on my watchlist?" });
    expect(r.text).toMatch(/NVDA/);
    expect(r.text).toMatch(/TSLA/);
  });

  it("reads armed alerts", async () => {
    const r = await orch({ userId: "s3", message: "show me my alerts" });
    expect(r.text).toMatch(/AAPL/);
  });

  it("reads fundamentals for a ticker", async () => {
    const r = await orch({ userId: "s4", message: "what is the PE ratio of AAPL?" });
    expect(r.text).toMatch(/Apple Inc/);
    expect(r.text).toMatch(/PE: 30/);
  });

  it("reads market signals", async () => {
    const r = await orch({ userId: "s5", message: "what stocks did best today?" });
    expect(r.text).toMatch(/Breadth: 62.5%/);
    expect(r.text).toMatch(/AAPL \(\+4.5%\)/);
  });
});
