/**
 * 2026-07-04 RAG quick-wins — strategy.ts wiring integration test.
 *
 * `RetrieveOptions.minRelevanceScore` (post-rerank relevance floor) and `dedupeSimilarity`
 * (near-duplicate suppression) have existed in vector-db.ts's `retrieveContextDetailed`/`rankPool`
 * since the 2026-07-01 RAG backlog, but no caller ever passed them — strategy.ts's advisory RAG
 * context (`ragContext`) only ever set `docType`/`minScore`/`connectedAccountId`. This test asserts
 * strategy.ts now wires the dormant relevance-floor + dedupe stages, and that each retrieved chunk
 * is prefixed with a provenance header before being joined into the prompt's `ragContext`.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
process.env.OPENROUTER_API_KEY = "test-key";
import { DEFAULT_POLICY } from "../src/lib/defaults";

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
  formatChunkWithProvenance: (chunk: { text: string }, symbol?: string) =>
    `[10-K · risk-factors · ${symbol ?? ""} · 2026-02-01 · rel 0.80]\n${chunk.text}`,
  storeContext: async () => {},
  storeContexts: async () => {}
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rag-wiring-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  mocks.retrieveContextDetailed.mockReset();
});

function nasdaqRow(): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-06-15",
        table: { rows: [{ symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" }] }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("strategy.ts RAG retrieval wiring (2026-07-04 quick-wins)", () => {
  it("passes minRelevanceScore and dedupeSimilarity to retrieveContextDetailed, and joins provenance-prefixed chunk text into the prompt", async () => {
    mocks.retrieveContextDetailed.mockResolvedValue([
      { id: "c1", text: "Apple faces supply-chain risk.", score: 0.9, source: "sec", as_of: "2026-02-01", doc_type: "10-k", section: "risk-factors" }
    ]);

    process.env.OPENROUTER_API_KEY = "test-openai-key";
    const openAiBodies: Array<{ input?: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        openAiBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals: [] }) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });

    const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "RAG Wiring Test", isActive: true });
    setActiveConnectedAccount(accountId);
    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide"
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();

    expect(mocks.retrieveContextDetailed).toHaveBeenCalled();
    const [, , , , options] = mocks.retrieveContextDetailed.mock.calls[0]!;
    expect(options).toMatchObject({ minRelevanceScore: 0.35, dedupeSimilarity: 0.6 });

    const bullBody = openAiBodies[0]!;
    const userContent = JSON.parse(bullBody.input!.find((item) => item.role === "user")?.content ?? "{}");
    expect(userContent.retrievedFinancialContext).toContain("[10-K · risk-factors · AAPL · 2026-02-01 · rel 0.80]");
    expect(userContent.retrievedFinancialContext).toContain("Apple faces supply-chain risk.");

    // Prompt consumption is captured only after containment + the shared evidence budget. The
    // receipt propagates a stable ref and intentionally never persists the raw retrieval query or
    // prompt excerpt.
    const { listAudit } = await import("../src/lib/db");
    const consumption = [...listAudit(200)].reverse().find(
      (entry) => entry.kind === "strategy_rag_prompt_consumption" && (entry.payload as { runId?: string }).runId === result.runId
    );
    expect(consumption).toBeTruthy();
    const payload = consumption!.payload as {
      outcome?: string;
      retrievedCandidateCount?: number;
      retrievalFailureCount?: number;
      consumed?: Array<{ chunkId?: string; evidenceRef?: string; state?: string }>;
      retrievedButNotConsumed?: unknown[];
    };
    expect(payload).toMatchObject({ outcome: "assembled", retrievalFailureCount: 0 });
    expect(payload.retrievedCandidateCount).toBeGreaterThan(0);
    expect(payload.consumed).toEqual([expect.objectContaining({ chunkId: "c1", state: "consumed", evidenceRef: expect.stringMatching(/^rag_[a-f0-9]{24}$/) })]);
    expect(payload.retrievedButNotConsumed).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain("Significant financial events");
    expect(JSON.stringify(payload)).not.toContain("Apple faces supply-chain risk");
  }, 30_000);

  it("RAG_PROPOSER_DOSSIER=off keeps the raw retrieveContextDetailed path", async () => {
    vi.stubEnv("RAG_PROPOSER_DOSSIER", "off");
    const dossier = await import("../src/lib/rag/proposer-dossier");
    const spy = vi.spyOn(dossier, "assembleProposerDossier");
    mocks.retrieveContextDetailed.mockResolvedValue([
      { id: "c-off", text: "Flag-off body chunk.", score: 0.9, source: "sec", as_of: "2026-02-01", doc_type: "10-k", section: "risk-factors" }
    ]);

    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals: [] }) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });

    const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "RAG Flag Off", isActive: true });
    setActiveConnectedAccount(accountId);
    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide"
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    await runStrategyOnce();

    expect(spy).not.toHaveBeenCalled();
    expect(mocks.retrieveContextDetailed).toHaveBeenCalled();
    const [, , limit, , options] = mocks.retrieveContextDetailed.mock.calls[0]!;
    expect(limit).toBeGreaterThanOrEqual(1);
    expect(options).toMatchObject({ minRelevanceScore: 0.35, dedupeSimilarity: 0.6 });
    spy.mockRestore();
  }, 30_000);
});
