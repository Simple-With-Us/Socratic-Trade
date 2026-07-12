/**
 * Episodic decision memory — strategy.ts injection integration test (2026-07-04 composite expert
 * review, section A item 1). With the LLM stubbed, asserts that:
 *
 *  - the strategy run performs the SECOND retrieval pass over the episodic doc types
 *    (['socratic-decision','coach-note','lesson']) with a situation-sketch query (cross-symbol,
 *    as-of stamped) — distinct from the filings pass;
 *  - the labeled "Closest historical analogs" + "Owner coaching" blocks are injected into BOTH
 *    the Bull and the Bear userContent (evidence parity), with the top-analog similarity shown
 *    and opposite-sign priors labeled COUNTEREXAMPLE;
 *  - the injected analog/coaching vector ids are persisted per run (audit kind
 *    `experience_retrieval`) so retrieval-usefulness scoring can recover them later.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

const mocks = vi.hoisted(() => ({ retrieveContextDetailed: vi.fn() }));

vi.mock("../src/lib/vector-db", () => ({
  retrieveContext: async () => [],
  retrieveContextDetailed: mocks.retrieveContextDetailed,
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.35,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string; doc_type?: string }, symbol?: string) =>
    `[${(chunk.doc_type ?? "context").toUpperCase()}${symbol ? ` · ${symbol}` : ""}]\n${chunk.text}`,
  storeContext: async () => {},
  storeContexts: async () => ({ attempted: 0, indexed: 0 })
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-episodic-injection-${randomUUID()}.db`)}`;
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

describe("strategy.ts episodic analogs + owner coaching injection", () => {
  it("injects the labeled blocks into BOTH Bull and Bear payloads and persists the injected ids per run", async () => {
    mocks.retrieveContextDetailed.mockImplementation(
      async (_query: string, _symbol: string, _limit: number, _userId: string, options?: { docType?: string[] }) => {
        if (options?.docType?.includes("socratic-decision")) {
          // Episodic pass: one winning prior, one opposite-sign prior, one coach note.
          return [
            {
              id: "analog-win",
              text: "Prior momentum breakout on MSFT worked (+7.5%).",
              score: 0.81,
              doc_type: "socratic-decision",
              source: "experience-memory",
              metadata: { run_id: "run-old-1", return_pct: 7.5, symbol: "MSFT" }
            },
            {
              id: "analog-loss",
              text: "Similar setup on AMD reversed hard (-5.2%).",
              score: 0.74,
              doc_type: "socratic-decision",
              source: "experience-memory",
              metadata: { run_id: "run-old-2", return_pct: -5.2, symbol: "AMD" }
            },
            {
              id: "coach-note-1",
              text: "Owner: stop chasing extended momentum after day 3.",
              score: 0.69,
              doc_type: "coach-note",
              source: "socratic-memory",
              metadata: { symbol: "AAPL" }
            }
          ];
        }
        // Filings pass (docType 10-k/10-q/8-k/…): nothing retrieved in this test.
        return [];
      }
    );

    process.env.OPENAI_API_KEY = "test-openai-key";
    const openAiBodies: Array<{ input?: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("api.openai.com")) {
        openAiBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals: [] }) }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });

    const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey, listAudit } = await import("../src/lib/db");
    upsertUserApiKey("local", "openai", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Episodic Injection Test", isActive: true });
    setActiveConnectedAccount(accountId);
    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide"
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    await runStrategyOnce();

    // The episodic pass ran with the situation sketch (not the filings query), cross-symbol,
    // over the three episodic doc types, with an as-of stamp.
    const episodicCall = mocks.retrieveContextDetailed.mock.calls.find(
      (call) => (call[4] as { docType?: string[] } | undefined)?.docType?.includes("socratic-decision")
    );
    expect(episodicCall).toBeDefined();
    const [episodicQuery, , , , episodicOptions] = episodicCall! as unknown as [
      string,
      string,
      number,
      string,
      { docType?: string[]; matchAllSymbols?: boolean; asOf?: string }
    ];
    expect(episodicQuery).toContain("Trading situation: market regime");
    expect(episodicQuery).not.toContain("Significant financial events, SEC filings");
    expect(episodicOptions.docType).toEqual(["socratic-decision", "coach-note", "lesson"]);
    expect(episodicOptions.matchAllSymbols).toBe(true);
    expect(typeof episodicOptions.asOf).toBe("string");

    // Both LLM steps ran: bodies[0] = Bull, bodies[1] = Bear.
    expect(openAiBodies.length).toBeGreaterThanOrEqual(2);
    const payloads = openAiBodies.slice(0, 2).map(
      (body) => JSON.parse(body.input!.find((item) => item.role === "user")?.content ?? "{}") as Record<string, unknown>
    );
    for (const [index, payload] of payloads.entries()) {
      const label = index === 0 ? "Bull" : "Bear";
      const analogs = String(payload.closestHistoricalAnalogs ?? "");
      const coaching = String(payload.ownerCoaching ?? "");
      expect(analogs, `${label} payload missing analogs block`).toContain("CLOSEST HISTORICAL ANALOGS");
      expect(analogs, `${label} payload missing top-analog similarity`).toContain("top-analog similarity 0.81");
      expect(analogs, `${label} payload missing winning analog`).toContain("Prior momentum breakout on MSFT worked");
      expect(analogs, `${label} payload missing counterexample label`).toContain("[COUNTEREXAMPLE — opposite realized sign]");
      expect(analogs, `${label} payload missing losing analog`).toContain("Similar setup on AMD reversed hard");
      expect(coaching, `${label} payload missing coaching block`).toContain("OWNER COACHING");
      expect(coaching, `${label} payload missing coach note`).toContain("stop chasing extended momentum after day 3");
    }

    // Run-input persistence: the injected analog/coaching ids are recoverable per run.
    const auditRows = listAudit(500).filter((row) => row.kind === "experience_retrieval");
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const payload = auditRows[0]!.payload as {
      runId?: string;
      asOf?: string;
      analogIds?: string[];
      coachingIds?: string[];
      counterexampleIds?: string[];
      topAnalogSimilarity?: number;
    };
    expect(payload.runId).toBeTruthy();
    expect(typeof payload.asOf).toBe("string");
    expect(payload.analogIds).toEqual(expect.arrayContaining(["analog-win", "analog-loss"]));
    expect(payload.coachingIds).toEqual(["coach-note-1"]);
    expect(payload.counterexampleIds).toEqual(["analog-loss"]);
    expect(payload.topAnalogSimilarity).toBeCloseTo(0.81, 5);
  }, 30_000);
});
