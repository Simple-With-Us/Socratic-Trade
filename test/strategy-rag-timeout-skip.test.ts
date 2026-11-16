/**
 * ST-4601: the first strategy-run retrieval deadline skips RAG for the rest of that run.
 * The timed-out symbol still continues with no chunks.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { markDeadlineTimeout } from "../src/lib/inflight-deadline";
import { STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE } from "../src/lib/rag-retrieval-deadline";
import { DEFAULT_POLICY } from "../src/lib/defaults";

process.env.OPENROUTER_API_KEY = "test-key";

const mocks = vi.hoisted(() => ({ retrieveContextDetailed: vi.fn() }));

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: mocks.retrieveContextDetailed,
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.35,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => {}
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rag-skip-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  mocks.retrieveContextDetailed.mockReset();
});

function nasdaqRows(): Response {
  const row = (symbol: string) => ({
    symbol,
    lastsale: "$200",
    pctchange: "1%",
    volume: "1000000",
    marketCap: "3000000000000",
    sector: "Technology",
    industry: "Consumer Electronics"
  });
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-06-15",
        table: { rows: [row("AAPL"), row("MSFT"), row("NVDA")] }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("strategy run skips RAG after one retrieval deadline (ST-4601)", () => {
  it("retrieves the first symbol, then skips the rest of the run and logs the skipped count once", async () => {
    process.env.RAG_RETRIEVAL_CONCURRENCY = "1";
    process.env.RAG_PROPOSER_DOSSIER = "off";
    process.env.RAG_RETRIEVAL_BACKOFF = "off";
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    mocks.retrieveContextDetailed.mockImplementation(async () => {
      throw markDeadlineTimeout(new Error(STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals: [] }) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("nasdaq.com")) return nasdaqRows();
      return new Response("not found", { status: 404 });
    });

    const { clearMarketCache } = await import("../src/lib/market");
    clearMarketCache();
    const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({
      id: accountId,
      userId: "local",
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "RAG Timeout Skip",
      isActive: true
    });
    setActiveConnectedAccount(accountId);
    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL", "MSFT", "NVDA"],
      strategyAuthority: "decide"
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    await runStrategyOnce();

    expect(mocks.retrieveContextDetailed).toHaveBeenCalledTimes(1);
    const skipLogs = warn.mock.calls
      .map((call) => call.map((part) => String(part)).join(" "))
      .filter((line) => line.includes("skipped RAG retrieval for"));
    expect(skipLogs).toHaveLength(1);
    expect(skipLogs[0]).toContain(STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE);
    const skipped = Number(/skipped RAG retrieval for (\d+) later symbol/.exec(skipLogs[0] ?? "")?.[1]);
    expect(skipped).toBeGreaterThanOrEqual(1);
    warn.mockRestore();
  });
});
