/**
 * Episodic experience memory (2026-07-04 composite expert review, section A item 1 — [Both]).
 *
 * Covers the review's required test surface:
 *  1. write hook — a closing (sell) fill through `recordFillFromProposal` embeds a closed-lot
 *     experience document (state vector text + realized-outcome metadata, keyed by the ENTRY
 *     proposalId) via `storeContexts`;
 *  2. situation-sketch query shape — regime + candidate factor/evidence summary, NOT the generic
 *     filings query;
 *  3. same-run exclusion — neighbors stamped with the current runId (entry OR exit side) never
 *     come back into the same run's prompt;
 *  4. as-of stamping — retrieval passes `asOf` through to the vector store and stamps the result;
 *  5. counterexample labeling — nearest priors with opposite realized sign are labeled, not hidden.
 *
 * The Bull/Bear payload-parity integration test lives in
 * test/strategy-episodic-injection.test.ts (LLM stubbed).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MarketScan, TradeProposal } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  storeContexts: vi.fn(async () => ({ attempted: 1, indexed: 1 })),
  retrieveContextDetailed: vi.fn(async () => [] as unknown[])
}));

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  storeContexts: mocks.storeContexts,
  storeContext: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: mocks.retrieveContextDetailed,
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.35,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string; doc_type?: string }, symbol?: string) =>
    `[${(chunk.doc_type ?? "context").toUpperCase()}${symbol ? ` · ${symbol}` : ""}]\n${chunk.text}`
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-experience-memory-${randomUUID()}.db`)}`;
});

afterEach(() => {
  mocks.storeContexts.mockClear();
  mocks.retrieveContextDetailed.mockReset();
  mocks.retrieveContextDetailed.mockResolvedValue([]);
  vi.unstubAllEnvs();
});

const FACTORS = {
  liquidity: 5,
  momentum: 90,
  value: 20,
  quality: 10,
  volatility: 12,
  sentiment: 15,
  positioning: 30,
  diversification: 5,
  weightedTotal: 61
};

function scanFor(symbol: string, price: number): MarketScan {
  return {
    source: "test",
    generatedAt: new Date().toISOString(),
    scannedSymbols: 1,
    returnedQuotes: 1,
    breadthPct: 62.5,
    topCandidates: [
      {
        symbol,
        price,
        volume: 1_000_000,
        intradayChangePct: 1.2,
        positionMarketValue: 0,
        score: 61,
        sector: "Technology",
        factorBreakdown: { ...FACTORS }
      }
    ],
    sectorBySymbol: { [symbol]: "Technology" },
    quotesBySymbol: { [symbol]: { symbol, price, score: 61, sector: "Technology" } },
    warnings: []
  };
}

function proposal(input: Partial<TradeProposal> & Pick<TradeProposal, "symbol" | "side">): TradeProposal {
  return {
    type: "limit",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "test rationale",
    tradeThesisTag: "Momentum Breakout",
    entryMarketRegime: "Risk-On",
    ...input
  } as TradeProposal;
}

describe("closed-lot write hook (recordFillFromProposal → recordClosedLotExperience)", () => {
  it("embeds a state-vector document with realized outcome metadata, keyed by the entry proposalId", async () => {
    vi.stubEnv("PAPER_EXECUTION_COST_MODEL", "off");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    const account = `EXP-${randomUUID().slice(0, 8)}`;

    // ENTRY: buy 10 @ 100. recordFillFromProposal stamps the 8-factor breakdown + breadth into raw.
    recordFillFromProposal({
      accountNumber: account,
      source: "paper",
      proposalId: "prop-entry-1",
      runId: "run-entry-1",
      proposal: proposal({
        symbol: "NVDA",
        side: "buy",
        quantity: 10,
        limitPrice: 100,
        rationale: "Momentum breakout with congress accumulation",
        confidenceScore: 82
      }),
      marketScan: scanFor("NVDA", 100)
    });
    // Distinct filledAt for deterministic FIFO ordering (fills are ms-resolution timestamps).
    await new Promise((resolve) => setTimeout(resolve, 15));

    // EXIT: sell 10 @ 110 under a mechanical risk-exit tag → riskExit=true, returnPct=+10.
    recordFillFromProposal({
      accountNumber: account,
      source: "paper",
      proposalId: "prop-exit-1",
      runId: "run-exit-1",
      proposal: proposal({
        symbol: "NVDA",
        side: "sell",
        quantity: 10,
        limitPrice: 110,
        tradeThesisTag: "Risk-Exit",
        entryMarketRegime: "Active Risk Check",
        rationale: "Proactive stop discipline"
      }),
      marketScan: scanFor("NVDA", 110)
    });

    await vi.waitFor(() => expect(mocks.storeContexts).toHaveBeenCalled());

    const [documents, userId, options] = mocks.storeContexts.mock.calls[0]! as unknown as [
      Array<{ text: string; metadata: Record<string, unknown> }>,
      string,
      { dedupKeyPrefix?: string; scope?: string }
    ];
    expect(userId).toBe("local");
    expect(options?.dedupKeyPrefix).toBe("experience-memory");
    expect(options?.scope).toBe("private");
    expect(documents).toHaveLength(1);
    const doc = documents[0]!;

    // State vector text: factor sub-scores + regime + thesis + sector + macro snapshot + rationale.
    expect(doc.text).toContain("Experience memory: closed lot with realized outcome");
    expect(doc.text).toContain("thesis_tag: Momentum Breakout");
    expect(doc.text).toContain("entry_market_regime: Risk-On");
    expect(doc.text).toContain("sector: Technology");
    expect(doc.text).toContain("momentum=90");
    expect(doc.text).toContain("market_breadth_pct=62.5");
    expect(doc.text).toContain("Momentum breakout with congress accumulation");
    expect(doc.text).toContain("return_pct=10");
    expect(doc.text).toContain("risk_exit=true");

    // Metadata: retrievable under the episodic doc_type, keyed by the ENTRY proposal, with
    // realized outcome + run ids for exclusion/labeling at retrieval time.
    expect(doc.metadata).toMatchObject({
      symbol: "NVDA",
      source: "experience-memory",
      doc_type: "socratic-decision",
      memory_kind: "experience",
      proposal_id: "prop-entry-1",
      exit_proposal_id: "prop-exit-1",
      run_id: "run-entry-1",
      exit_run_id: "run-exit-1",
      thesis_tag: "Momentum Breakout",
      entry_market_regime: "Risk-On",
      sector: "Technology",
      side: "long",
      risk_exit: true,
      confidence: 82,
      factor_momentum: 90,
      factor_liquidity: 5
    });
    expect(doc.metadata.return_pct).toBeCloseTo(10, 5);
    expect(typeof doc.metadata.holding_days).toBe("number");
    expect(String(doc.metadata.accession)).toBe("exp:prop-entry-1:prop-exit-1");
  });

  it("does not embed anything for an opening (buy) fill", async () => {
    const { recordFillFromProposal } = await import("../src/lib/performance");
    const account = `EXP-${randomUUID().slice(0, 8)}`;
    recordFillFromProposal({
      accountNumber: account,
      source: "paper",
      proposalId: "prop-open-only",
      proposal: proposal({ symbol: "AAPL", side: "buy", quantity: 1, limitPrice: 200 }),
      marketScan: scanFor("AAPL", 200)
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mocks.storeContexts).not.toHaveBeenCalled();
  });

  it("is disabled by EXPERIENCE_MEMORY=off", async () => {
    vi.stubEnv("EXPERIENCE_MEMORY", "off");
    const { recordClosedLotExperience } = await import("../src/lib/experience-memory");
    const result = await recordClosedLotExperience({
      accountNumber: "ANY",
      source: "paper",
      closingFill: {
        id: "f1",
        accountNumber: "ANY",
        source: "paper",
        symbol: "AAPL",
        side: "sell",
        quantity: 1,
        price: 100,
        notional: 100,
        status: "filled",
        filledAt: new Date().toISOString()
      },
      closingProposal: proposal({ symbol: "AAPL", side: "sell" })
    });
    expect(result).toBeNull();
    expect(mocks.storeContexts).not.toHaveBeenCalled();
  });
});

describe("situation-sketch query shape", () => {
  it("carries regime + candidate factor/sector/evidence, and is NOT the generic filings query", async () => {
    const { buildSituationSketch } = await import("../src/lib/experience-memory");
    const sketch = buildSituationSketch({
      regime: "Risk-Off (High Volatility)",
      candidates: [
        {
          symbol: "nvda",
          sector: "Technology",
          dominantFactor: "momentum",
          evidence: ["3 senators bought in the last 30 days", "Insider cluster buying"]
        }
      ]
    });
    expect(sketch).toContain("market regime Risk-Off (High Volatility)");
    expect(sketch).toContain("NVDA");
    expect(sketch).toContain("sector Technology");
    expect(sketch).toContain("dominant factor momentum");
    expect(sketch).toContain("3 senators bought in the last 30 days");
    // Distinct from the filings pass query built in strategy.ts.
    expect(sketch).not.toContain("Significant financial events, SEC filings, and macro catalysts");
  });

  it("drops candidates beyond index 3 when none are marked held (regression: non-held path unchanged)", async () => {
    const { buildSituationSketch } = await import("../src/lib/experience-memory");
    const sketch = buildSituationSketch({
      regime: "Neutral",
      candidates: [
        { symbol: "AAPL" },
        { symbol: "MSFT" },
        { symbol: "GOOGL" },
        { symbol: "AMZN" } // index 3, not held — must NOT appear (byte-identical to slice(0, 3))
      ]
    });
    expect(sketch).toContain("AAPL");
    expect(sketch).toContain("MSFT");
    expect(sketch).toContain("GOOGL");
    expect(sketch).not.toContain("AMZN");
  });

  it("includes a held candidate beyond the top-3 cutoff (held-position retrieval scope fix)", async () => {
    const { buildSituationSketch } = await import("../src/lib/experience-memory");
    const sketch = buildSituationSketch({
      regime: "Neutral",
      candidates: [
        { symbol: "AAPL" },
        { symbol: "MSFT" },
        { symbol: "GOOGL" },
        { symbol: "ORCL", sector: "Technology", held: true } // held, appended past top-3
      ]
    });
    expect(sketch).toContain("AAPL");
    expect(sketch).toContain("MSFT");
    expect(sketch).toContain("GOOGL");
    expect(sketch).toContain("ORCL");
    expect(sketch).toContain("sector Technology");
  });

  it("caps total candidates folded into the sketch so a large held book can't unbound the query", async () => {
    const { buildSituationSketch } = await import("../src/lib/experience-memory");
    const heldSymbols = ["ORCL", "IBM", "CSCO", "INTC", "QCOM"]; // 5 held, only 3 fit the budget (6 - 3 top)
    const sketch = buildSituationSketch({
      regime: "Neutral",
      candidates: [
        { symbol: "AAPL" },
        { symbol: "MSFT" },
        { symbol: "GOOGL" },
        ...heldSymbols.map((symbol) => ({ symbol, held: true }))
      ]
    });
    const includedHeld = heldSymbols.filter((symbol) => sketch.includes(symbol));
    expect(includedHeld.length).toBe(3);
    // First-in-order held candidates win the budget (deterministic, not arbitrary).
    expect(sketch).toContain("ORCL");
    expect(sketch).toContain("IBM");
    expect(sketch).toContain("CSCO");
    expect(sketch).not.toContain("INTC");
    expect(sketch).not.toContain("QCOM");
  });
});

describe("decision-time retrieval (retrieveDecisionExperiences)", () => {
  const baseChunk = {
    text: "Socratic institutional memory case",
    score: 0.8,
    source: "experience-memory",
    doc_type: "socratic-decision"
  };

  it("queries the episodic doc types cross-symbol with an as-of stamp, and excludes same-run neighbors", async () => {
    const runId = "run-current";
    mocks.retrieveContextDetailed.mockResolvedValue([
      { ...baseChunk, id: "same-entry-run", metadata: { run_id: runId, return_pct: 5 } },
      { ...baseChunk, id: "same-exit-run", metadata: { exit_run_id: runId, return_pct: 5 } },
      { ...baseChunk, id: "prior-winner", score: 0.77, metadata: { run_id: "run-old", return_pct: 8.2, symbol: "MSFT" } },
      { ...baseChunk, id: "prior-loser", score: 0.71, metadata: { run_id: "run-old-2", return_pct: -4.1, symbol: "AMD" } },
      { ...baseChunk, id: "coach-1", doc_type: "coach-note", score: 0.66, metadata: { symbol: "NVDA" }, text: "Stop selling winners early." }
    ]);

    const { retrieveDecisionExperiences } = await import("../src/lib/experience-memory");
    const asOf = "2026-07-04T12:00:00.000Z";
    const result = await retrieveDecisionExperiences({
      userId: "local",
      runId,
      connectedAccountId: "account-a",
      regime: "Risk-On",
      candidates: [{ symbol: "NVDA", sector: "Technology", dominantFactor: "momentum" }],
      asOf
    });

    // Query/options shape: situation sketch + episodic doc types + cross-symbol + as-of.
    const [query, , , , options] = mocks.retrieveContextDetailed.mock.calls[0]! as unknown as [
      string,
      string,
      number,
      string,
      { docType?: string[]; matchAllSymbols?: boolean; asOf?: string; connectedAccountId?: string; accountScope?: string }
    ];
    expect(query).toContain("market regime Risk-On");
    expect(options.docType).toEqual(["socratic-decision", "coach-note", "lesson"]);
    expect(options.matchAllSymbols).toBe(true);
    expect(options.asOf).toBe(asOf);
    expect(options.connectedAccountId).toBe("account-a");
    expect(options.accountScope).toBe("exact");

    // Same-run neighbors (entry OR exit side) are excluded — no self-retrieval, no lookahead.
    const injectedIds = result.injected.map((ref) => ref.id);
    expect(injectedIds).not.toContain("same-entry-run");
    expect(injectedIds).not.toContain("same-exit-run");
    expect(injectedIds).toEqual(expect.arrayContaining(["prior-winner", "prior-loser", "coach-1"]));

    // As-of stamped on the result and printed in the block header.
    expect(result.asOf).toBe(asOf);
    expect(result.analogsBlock).toContain(`as of ${asOf}`);

    // Top-analog similarity shown; opposite-realized-sign prior labeled COUNTEREXAMPLE.
    expect(result.topAnalogSimilarity).toBeCloseTo(0.77, 5);
    expect(result.analogsBlock).toContain("top-analog similarity 0.77");
    expect(result.analogsBlock).toContain("[COUNTEREXAMPLE — opposite realized sign]");
    expect(result.analogsBlock).toContain("ANALOG MSFT");
    expect(result.analogsBlock).toContain("return_pct 8.2");
    expect(result.analogsBlock).toContain("ANALOG AMD");
    expect(result.analogsBlock).not.toContain("[SOCRATIC-DECISION");
    expect(result.injected.find((ref) => ref.id === "prior-loser")?.counterexample).toBe(true);
    expect(result.injected.find((ref) => ref.id === "prior-winner")?.counterexample).toBeUndefined();

    // Coaching split into its own labeled block.
    expect(result.coachingBlock).toContain("OWNER COACHING");
    expect(result.coachingBlock).toContain("Stop selling winners early.");
    expect(result.injected.find((ref) => ref.id === "coach-1")?.kind).toBe("coaching");
  });

  it("returns an empty result (no blocks) when nothing is retrieved", async () => {
    const { retrieveDecisionExperiences } = await import("../src/lib/experience-memory");
    const result = await retrieveDecisionExperiences({
      userId: "local",
      runId: "run-x",
      regime: "Unknown",
      candidates: []
    });
    expect(result.analogsBlock).toBeUndefined();
    expect(result.coachingBlock).toBeUndefined();
    expect(result.injected).toEqual([]);
    expect(typeof result.asOf).toBe("string");
  });

  it("reserves one COUNTEREXAMPLE analog from the over-ask set when the top-k are all winners", async () => {
    const winners = Array.from({ length: 6 }, (_, i) => ({
      ...baseChunk,
      id: `win-${i}`,
      score: 0.9 - i * 0.01,
      metadata: { run_id: "run-old", return_pct: 4 + i, symbol: "MSFT", side: "long" }
    }));
    const loser = {
      ...baseChunk,
      id: "reserved-loser",
      score: 0.51,
      text: "Similar setup reversed after a risk-off tape.",
      metadata: { run_id: "run-old-2", return_pct: -6.1, symbol: "AMD", side: "long", holding_days: 9, risk_exit: true }
    };
    mocks.retrieveContextDetailed.mockResolvedValue([...winners, loser]);

    const { retrieveDecisionExperiences } = await import("../src/lib/experience-memory");
    const result = await retrieveDecisionExperiences({
      userId: "local",
      runId: "run-current",
      regime: "Risk-On",
      candidates: [{ symbol: "NVDA" }],
      k: 5
    });

    expect(result.injected.find((ref) => ref.id === "reserved-loser")?.counterexample).toBe(true);
    expect(result.injected.some((ref) => ref.id === "win-4")).toBe(false);
    expect(result.analogsBlock).toContain("[COUNTEREXAMPLE — opposite realized sign]");
    expect(result.analogsBlock).toContain("ANALOG AMD long");
    expect(result.analogsBlock).toContain("return_pct -6.1");
    expect(result.analogsBlock).toContain("risk_exit yes");
  });
});

/**
 * ST-4539 — past-decision case affinity, integrated into the live retrieval pass.
 *
 * The unit surface for the weighting itself lives in test/past-decision-cases.test.ts. These two
 * cases pin the WIRING, which is the part that can silently regress: the re-rank must sit between
 * the usefulness re-rank and the top-k slice, and it must leave the retrieval call shape itself
 * (one query, cross-symbol, same deadline) untouched.
 */
describe("past-decision case affinity wiring (ST-4539)", () => {
  const baseChunk = {
    text: "Experience memory: closed lot with realized outcome",
    score: 0.8,
    source: "experience-memory",
    doc_type: "socratic-decision"
  };

  it("lifts a same-symbol prior into the prompt ahead of a higher-scoring cross-symbol analog", async () => {
    // Incoming order is pure vector similarity: MSFT (0.9) then AMD (0.5), with AAPL last (0.45).
    mocks.retrieveContextDetailed.mockResolvedValue([
      { ...baseChunk, id: "cross-msft", score: 0.9, metadata: { symbol: "MSFT", return_pct: 3, run_id: "old-1" } },
      { ...baseChunk, id: "cross-amd", score: 0.5, metadata: { symbol: "AMD", return_pct: 2, run_id: "old-2" } },
      {
        ...baseChunk,
        id: "same-aapl",
        score: 0.45,
        metadata: {
          symbol: "AAPL",
          return_pct: -5,
          run_id: "old-3",
          thesis_tag: "Momentum-Breakout",
          entry_market_regime: "Risk-On"
        },
        text: "Experience memory: closed lot with realized outcome\nticker: AAPL\nrealized_outcome: return_pct=-5; holding_days=4.0; risk_exit=true"
      }
    ]);

    const { retrieveDecisionExperiences } = await import("../src/lib/experience-memory");
    const result = await retrieveDecisionExperiences({
      userId: "local",
      runId: "run-current",
      regime: "Risk-On",
      candidates: [{ symbol: "AAPL", sector: "Technology", dominantFactor: "momentum" }]
    });

    const analogIds = result.analogChunks.map((chunk) => chunk.id);
    // The AAPL case wins the prompt slot despite ranking LAST on similarity — that is the whole
    // point of the issue: a prior on the ticker being decided is the most relevant thing available.
    expect(analogIds[0]).toBe("same-aapl");
    // Still cross-symbol: nothing was excluded, and the outcome rides along for the proposer.
    expect(analogIds).toEqual(expect.arrayContaining(["cross-msft", "same-aapl"]));
    expect(result.analogsBlock).toContain("ANALOG AAPL");
    expect(result.analogsBlock).toContain("return_pct -5");
    // A same-symbol LOSER is surfaced as dissent, not buried — selection is not endorsement.
    expect(result.injected.find((ref) => ref.id === "same-aapl")?.counterexample).toBe(true);
    // The affinity re-rank put the 0.45 case first, but "top-analog similarity" in the header and
    // the audit record must still report the closest shown analog (MSFT, 0.90), not the first card.
    expect(result.topAnalogSimilarity).toBeCloseTo(0.9, 5);
    expect(result.analogsBlock).toContain("top-analog similarity 0.90");
  });

  it("adds no retrieval call and changes nothing when the off-switch is off", async () => {
    vi.stubEnv("PAST_DECISION_CASE_AFFINITY", "off");
    mocks.retrieveContextDetailed.mockResolvedValue([
      { ...baseChunk, id: "cross-msft", score: 0.9, metadata: { symbol: "MSFT", return_pct: 3, run_id: "old-1" } },
      { ...baseChunk, id: "same-aapl", score: 0.45, metadata: { symbol: "AAPL", return_pct: 1, run_id: "old-2" } }
    ]);

    const { retrieveDecisionExperiences } = await import("../src/lib/experience-memory");
    const result = await retrieveDecisionExperiences({
      userId: "local",
      runId: "run-current",
      regime: "Risk-On",
      candidates: [{ symbol: "AAPL" }]
    });

    // Incoming similarity order preserved exactly.
    expect(result.analogChunks.map((chunk) => chunk.id)).toEqual(["cross-msft", "same-aapl"]);
    // Exactly ONE retrieval call — the affinity pass is a pure in-memory reorder, so the strategy
    // run's retrieval deadline and the vector store's query budget are unchanged.
    expect(mocks.retrieveContextDetailed).toHaveBeenCalledTimes(1);
  });

  it("still retrieves exactly one query under the default (on) flag", async () => {
    mocks.retrieveContextDetailed.mockResolvedValue([
      { ...baseChunk, id: "same-aapl", score: 0.4, metadata: { symbol: "AAPL", return_pct: 1, run_id: "old-1" } },
      { ...baseChunk, id: "cross-msft", score: 0.9, metadata: { symbol: "MSFT", return_pct: 1, run_id: "old-2" } }
    ]);
    const { retrieveDecisionExperiences } = await import("../src/lib/experience-memory");
    await retrieveDecisionExperiences({
      userId: "local",
      runId: "run-current",
      regime: "Risk-On",
      candidates: [{ symbol: "AAPL" }]
    });
    expect(mocks.retrieveContextDetailed).toHaveBeenCalledTimes(1);
  });
});

describe("formatAnalogCard", () => {
  it("packs situation + outcome scalars without dumping SocraticDecisionCase JSON", async () => {
    const { formatAnalogCard } = await import("../src/lib/experience-memory");
    const dump = JSON.stringify({
      id: "case-1",
      symbol: "AAPL",
      side: "buy",
      thesisTag: "Momentum-Breakout",
      regime: "risk-off",
      greenTeamRationale: "Breakout versus weak breadth; size was 1.2% NAV.",
      redTeamVerdict: { verdict: "approve", reason: "ok" },
      ragAttributions: Array.from({ length: 12 }, (_, i) => ({
        source: "10-k",
        text: `filing blob ${i} ${"x".repeat(80)}`
      })),
      evidence: Array.from({ length: 8 }, (_, i) => ({ title: `e${i}`, summary: "y".repeat(60) })),
      policyDecision: { approved: true, reasons: [] },
      outcome: { returnPct: -4.2, status: "closed" }
    });
    const card = formatAnalogCard({
      id: "c1",
      text: dump,
      score: 0.81,
      doc_type: "socratic-decision",
      metadata: {
        symbol: "AAPL",
        side: "long",
        return_pct: -4.2,
        holding_days: 11,
        risk_exit: true,
        entry_market_regime: "risk-off",
        thesis_tag: "Momentum-Breakout",
        sector: "Technology"
      }
    });
    expect(card).toMatch(/^ANALOG AAPL long \|/);
    expect(card).toContain("return_pct -4.2");
    expect(card).toContain("holding_days 11");
    expect(card).toContain("risk_exit yes");
    expect(card).toContain("regime risk-off");
    expect(card).toContain("situation: Technology");
    expect(card).toContain("rationale: Breakout versus weak breadth");
    expect(card).not.toContain("ragAttributions");
    expect(card).not.toContain("redTeamVerdict");
    expect(card).not.toContain("policyDecision");
    expect(card).not.toContain(dump.slice(0, 80));
    expect(card.length).toBeLessThanOrEqual(1500);
    expect(card.split("\n").length).toBeLessThanOrEqual(12);
  });

  it("compacts closed-lot experience text and prefers camelCase metadata aliases", async () => {
    const { formatAnalogCard } = await import("../src/lib/experience-memory");
    const longRationale = `Momentum breakout with congress accumulation. ${"edge ".repeat(120)}`;
    const card = formatAnalogCard({
      id: "e1",
      score: 0.7,
      doc_type: "socratic-decision",
      text: [
        "Experience memory: closed lot with realized outcome",
        "ticker: NVDA",
        "side: long",
        "thesis_tag: Momentum-Breakout",
        "entry_market_regime: Risk-On",
        "sector: Technology",
        "entry_factor_scores: momentum=90 value=20",
        "macro_snapshot_at_entry: market_breadth_pct=62.5",
        `entry_rationale: ${longRationale}`,
        "realized_outcome: return_pct=10; holding_days=3.2; risk_exit=true"
      ].join("\n"),
      metadata: {
        symbol: "NVDA",
        side: "long",
        realizedReturnPct: 10,
        holdingDays: 3.2,
        riskExit: true,
        thesis: "Momentum-Breakout",
        regime: "Risk-On"
      }
    });
    expect(card).toContain("ANALOG NVDA long");
    expect(card).toContain("return_pct 10");
    expect(card).toContain("holding_days 3.2");
    expect(card).toContain("risk_exit yes");
    expect(card).toContain("situation: Technology; momentum=90 value=20");
    expect(card).toContain("rationale: Momentum breakout with congress accumulation");
    expect(card).not.toContain("Experience memory: closed lot");
    expect(card.length).toBeLessThanOrEqual(1500);
    const rationaleLine = card.split("\n").find((line) => line.startsWith("rationale:"));
    expect(rationaleLine).toBeDefined();
    expect(rationaleLine!.length).toBeLessThanOrEqual("rationale: ".length + 400 + 1);
  });
});
