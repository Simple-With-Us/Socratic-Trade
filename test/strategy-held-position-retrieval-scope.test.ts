/**
 * Held-position retrieval scope (slug held-position-retrieval-scope). Ground truth: the three
 * retrieval scopes in strategy.ts — filings-RAG `topSymbols` (~top-3), learned-context
 * `learnedSymbols` (~top-8), and episodic `situationCandidates` (~top-3) — were built ONLY from
 * `marketScan.topCandidates`, which is SCORE-SORTED. A held (open) position that scores outside
 * those slices got ZERO retrieval, so sell/hold/trim decisions on it ran with no memory.
 *
 * This test seeds a portfolio with a held position ("ORCL") that scores below several
 * higher-momentum scan candidates — landing outside the top-3 and top-8 cutoffs — and asserts:
 *
 *  1. retrieveContextDetailed (filings RAG) is still called for ORCL, in ADDITION to the top-3.
 *  2. retrieveLearnedContextDetailed's symbol list includes ORCL, in ADDITION to the top-8.
 *  3. retrieveDecisionExperiences' `candidates` includes an ORCL entry, in ADDITION to the top-3.
 *  4. Regression: the top-N (BUY-candidate) symbols/order are unchanged, and a held symbol that
 *     IS already inside a slice does not trigger a second/duplicate retrieval call for itself.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

const mocks = vi.hoisted(() => ({
  retrieveContextDetailed: vi.fn(),
  retrieveLearnedContextDetailed: vi.fn(),
  retrieveDecisionExperiences: vi.fn()
}));

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
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

vi.mock("../src/lib/learned-context/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/learned-context/store")>();
  return { ...actual, retrieveLearnedContextDetailed: mocks.retrieveLearnedContextDetailed };
});

vi.mock("../src/lib/experience-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/experience-memory")>();
  return { ...actual, retrieveDecisionExperiences: mocks.retrieveDecisionExperiences };
});

// Fully-controlled broker gateway (as in test/synthetic-stops.test.ts): one held position, ORCL,
// that will score BELOW the other scan candidates (flat price action, low volume) so it lands
// outside the top-3/top-8 score-sorted slices while still being force-included in
// marketScan.topCandidates (market.ts heldExtra union).
const HELD_SYMBOL = "ORCL";
vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return {
    ...actual,
    getBrokerGateway: () => ({
      getAccounts: async () => [
        { accountNumber: "TEST", label: "Test broker", agenticAllowed: true, capabilities: { equityTrading: true, shortSelling: false, optionsTrading: false, futuresTrading: false, cryptoTrading: false, marginEnabled: false, accountType: "brokerage" } }
      ],
      getPortfolio: async () => ({
        accountNumber: "TEST",
        totalMarketValue: 20000,
        buyingPower: 10000,
        equityMarketValue: 10000,
        optionMarketValue: 0,
        cash: 10000
      }),
      getEquityPositions: async () => [
        { symbol: HELD_SYMBOL, quantity: 10, averageCost: 90, marketValue: 900 }
      ],
      getEquityOrders: async () => [],
      getEquityQuotes: async () => ({}),
      getEquityTradability: async (_accountNumber: string, symbols: string[]) =>
        Object.fromEntries(symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])),
      reviewEquityOrder: async () => ({ approved: true }),
      placeEquityOrder: async () => ({ orderId: "ord-1", status: "filled" }),
      cancelEquityOrder: async () => ({ orderId: "ord-1", status: "canceled" })
    })
  };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-held-retrieval-scope-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  mocks.retrieveContextDetailed.mockReset();
  mocks.retrieveLearnedContextDetailed.mockReset();
  mocks.retrieveDecisionExperiences.mockReset();
});

// 8 high-momentum scan candidates (strong positive % change + heavy volume) that will all
// out-score the flat, low-volume held position — filling the top-3 and top-8 slices without it.
const SCAN_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "AMD"];

function nasdaqRows(): Response {
  const rows = [
    ...SCAN_SYMBOLS.map((symbol, index) => ({
      symbol,
      lastsale: "$200",
      pctchange: `${20 - index}%`, // strong, descending momentum: AAPL highest, AMD lowest of the 8
      volume: `${5_000_000 - index * 100_000}`,
      marketCap: "3000000000000",
      sector: "Technology",
      industry: "Software"
    })),
    // The held symbol itself: flat price action, thin volume — scores at the bottom of the ranking.
    { symbol: HELD_SYMBOL, lastsale: "$90", pctchange: "0%", volume: "10000", marketCap: "200000000000", sector: "Technology", industry: "Software" }
  ];
  return new Response(
    JSON.stringify({ data: { asof: "2026-07-06", table: { rows } } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("strategy.ts held-position retrieval scope", () => {
  it("widens filings-RAG, learned-context, and episodic retrieval to held positions outside the top-N slice", async () => {
    mocks.retrieveContextDetailed.mockResolvedValue([]);
    mocks.retrieveLearnedContextDetailed.mockReturnValue({ lines: [], rows: [] });
    mocks.retrieveDecisionExperiences.mockResolvedValue({
      analogsBlock: "",
      coachingBlock: "",
      analogChunks: [],
      coachingChunks: [],
      injected: [],
      asOf: new Date().toISOString(),
      query: "situation sketch"
    });

    // The nasdaq screener response is cached in-module by TTL (screenerCache in market.ts) —
    // without clearing it, this test would silently reuse the OTHER test's cached rows/scores.
    const { clearMarketCache } = await import("../src/lib/market");
    clearMarketCache();

    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals: [] }) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("nasdaq.com")) return nasdaqRows();
      return new Response("not found", { status: 404 });
    });

    const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Held Retrieval Scope Test", isActive: true });
    setActiveConnectedAccount(accountId);
    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: SCAN_SYMBOLS,
      strategyAuthority: "decide"
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    await runStrategyOnce();

    // ── Regression: BUY-candidate top-N scan set is unchanged (score-sorted, held symbol NOT
    // reordered into it — it stays outside because it genuinely scores lowest). ──
    const learnedCallArgs = mocks.retrieveLearnedContextDetailed.mock.calls[0] as
      | [string, string[], string | undefined, { thesisTags?: Set<string> }]
      | undefined;
    expect(learnedCallArgs).toBeDefined();
    const [, learnedSymbols] = learnedCallArgs!;
    const top8 = SCAN_SYMBOLS.slice(0, 8);
    for (const sym of top8) expect(learnedSymbols).toContain(sym);
    // Held symbol is unioned in ADDITIONALLY, not swapped in place of a top-8 name.
    expect(learnedSymbols).toContain(HELD_SYMBOL);
    expect(learnedSymbols.length).toBe(top8.length + 1);
    expect(learnedCallArgs?.[3]).toHaveProperty("thesisTags");

    // ── 1. Filings RAG: retrieveContextDetailed was called for the held symbol. ──
    const filingsSymbolsQueried = mocks.retrieveContextDetailed.mock.calls.map((call) => call[1] as string);
    expect(filingsSymbolsQueried).toContain(HELD_SYMBOL);
    // And the top-3 highest-momentum names are still queried too (additive, not replaced).
    for (const sym of SCAN_SYMBOLS.slice(0, 3)) expect(filingsSymbolsQueried).toContain(sym);
    // No duplicate retrieval call for the held symbol (it's outside the top-3 here, so exactly one).
    expect(filingsSymbolsQueried.filter((sym) => sym === HELD_SYMBOL).length).toBe(1);

    // ── 2. Learned-context symbol list includes the held symbol (asserted above). ──

    // ── 3. Episodic candidates include an entry for the held symbol. ──
    expect(mocks.retrieveDecisionExperiences).toHaveBeenCalledTimes(1);
    const episodicInput = mocks.retrieveDecisionExperiences.mock.calls[0]![0] as {
      regime: string;
      candidates: Array<{ symbol: string; held?: boolean }>;
    };
    const episodicSymbols = episodicInput.candidates.map((c) => c.symbol);
    expect(episodicSymbols).toContain(HELD_SYMBOL);
    for (const sym of SCAN_SYMBOLS.slice(0, 3)) expect(episodicSymbols).toContain(sym);
    // Additive: top-3 plus exactly one held addition, no duplicate.
    expect(episodicSymbols.length).toBe(4);
    expect(episodicSymbols.filter((sym) => sym === HELD_SYMBOL).length).toBe(1);
    // The held candidate appended past the top-3 must be flagged `held: true` — that's what lets
    // buildSituationSketch fold it into the episodic query text instead of silently dropping it
    // (the bug this test suite was originally missing: candidates reaching the RETRIEVAL CALL is
    // necessary but not sufficient — they must also reach the SKETCH TEXT the query is built from).
    const heldEntry = episodicInput.candidates.find((c) => c.symbol === HELD_SYMBOL);
    expect(heldEntry?.held).toBe(true);

    // Only retrieveDecisionExperiences itself is mocked in this file — buildSituationSketch is the
    // real implementation, so we can prove the held symbol actually reaches the sketch/query text
    // an unmocked call would send, not just the candidates array handed to the (mocked) retriever.
    const { buildSituationSketch } = await import("../src/lib/experience-memory");
    const realSketch = buildSituationSketch(episodicInput);
    expect(realSketch).toContain(HELD_SYMBOL);
    for (const sym of SCAN_SYMBOLS.slice(0, 3)) expect(realSketch).toContain(sym);
  }, 30_000);

  it("does not issue a duplicate retrieval call when the held symbol is already inside the top slice", async () => {
    mocks.retrieveContextDetailed.mockResolvedValue([]);
    mocks.retrieveLearnedContextDetailed.mockReturnValue({ lines: [], rows: [] });
    mocks.retrieveDecisionExperiences.mockResolvedValue({
      analogsBlock: "",
      coachingBlock: "",
      analogChunks: [],
      coachingChunks: [],
      injected: [],
      asOf: new Date().toISOString(),
      query: "situation sketch"
    });

    // Clear the module-level nasdaq-screener cache so this test doesn't reuse the first test's
    // cached rows/scores (see the same call in the first test above).
    const { clearMarketCache } = await import("../src/lib/market");
    clearMarketCache();

    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals: [] }) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("nasdaq.com")) {
        // Held symbol is now the STRONGEST performer — lands inside the top-3/top-8 slice. All 8
        // scan symbols get IDENTICAL flat/mild numbers (no internal competition noise between
        // them), while ORCL alone gets a heavy liquidity (volume) edge with only a mild intraday
        // move — enough to outscore them on liquidity+momentum despite the diversification-factor
        // penalty every held position takes (verified against the real scoring formula).
        const rows = [
          { symbol: HELD_SYMBOL, lastsale: "$90", pctchange: "2%", volume: "50000000", marketCap: "3000000000000", sector: "Technology", industry: "Software" },
          ...SCAN_SYMBOLS.map((symbol) => ({
            symbol,
            lastsale: "$200",
            pctchange: "1%",
            volume: "1000000",
            marketCap: "3000000000000",
            sector: "Technology",
            industry: "Software"
          }))
        ];
        return new Response(JSON.stringify({ data: { asof: "2026-07-06", table: { rows } } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("not found", { status: 404 });
    });

    const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Held Retrieval Scope Dedup Test", isActive: true });
    setActiveConnectedAccount(accountId);
    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: SCAN_SYMBOLS,
      strategyAuthority: "decide"
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    await runStrategyOnce();

    const filingsSymbolsQueried = mocks.retrieveContextDetailed.mock.calls.map((call) => call[1] as string);
    // Held symbol now ranks inside the top-3, so it's already covered there — exactly one call, no dup.
    expect(filingsSymbolsQueried).toContain(HELD_SYMBOL);
    expect(filingsSymbolsQueried.filter((sym) => sym === HELD_SYMBOL).length).toBe(1);

    const episodicInput = mocks.retrieveDecisionExperiences.mock.calls[0]![0] as {
      candidates: Array<{ symbol: string }>;
    };
    const episodicSymbols = episodicInput.candidates.map((c) => c.symbol);
    expect(episodicSymbols.filter((sym) => sym === HELD_SYMBOL).length).toBe(1);
    expect(episodicSymbols.length).toBe(3);

    const learnedCallArgs = mocks.retrieveLearnedContextDetailed.mock.calls[0] as [string, string[]] | undefined;
    const [, learnedSymbols] = learnedCallArgs!;
    expect(learnedSymbols.filter((sym) => sym === HELD_SYMBOL).length).toBe(1);
    expect(learnedSymbols.length).toBe(8);
  }, 30_000);
});
