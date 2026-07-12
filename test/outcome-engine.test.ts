import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OHLCBar } from "../src/lib/indicators";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-outcome-engine-${randomUUID()}.db`)}`;
});

// Capture every vector-memory re-index (the lifecycle hook) without Pinecone/Voyage credentials.
const storeContextsCalls: Array<{ documents: Array<{ text: string }>; options?: { dedupKeyPrefix?: string } }> = [];
vi.mock("../src/lib/vector-db", () => ({
  storeContexts: async (documents: Array<{ text: string }>, _userId?: string, options?: { dedupKeyPrefix?: string }) => {
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
  it("matures a PLACED decision: joins the fill + closed lot, writes multi-horizon outcome, receipts, re-indexes", async () => {
    const userId = `oe-placed-${randomUUID()}`;
    const { insertFillEvent, listAudit, upsertSocraticDecisionCase, getSocraticDecisionCase } = await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");

    upsertSocraticDecisionCase({
      userId,
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
    expect(storeContextsCalls.every((call) => call.options?.dedupKeyPrefix === "socratic-decision")).toBe(true);

    // Lesson routed through ingestLearned (origin 'autonomous'): lands as a live fact row or,
    // if the fail-closed classifier escalates, as a pending approval row — never silently dropped.
    const { listLearnedContext, listPendingLearnedContext } = await import("../src/lib/db");
    const learned = listLearnedContext(userId).some((row) => row.subject.startsWith("decision_lesson:AAPL"));
    const pending = listPendingLearnedContext(userId).length > 0;
    expect(learned || pending).toBe(true);

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
