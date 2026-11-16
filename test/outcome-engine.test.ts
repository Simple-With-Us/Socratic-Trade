import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OHLCBar } from "../src/lib/indicators";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-outcome-engine-${randomUUID()}.db`)}`;
});

// Capture every vector-memory re-index (the lifecycle hook) without Pinecone/Voyage credentials.
const storeContextsCalls: Array<{ documents: Array<{ text: string }>; options?: { dedupKeyPrefix?: string; scope?: string } }> = [];
vi.mock("../src/lib/vector-db", () => ({
  getCurrentVectorProviderAuthority: async () => "provider:test",
  managedVectorLedgerAuthority: () => "ledger:test",
  storeContexts: async (documents: Array<{ text: string }>, _userId?: string, options?: { dedupKeyPrefix?: string; scope?: string }) => {
    storeContextsCalls.push({ documents, options });
    return { attempted: documents.length, indexed: documents.length };
  }
}));

/** Symbol-aware daily-bar stub: AAPL/MSFT/SPY get series; unknown symbols get null (no series). */
function makeFetchOHLC(bySymbol: Record<string, OHLCBar[] | null>) {
  return async (symbol: string): Promise<OHLCBar[] | null> => bySymbol[symbol] ?? null;
}

const AAPL_BARS: OHLCBar[] = [
  { time: "2026-06-10", close: 100 },
  { time: "2026-06-11", close: 104 },
  { time: "2026-06-17", close: 115 }
];
const MSFT_BARS: OHLCBar[] = [
  { time: "2026-06-11", close: 51 },
  { time: "2026-06-17", close: 55 }
];
const SPY_BARS: OHLCBar[] = [
  { time: "2026-06-10", close: 500 },
  { time: "2026-06-11", close: 505 },
  { time: "2026-06-17", close: 510 }
];

const NOW = Date.parse("2026-06-20T00:00:00.000Z");

describe("outcome engine — the outcome writer", () => {
  it("includes filled decision cases in outcome-coverage denominators", async () => {
    const userId = `oe-filled-coverage-${randomUUID()}`;
    const { getSocraticOutcomeCoverage, upsertSocraticDecisionCase } = await import("../src/lib/db");
    upsertSocraticDecisionCase({
      userId,
      proposalId: `filled-${randomUUID()}`,
      symbol: "EXE",
      side: "buy",
      status: "filled",
      authority: "decide",
      thesis: "Value-Quality",
      rationale: "Filled-case coverage regression.",
      action: "BUY EXE $4"
    });

    expect(getSocraticOutcomeCoverage(userId)).toMatchObject({ totalMeasurable: 1, open: 1 });
  });

  it("matures a PLACED decision: joins the fill + closed lot, writes multi-horizon outcome, receipts, re-indexes", async () => {
    // Clear cross-test capture so every() assertions only see this case's re-index calls.
    storeContextsCalls.length = 0;
    const userId = `oe-placed-${randomUUID()}`;
    const { insertFillEvent, listAudit, upsertConnectedAccount, upsertSocraticDecisionCase, getSocraticDecisionCase } = await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");
    const connectedAccountId = randomUUID();
    upsertConnectedAccount({
      id: connectedAccountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "acct",
      label: "Outcome fixture",
      isActive: true
    });

    upsertSocraticDecisionCase({
      userId,
      connectedAccountId,
      runId: "run-1",
      proposalId: "prop-1",
      accountNumber: "acct",
      symbol: "AAPL",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum",
      rationale: "Breakout with volume.",
      action: "BUY AAPL $1000",
      thesisTag: "Momentum",
      regime: "Risk-On"
    });
    insertFillEvent({
      userId,
      proposalId: "prop-1",
      runId: "run-1",
      accountNumber: "acct",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 100,
      notional: 1000,
      status: "filled",
      filledAt: "2026-06-10T14:30:00.000Z"
    });
    insertFillEvent({
      userId,
      proposalId: "prop-1-exit",
      runId: "run-9",
      accountNumber: "acct",
      source: "paper",
      symbol: "AAPL",
      side: "sell",
      quantity: 10,
      price: 110,
      notional: 1100,
      status: "filled",
      filledAt: "2026-06-16T14:30:00.000Z"
    });

    const result = await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ AAPL: AAPL_BARS, SPY: SPY_BARS }),
      fetchQuote: async () => undefined,
      llm: async () =>
        JSON.stringify({
          lessons: [{ lesson: "Momentum breakouts in Risk-On conditions worked; repeat the setup.", direction: "repeat" }],
          verdictOnBelief: "The belief was right.",
          whichDissentMattered: "none"
        })
    });

    expect(result.scanned).toBe(1);
    expect(result.measured).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.unresolvable).toBe(0);
    expect(result.lessonsWritten).toBe(1);

    const updated = getSocraticDecisionCase("prop-1", userId);
    expect(updated?.outcome?.status).toBe("won");
    expect(updated?.outcome?.pnlUsd).toBe(100);
    expect(updated?.outcome?.returnPct).toBe(10);

    const rows = updated?.outcome?.outcomes ?? [];
    const oneDay = rows.find((r) => r.horizon === "1d");
    const oneWeek = rows.find((r) => r.horizon === "1w");
    // Entry fill 100 -> 2026-06-11 close 104 (+4%); SPY 500 -> 505 (+1%) => excess +3.
    expect(oneDay?.resolution).toBe("ok");
    expect(oneDay?.returnPct).toBe(4);
    expect(oneDay?.spyExcessPct).toBe(3);
    expect(oneDay?.priceBasis).toContain("fill->daily_close");
    // 1w (5 trading days from 06-10) -> 06-17 close 115 (+15%); SPY +2% => excess +13.
    expect(oneWeek?.resolution).toBe("ok");
    expect(oneWeek?.returnPct).toBe(15);
    expect(oneWeek?.spyExcessPct).toBe(13);
    // No intraday sampling path was live at placement -> honest terminal rows, no fabrication.
    for (const horizon of ["15m", "1h"] as const) {
      const row = rows.find((r) => r.horizon === horizon);
      expect(row?.resolution).toBe("unresolvable");
      expect(row?.reason).toBe("no_intraday_source");
    }

    // Receipts: per-case outcome receipt + job-level receipt with coverage disclosure.
    const audits = listAudit(50, userId);
    const outcomeReceipt = audits.find((event) => event.kind === "socratic_outcome_recorded");
    expect(outcomeReceipt).toBeTruthy();
    expect((outcomeReceipt?.payload as { coverage?: string }).coverage).toContain("2/4 horizons resolved");
    const jobReceipt = audits.find((event) => event.kind === "socratic_outcome_job");
    expect(jobReceipt).toBeTruthy();
    expect((jobReceipt?.payload as { coverage?: string }).coverage).toContain("resolved");
    const postMortemReceipt = audits.find((event) => event.kind === "socratic_decision_postmortem");
    expect(postMortemReceipt).toBeTruthy();

    // Lessons replaced the creation-time templates, carrying direction + verdict + dissent fields.
    expect(updated?.lessons.some((lesson) => lesson.startsWith("(repeat) Momentum breakouts"))).toBe(true);
    expect(updated?.lessons.some((lesson) => lesson.startsWith("Belief verdict:"))).toBe(true);
    expect(updated?.lessons.some((lesson) => lesson.startsWith("Decisive dissent:"))).toBe(true);

    // Lifecycle re-index fired with the matured outcome + lessons in the embedded text (the write
    // paths await the re-index, so no polling is needed).
    const reindexed = storeContextsCalls.some((call) =>
      call.documents.some((doc) => doc.text.includes("1w +15%") && doc.text.includes("(repeat) Momentum breakouts"))
    );
    expect(reindexed).toBe(true);
    expect(storeContextsCalls.some((call) => call.options?.dedupKeyPrefix === "socratic-decision")).toBe(true);
    expect(storeContextsCalls.every((call) => call.options?.scope === "private")).toBe(true);

    // Lesson routed through ingestLearned (origin 'autonomous'): portfolio-scoped so paper
    // model/task evidence is available on every account, with paper provenance retained.
    // If the fail-closed classifier escalates, it may land as a pending row instead.
    const { listLearnedContext, listPendingLearnedContext } = await import("../src/lib/db");
    const learnedRow = listLearnedContext(userId).find((row) => row.subject.startsWith("decision_lesson:AAPL"));
    const pending = listPendingLearnedContext(userId);
    if (learnedRow) {
      expect(learnedRow.learningScope).toBe("portfolio");
      expect(learnedRow.connectedAccountId).toBeNull();
      expect(learnedRow.accountEnvironment).toBe("paper");
    } else {
      expect(pending.length).toBeGreaterThan(0);
      expect(pending[0]?.learningScope).toBe("portfolio");
      expect(pending[0]?.accountEnvironment).toBe("paper");
    }

    // Idempotent: a terminal case is not re-measured on the next cadence run.
    const second = await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ AAPL: AAPL_BARS, SPY: SPY_BARS }),
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });
    expect(second.scanned).toBe(0);
    expect(second.measured).toBe(0);
  });

  it("matures a BLOCKED decision from its counterfactual refPrice (hypothetical, disclosed)", async () => {
    const userId = `oe-blocked-${randomUUID()}`;
    const { insertSkippedCounterfactualCandidate, upsertSocraticDecisionCase, getSocraticDecisionCase } = await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");

    upsertSocraticDecisionCase({
      userId,
      runId: "run-2",
      proposalId: "prop-2",
      symbol: "MSFT",
      side: "buy",
      status: "blocked",
      authority: "decide",
      thesis: "Value",
      rationale: "Cheap on FCF.",
      action: "BUY MSFT $500"
    });
    insertSkippedCounterfactualCandidate({
      userId,
      runId: "run-2",
      symbol: "MSFT",
      snapshotAt: "2026-06-10T14:30:00.000Z",
      refPrice: 50,
      horizonDays: 5,
      targetDate: "2026-06-17"
    });

    const result = await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ MSFT: MSFT_BARS, SPY: SPY_BARS }),
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });
    expect(result.measured).toBe(1);
    expect(result.closed).toBe(1);

    const updated = getSocraticDecisionCase("prop-2", userId);
    // Headline = longest resolved horizon (1w): 50 -> 55 = +10% => the passed-on trade would have won.
    expect(updated?.outcome?.status).toBe("won");
    expect(updated?.outcome?.returnPct).toBe(10);
    expect(updated?.outcome?.note).toContain("Counterfactual");
    const oneDay = updated?.outcome?.outcomes.find((r) => r.horizon === "1d");
    expect(oneDay?.resolution).toBe("ok");
    expect(oneDay?.returnPct).toBe(2); // 50 -> 51 on 06-11
    expect(oneDay?.priceBasis).toContain("ref_price->daily_close");
  });

  it("preserves a stored sniperAccuracy receipt when a later pass cannot recompute it (terminal realized-lot write)", async () => {
    const userId = `oe-sniper-preserve-${randomUUID()}`;
    const { insertFillEvent, insertProposal, upsertSocraticDecisionCase, getSocraticDecisionCase } = await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");

    const proposalId = `sniper-${randomUUID()}`;
    insertProposal({
      userId,
      id: proposalId,
      runId: "run-sniper",
      accountNumber: "acct",
      proposal: {
        symbol: "AAPL",
        side: "buy",
        type: "market",
        dollarAmount: 1000,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "Sniper preservation fixture.",
        tradeThesisTag: "Momentum",
        entryMarketRegime: "Risk-On",
        scorecard: { sniperPoints: { stopLoss: 95, takeProfit: 110 } }
      },
      decision: { approved: true, reasons: [] },
      status: "placed"
    });
    upsertSocraticDecisionCase({
      userId,
      runId: "run-sniper",
      proposalId,
      accountNumber: "acct",
      symbol: "AAPL",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum",
      rationale: "Sniper preservation fixture.",
      action: "BUY AAPL $1000"
    });
    insertFillEvent({
      userId,
      proposalId,
      runId: "run-sniper",
      accountNumber: "acct",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 100,
      notional: 1000,
      status: "filled",
      filledAt: "2026-06-10T14:30:00.000Z"
    });

    // Pass 1: bars available -> the receipt is computed and persisted on the still-open case.
    await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ AAPL: AAPL_BARS, SPY: SPY_BARS }),
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });
    const afterFirst = getSocraticDecisionCase(proposalId, userId);
    expect(afterFirst?.outcome?.status).toBe("open");
    // Post-basis closes 104/115: stop 95 never breached, take 110 reached on 06-17.
    expect(afterFirst?.outcome?.sniperAccuracy).toEqual({ stopHit: false, takeProfitHit: true, priceBasis: "daily_close" });

    // Close the lot, then re-measure with a failing bars fetch: the terminal realized-lot write
    // (which needs no bars for its verdict) must fall back to the stored receipt, not drop it.
    insertFillEvent({
      userId,
      proposalId: `${proposalId}-exit`,
      runId: "run-sniper-exit",
      accountNumber: "acct",
      source: "paper",
      symbol: "AAPL",
      side: "sell",
      quantity: 10,
      price: 110,
      notional: 1100,
      status: "filled",
      filledAt: "2026-06-16T14:30:00.000Z"
    });
    await matureSocraticDecisionOutcomes(userId, {
      now: NOW + 120_000,
      recheckMs: 60_000,
      fetchOHLC: makeFetchOHLC({}), // AAPL and SPY both null — transient series outage
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });
    const afterSecond = getSocraticDecisionCase(proposalId, userId);
    expect(afterSecond?.outcome?.status).toBe("won");
    expect(afterSecond?.outcome?.sniperAccuracy).toEqual({ stopHit: false, takeProfitHit: true, priceBasis: "daily_close" });
  });

  it("terminates an unmeasurable decision as 'unresolvable' and counts it in coverage (kill survivorship)", async () => {
    const userId = `oe-unres-${randomUUID()}`;
    const { audit, getSocraticOutcomeCoverage, insertSkippedCounterfactualCandidate, upsertSocraticDecisionCase, getSocraticDecisionCase } =
      await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");
    const { materializeSkippedCandidateCounterfactuals } = await import("../src/lib/counterfactual-learning");
    const { getRedTeamEfficacy } = await import("../src/lib/performance");

    upsertSocraticDecisionCase({
      userId,
      runId: "run-3",
      proposalId: "prop-3",
      symbol: "DLSTD",
      side: "buy",
      status: "rejected",
      authority: "decide",
      thesis: "Speculative",
      rationale: "Turnaround bet.",
      action: "BUY DLSTD $200"
    });
    insertSkippedCounterfactualCandidate({
      userId,
      runId: "run-3",
      symbol: "DLSTD",
      snapshotAt: "2026-05-01T14:30:00.000Z",
      refPrice: 10,
      horizonDays: 5,
      targetDate: "2026-05-08"
    });
    // The Bear vetoed this name too — its veto must stay in the efficacy denominator even though
    // the symbol delisted and can never mature.
    audit("proposal_rejected_by_red_team", { runId: "run-3", symbol: "DLSTD", side: "buy", reason: "No durable edge.", model: "bear-model" }, userId);

    // Counterfactual materializer: past the bounded recheck window with no series -> terminal unresolvable.
    const cfResult = await materializeSkippedCandidateCounterfactuals(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ SPY: SPY_BARS }) // DLSTD -> null: no price series at all
    });
    expect(cfResult.markedUnresolvable).toBe(1);
    expect(cfResult.materialized).toBe(0);

    // Outcome engine: all horizons unresolvable -> the CASE terminates 'unresolvable' with reasons.
    const result = await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ SPY: SPY_BARS }),
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });
    expect(result.measured).toBe(1);
    expect(result.unresolvable).toBe(1);
    expect(result.lessonsWritten).toBe(0); // no data -> no fabricated lessons

    const updated = getSocraticDecisionCase("prop-3", userId);
    expect(updated?.outcome?.status).toBe("unresolvable");
    for (const row of updated?.outcome?.outcomes ?? []) {
      expect(row.resolution).toBe("unresolvable");
    }
    expect(updated?.outcome?.outcomes.find((r) => r.horizon === "1w")?.reason).toBe("no_price_series");

    // Coverage disclosure: the unresolvable case stays in the denominator everywhere.
    const coverage = getSocraticOutcomeCoverage(userId);
    expect(coverage.unresolvable).toBe(1);
    expect(coverage.disclosure).toContain("unresolvable");
    expect(result.coverageDisclosure).toContain("unresolvable");

    // Red Team efficacy: the vetoed-but-delisted name is disclosed, not silently dropped.
    const efficacy = getRedTeamEfficacy(userId);
    expect(efficacy.totalVetoes).toBe(1);
    expect(efficacy.unresolvableVetoes).toBe(1);
    expect(efficacy.maturedVetoes).toBe(0);
    expect(efficacy.coverage).toContain("unresolvable");
  });

  it("skips the lesson pass WITH a receipt when the LLM returns nothing — the job never fails", async () => {
    const userId = `oe-lessonskip-${randomUUID()}`;
    const { insertFillEvent, listAudit, upsertSocraticDecisionCase, getSocraticDecisionCase } = await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");

    upsertSocraticDecisionCase({
      userId,
      runId: "run-4",
      proposalId: "prop-4",
      accountNumber: "acct",
      symbol: "AAPL",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum",
      rationale: "Breakout.",
      action: "BUY AAPL $1000"
    });
    insertFillEvent({
      userId,
      proposalId: "prop-4",
      runId: "run-4",
      accountNumber: "acct",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 5,
      price: 100,
      notional: 500,
      status: "filled",
      filledAt: "2026-06-10T14:30:00.000Z"
    });
    insertFillEvent({
      userId,
      proposalId: "prop-4-exit",
      runId: "run-9",
      accountNumber: "acct",
      source: "paper",
      symbol: "AAPL",
      side: "sell",
      quantity: 5,
      price: 90,
      notional: 450,
      status: "filled",
      filledAt: "2026-06-16T14:30:00.000Z"
    });

    const result = await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ AAPL: AAPL_BARS, SPY: SPY_BARS }),
      fetchQuote: async () => undefined,
      llm: async () => undefined // no usable model output
    });

    expect(result.closed).toBe(1);
    expect(result.lessonsWritten).toBe(0);
    expect(result.lessonsSkipped).toBe(1);
    const updated = getSocraticDecisionCase("prop-4", userId);
    expect(updated?.outcome?.status).toBe("lost"); // outcome still written — lessons are additive
    const skipReceipt = listAudit(50, userId).find((event) => event.kind === "socratic_lessons_skipped");
    expect(skipReceipt).toBeTruthy();
    expect((skipReceipt?.payload as { reason?: string }).reason).toBe("llm_empty");
  });
});

describe("counterfactual materializer — multi-horizon rows on skipped candidates", () => {
  it("writes 1d/1w SPY-relative rows and honest unresolvable intraday rows at maturation", async () => {
    const userId = `cf-multi-${randomUUID()}`;
    const { insertSkippedCounterfactualCandidate, listMaturedSkippedCounterfactuals, getSkippedCounterfactualCoverage } =
      await import("../src/lib/db");
    const { materializeSkippedCandidateCounterfactuals } = await import("../src/lib/counterfactual-learning");

    insertSkippedCounterfactualCandidate({
      userId,
      runId: "run-cf",
      symbol: "AAPL",
      snapshotAt: "2026-06-10T14:30:00.000Z",
      refPrice: 100,
      horizonDays: 5,
      targetDate: "2026-06-17"
    });

    const result = await materializeSkippedCandidateCounterfactuals(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ AAPL: AAPL_BARS, SPY: SPY_BARS })
    });
    expect(result.materialized).toBe(1);
    expect(result.markedUnresolvable).toBe(0);

    const [row] = listMaturedSkippedCounterfactuals(userId, 10);
    expect(row.returnPct).toBe(15);
    const outcomes = row.outcomes ?? [];
    const oneDay = outcomes.find((r) => r.horizon === "1d");
    const oneWeek = outcomes.find((r) => r.horizon === "1w");
    expect(oneDay?.resolution).toBe("ok");
    expect(oneDay?.returnPct).toBe(4); // 100 -> 104 on 06-11
    expect(oneDay?.spyExcessPct).toBe(3);
    expect(oneWeek?.returnPct).toBe(15);
    expect(oneWeek?.spyExcessPct).toBe(13);
    for (const horizon of ["15m", "1h"] as const) {
      const intraday = outcomes.find((r) => r.horizon === horizon);
      expect(intraday?.resolution).toBe("unresolvable");
      expect(intraday?.reason).toBe("no_intraday_source");
    }

    const coverage = getSkippedCounterfactualCoverage(userId);
    expect(coverage.matured).toBe(1);
    expect(coverage.disclosure).toContain("1/1 resolved (100%)");
  });

  it("keeps a not-yet-expired pending row pending, then terminates it after the bounded window", async () => {
    const userId = `cf-window-${randomUUID()}`;
    const { insertSkippedCounterfactualCandidate, getSkippedCounterfactualCoverage } = await import("../src/lib/db");
    const { materializeSkippedCandidateCounterfactuals } = await import("../src/lib/counterfactual-learning");

    insertSkippedCounterfactualCandidate({
      userId,
      runId: "run-w",
      symbol: "GONE",
      snapshotAt: "2026-06-10T14:30:00.000Z",
      refPrice: 20,
      horizonDays: 5,
      targetDate: "2026-06-17"
    });

    // 2026-06-20: due but inside the bounded recheck window -> stays pending (retry later).
    const early = await materializeSkippedCandidateCounterfactuals(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ SPY: SPY_BARS })
    });
    expect(early.markedUnresolvable).toBe(0);
    expect(getSkippedCounterfactualCoverage(userId).pending).toBe(1);

    // Well past target + UNRESOLVABLE_AFTER_TRADING_DAYS -> terminal unresolvable with reason.
    const late = await materializeSkippedCandidateCounterfactuals(userId, {
      now: Date.parse("2026-07-15T00:00:00.000Z"),
      recheckMs: 60_000,
      fetchOHLC: makeFetchOHLC({ SPY: SPY_BARS })
    });
    expect(late.markedUnresolvable).toBe(1);
    const coverage = getSkippedCounterfactualCoverage(userId);
    expect(coverage.unresolvable).toBe(1);
    expect(coverage.pending).toBe(0);
    expect(coverage.disclosure).toContain("unresolvable");
  });
});

describe("benchmark-alpha outcome grading (outcomeGradingMode)", () => {
  // Rising market: the long gains 2% over 1w while SPY gains 5% — raw grading calls it a win,
  // alpha grading calls it a loss (the decision underperformed just holding the index).
  const ALPH_BARS: OHLCBar[] = [
    { time: "2026-06-10", close: 100 },
    { time: "2026-06-11", close: 101 },
    { time: "2026-06-17", close: 102 }
  ];
  const SPY_RALLY_BARS: OHLCBar[] = [
    { time: "2026-06-10", close: 500 },
    { time: "2026-06-11", close: 505 },
    { time: "2026-06-17", close: 525 }
  ];
  // Outperformance: the long gains 20% over 1w while SPY (module-level SPY_BARS) gains only 2% —
  // raw AND alpha both grade this a win, with no divergence between them.
  const ALPH_OUTPERFORM_BARS: OHLCBar[] = [
    { time: "2026-06-10", close: 100 },
    { time: "2026-06-11", close: 108 },
    { time: "2026-06-17", close: 120 }
  ];

  async function seedBlockedCase(userId: string, runId: string): Promise<void> {
    const { insertSkippedCounterfactualCandidate, upsertSocraticDecisionCase } = await import("../src/lib/db");
    upsertSocraticDecisionCase({
      userId,
      runId,
      proposalId: `prop-${runId}`,
      symbol: "ALPH",
      side: "buy",
      status: "blocked",
      authority: "decide",
      thesis: "Momentum",
      rationale: "Rising-market long.",
      action: "BUY ALPH $500"
    });
    insertSkippedCounterfactualCandidate({
      userId,
      runId,
      symbol: "ALPH",
      snapshotAt: "2026-06-10T14:30:00.000Z",
      refPrice: 100,
      horizonDays: 5,
      targetDate: "2026-06-17"
    });
  }

  it("alpha mode: long up 2% vs SPY up 5% grades alphaStatus 'lost' while raw stays 'won', with a divergence receipt and alpha-cited post-mortem", async () => {
    const userId = `oe-alpha-div-${randomUUID()}`;
    const { getSocraticDecisionCase, listAudit, setPolicy } = await import("../src/lib/db");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");
    setPolicy({ ...DEFAULT_POLICY, outcomeGradingMode: "alpha" }, userId);
    await seedBlockedCase(userId, "run-alpha-1");

    const prompts: string[] = [];
    const result = await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ ALPH: ALPH_BARS, SPY: SPY_RALLY_BARS }),
      fetchQuote: async () => undefined,
      llm: async ({ userContent }) => {
        prompts.push(userContent);
        return JSON.stringify({
          lessons: [{ lesson: "Beta-driven longs need an edge over the index; avoid.", direction: "avoid" }],
          verdictOnBelief: "Right on direction, wrong on edge.",
          whichDissentMattered: "none"
        });
      }
    });
    expect(result.closed).toBe(1);
    expect(result.lessonsWritten).toBe(1); // alpha mode never blocks lesson generation

    const updated = getSocraticDecisionCase("prop-run-alpha-1", userId);
    // Raw grading is untouched: headline 1w +2% -> 'won'.
    expect(updated?.outcome?.status).toBe("won");
    expect(updated?.outcome?.returnPct).toBe(2);
    // Companion alpha grade from the headline (1w) spyExcessPct: 2 - 5 = -3 -> 'lost'.
    expect(updated?.outcome?.alphaStatus).toBe("lost");
    expect(updated?.outcome?.alphaPct).toBe(-3);

    // The key observability signal: raw and alpha verdicts disagreed.
    const receipt = listAudit(50, userId).find((event) => event.kind === "outcome_alpha_grading");
    expect(receipt).toBeTruthy();
    expect(receipt?.payload).toMatchObject({ event: "divergence", rawStatus: "won", alphaStatus: "lost", alphaPct: -3 });

    // The post-mortem prompt cites the alpha figures, not just the raw return.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"alphaStatus":"lost"');
    expect(prompts[0]).toContain('"alphaPct":-3');
  });

  it("alpha mode: long OUTPERFORMS SPY (raw 'won', alpha also 'won') — no divergence, zero outcome_alpha_grading audit events", async () => {
    const userId = `oe-alpha-nodiv-${randomUUID()}`;
    const { getSocraticDecisionCase, listAudit, setPolicy } = await import("../src/lib/db");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");
    setPolicy({ ...DEFAULT_POLICY, outcomeGradingMode: "alpha" }, userId);
    await seedBlockedCase(userId, "run-alpha-nodiv");

    const result = await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ ALPH: ALPH_OUTPERFORM_BARS, SPY: SPY_BARS }),
      fetchQuote: async () => undefined,
      llm: async () =>
        JSON.stringify({
          lessons: [{ lesson: "Momentum long that also cleared the index; repeat when volume confirms.", direction: "repeat" }],
          verdictOnBelief: "Right on direction and edge.",
          whichDissentMattered: "none"
        })
    });
    expect(result.closed).toBe(1);
    expect(result.lessonsWritten).toBe(1);

    const updated = getSocraticDecisionCase("prop-run-alpha-nodiv", userId);
    // Raw grading: headline 1w +20% -> 'won'.
    expect(updated?.outcome?.status).toBe("won");
    expect(updated?.outcome?.returnPct).toBe(20);
    // Alpha grading agrees: 1w excess = 20 - 2 = +18 -> 'won'. Same verdict as raw -> no divergence.
    expect(updated?.outcome?.alphaStatus).toBe("won");
    expect(updated?.outcome?.alphaPct).toBe(18);

    // Agreement writes NOTHING to the audit log: no divergence receipt AND no raw_fallback receipt.
    const alphaEvents = listAudit(50, userId).filter((event) => event.kind === "outcome_alpha_grading");
    expect(alphaEvents).toHaveLength(0);
  });

  it("raw mode (default): behavior unchanged — no alpha fields on the outcome and no alpha receipts", async () => {
    const userId = `oe-alpha-raw-${randomUUID()}`;
    const { getSocraticDecisionCase, listAudit } = await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");
    await seedBlockedCase(userId, "run-alpha-raw");

    const result = await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ ALPH: ALPH_BARS, SPY: SPY_RALLY_BARS }),
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });
    expect(result.closed).toBe(1);

    const updated = getSocraticDecisionCase("prop-run-alpha-raw", userId);
    expect(updated?.outcome?.status).toBe("won");
    // Companion fields are NOT written in raw mode — not even as undefined-valued keys.
    expect("alphaStatus" in (updated?.outcome ?? {})).toBe(false);
    expect("alphaPct" in (updated?.outcome ?? {})).toBe(false);
    expect(listAudit(50, userId).some((event) => event.kind === "outcome_alpha_grading")).toBe(false);
  });

  it("alpha mode with no measurable spyExcessPct: alphaStatus stays undefined and lesson gating falls back to raw WITH a receipt", async () => {
    const userId = `oe-alpha-fb-${randomUUID()}`;
    const { getSocraticDecisionCase, listAudit, setPolicy } = await import("../src/lib/db");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");
    setPolicy({ ...DEFAULT_POLICY, outcomeGradingMode: "alpha" }, userId);
    await seedBlockedCase(userId, "run-alpha-fb");

    const result = await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ ALPH: ALPH_BARS }), // SPY -> null: no benchmark series (never fabricated)
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });
    expect(result.closed).toBe(1);

    const updated = getSocraticDecisionCase("prop-run-alpha-fb", userId);
    expect(updated?.outcome?.status).toBe("won"); // raw grading still resolves
    expect(updated?.outcome?.alphaStatus).toBeUndefined();

    // Lesson generation was NOT blocked; the fallback to raw gating is receipted instead.
    const fallback = listAudit(50, userId).find((event) => event.kind === "outcome_alpha_grading");
    expect(fallback).toBeTruthy();
    expect(fallback?.payload).toMatchObject({ event: "raw_fallback", reason: "no_spy_excess", rawStatus: "won" });
  });
});

describe("benchmark basis (policy.benchmarkMode) — r4: index-vs-ETF/sector series", () => {
  // Fixed side-adjusted return for every symbol below: 1d +4%, 1w +15%.
  const SYM_BARS: OHLCBar[] = [
    { time: "2026-06-10", close: 100 },
    { time: "2026-06-11", close: 104 },
    { time: "2026-06-17", close: 115 }
  ];
  // Every benchmark series below has a DIFFERENT growth rate so a test can prove exactly which
  // series fed spyExcessPct from the resulting number, not just the benchmarkBasis label.
  const GSPC_BARS: OHLCBar[] = [ // +1% / +2% -> excess 3 / 13
    { time: "2026-06-10", close: 5000 },
    { time: "2026-06-11", close: 5050 },
    { time: "2026-06-17", close: 5100 }
  ];
  const SPY_ONLY_BARS: OHLCBar[] = [ // +2% / +4% -> excess 2 / 11
    { time: "2026-06-10", close: 500 },
    { time: "2026-06-11", close: 510 },
    { time: "2026-06-17", close: 520 }
  ];
  const XLK_BARS: OHLCBar[] = [ // +0.5% / +5% -> excess 3.5 / 10
    { time: "2026-06-10", close: 200 },
    { time: "2026-06-11", close: 201 },
    { time: "2026-06-17", close: 210 }
  ];
  const SP500_60_BARS: OHLCBar[] = [ // +3% / +6% -> excess 1 / 9 (the one live sector INDEX)
    { time: "2026-06-10", close: 250 },
    { time: "2026-06-11", close: 257.5 },
    { time: "2026-06-17", close: 265 }
  ];
  const XLRE_BARS: OHLCBar[] = [ // +2.5% / +7% -> excess 1.5 / 8
    { time: "2026-06-10", close: 300 },
    { time: "2026-06-11", close: 307.5 },
    { time: "2026-06-17", close: 321 }
  ];

  async function seedPlacedCase(
    userId: string,
    symbol: string,
    sector?: string
  ): Promise<void> {
    const { insertFillEvent, upsertSocraticDecisionCase } = await import("../src/lib/db");
    upsertSocraticDecisionCase({
      userId,
      proposalId: `prop-${symbol}`,
      accountNumber: "acct",
      symbol,
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Test",
      rationale: "r4 benchmark-basis coverage.",
      action: `BUY ${symbol} $1000`,
      // Mirrors evidenceForDecision (socratic-runtime.ts): the "candidate" evidence item's `data`
      // is the scan quote, which carries `sector` — the SAME source sectorForDecisionCase reads
      // at grading time for both placed and blocked/rejected cases.
      ...(sector
        ? { evidence: [{ kind: "candidate" as const, title: "scan", summary: "scan", symbol, data: { sector } }] }
        : {})
    });
    insertFillEvent({
      userId,
      proposalId: `prop-${symbol}`,
      accountNumber: "acct",
      source: "paper",
      symbol,
      side: "buy",
      quantity: 10,
      price: 100,
      notional: 1000,
      status: "filled",
      filledAt: "2026-06-10T14:30:00.000Z"
    });
  }

  it("default benchmarkMode 'market' prefers ^GSPC over SPY: row records benchmarkBasis '^GSPC' and spyExcessPct matches the INDEX's return, not SPY's", async () => {
    const userId = `oe-bench-market-index-${randomUUID()}`;
    const { getSocraticDecisionCase } = await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");
    await seedPlacedCase(userId, "MKTA");

    await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ MKTA: SYM_BARS, "^GSPC": GSPC_BARS, SPY: SPY_ONLY_BARS }),
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });

    const rows = getSocraticDecisionCase("prop-MKTA", userId)?.outcome?.outcomes ?? [];
    const oneDay = rows.find((r) => r.horizon === "1d");
    const oneWeek = rows.find((r) => r.horizon === "1w");
    expect(oneDay?.benchmarkBasis).toBe("^GSPC");
    expect(oneDay?.spyExcessPct).toBe(3); // would be 2 if SPY had won instead of ^GSPC
    expect(oneWeek?.benchmarkBasis).toBe("^GSPC");
    expect(oneWeek?.spyExcessPct).toBe(13); // would be 11 off SPY
  });

  it("market mode falls back to SPY, honestly labeled 'SPY(fallback)', when the ^GSPC series is unavailable this run", async () => {
    const userId = `oe-bench-market-fallback-${randomUUID()}`;
    const { getSocraticDecisionCase } = await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");
    await seedPlacedCase(userId, "MKTB");

    await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ MKTB: SYM_BARS, SPY: SPY_ONLY_BARS }), // no ^GSPC key -> null
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });

    const rows = getSocraticDecisionCase("prop-MKTB", userId)?.outcome?.outcomes ?? [];
    const oneDay = rows.find((r) => r.horizon === "1d");
    expect(oneDay?.benchmarkBasis).toBe("SPY(fallback)");
    expect(oneDay?.spyExcessPct).toBe(2);
  });

  it("benchmarkMode 'sector': a known sector whose index isn't Yahoo-servable (Technology) grades against its ETF, receipted via benchmarkBasis", async () => {
    const userId = `oe-bench-sector-etf-${randomUUID()}`;
    const { getSocraticDecisionCase, setPolicy } = await import("../src/lib/db");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");
    setPolicy({ ...DEFAULT_POLICY, benchmarkMode: "sector" }, userId);
    await seedPlacedCase(userId, "SECA", "Technology");

    await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      // Market bars are ALSO present so a wrongly-market-graded row would be distinguishable.
      fetchOHLC: makeFetchOHLC({ SECA: SYM_BARS, XLK: XLK_BARS, "^GSPC": GSPC_BARS, SPY: SPY_ONLY_BARS }),
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });

    const rows = getSocraticDecisionCase("prop-SECA", userId)?.outcome?.outcomes ?? [];
    const oneDay = rows.find((r) => r.horizon === "1d");
    const oneWeek = rows.find((r) => r.horizon === "1w");
    expect(oneDay?.benchmarkBasis).toBe("XLK"); // no index mapped for Technology -> straight to the ETF, no "(fallback)" suffix
    expect(oneDay?.spyExcessPct).toBe(3.5);
    expect(oneWeek?.spyExcessPct).toBe(10);
  });

  it("benchmarkMode 'sector' with an unmapped/unknown sector honestly falls back to the market benchmark", async () => {
    const userId = `oe-bench-sector-unmapped-${randomUUID()}`;
    const { getSocraticDecisionCase, setPolicy } = await import("../src/lib/db");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");
    setPolicy({ ...DEFAULT_POLICY, benchmarkMode: "sector" }, userId);
    await seedPlacedCase(userId, "SECB", "Some Unmapped Sector");

    await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({ SECB: SYM_BARS, "^GSPC": GSPC_BARS, SPY: SPY_ONLY_BARS }),
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });

    const rows = getSocraticDecisionCase("prop-SECB", userId)?.outcome?.outcomes ?? [];
    const oneDay = rows.find((r) => r.horizon === "1d");
    expect(oneDay?.benchmarkBasis).toBe("^GSPC");
    expect(oneDay?.spyExcessPct).toBe(3);
  });

  it("benchmarkMode 'sector' grades Real Estate against the live-verified S&P 500 Real Estate INDEX directly (no ETF fallback needed)", async () => {
    const userId = `oe-bench-sector-index-${randomUUID()}`;
    const { getSocraticDecisionCase, setPolicy } = await import("../src/lib/db");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");
    setPolicy({ ...DEFAULT_POLICY, benchmarkMode: "sector" }, userId);
    await seedPlacedCase(userId, "SECC", "Real Estate");

    await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      fetchOHLC: makeFetchOHLC({
        SECC: SYM_BARS,
        "^SP500-60": SP500_60_BARS,
        XLRE: XLRE_BARS,
        "^GSPC": GSPC_BARS,
        SPY: SPY_ONLY_BARS
      }),
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });

    const rows = getSocraticDecisionCase("prop-SECC", userId)?.outcome?.outcomes ?? [];
    const oneDay = rows.find((r) => r.horizon === "1d");
    expect(oneDay?.benchmarkBasis).toBe("^SP500-60");
    expect(oneDay?.spyExcessPct).toBe(1);
  });

  it("benchmarkMode 'sector' falls back to the sector ETF, honestly labeled '(fallback)', when the Real Estate index series is unavailable this run", async () => {
    const userId = `oe-bench-sector-index-fallback-${randomUUID()}`;
    const { getSocraticDecisionCase, setPolicy } = await import("../src/lib/db");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");
    setPolicy({ ...DEFAULT_POLICY, benchmarkMode: "sector" }, userId);
    await seedPlacedCase(userId, "SECD", "Real Estate");

    await matureSocraticDecisionOutcomes(userId, {
      now: NOW,
      // No "^SP500-60" key -> null: the index tier fails, XLRE is the honest fallback.
      fetchOHLC: makeFetchOHLC({ SECD: SYM_BARS, XLRE: XLRE_BARS, "^GSPC": GSPC_BARS, SPY: SPY_ONLY_BARS }),
      fetchQuote: async () => undefined,
      llm: async () => undefined
    });

    const rows = getSocraticDecisionCase("prop-SECD", userId)?.outcome?.outcomes ?? [];
    const oneDay = rows.find((r) => r.horizon === "1d");
    expect(oneDay?.benchmarkBasis).toBe("XLRE(fallback)");
    expect(oneDay?.spyExcessPct).toBe(1.5);
  });
});

describe("callLessonLlm — empty-model guard (rotation sentinel / no-defaults)", () => {
  it("returns undefined and makes NO fetch when the model resolves empty but a key is present", async () => {
    const userId = `oe-lesson-nomodel-${randomUUID()}`;
    const { setPolicy, upsertUserApiKey } = await import("../src/lib/db");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const { callLessonLlm } = await import("../src/lib/outcome-engine");

    // Key present (so the old `if (!key)` guard would fall through and POST model:"" → 400 on every
    // post-mortem lesson call), but the model resolves to "" because the persisted policy carries the
    // run-scoped rotation sentinel, which resolveLlmEndpoint maps to "" OUTSIDE a strategy run (rotation
    // resolves only inside runStrategyOnce). The guard must treat the blank model as unconfigured and
    // skip cleanly — never issue a request.
    upsertUserApiKey(userId, "openrouter", "sk-test", "test");
    setPolicy({ ...DEFAULT_POLICY, llmModel: "__rotate__" }, userId);

    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await callLessonLlm(userId, JSON.stringify({ probe: true }));
      expect(result).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
