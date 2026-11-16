// Truncated-replay lookahead audit (freqtrade lookahead-analysis port). Verifies: a deliberately
// planted future-bar series shifts the replayed momentum sub-score beyond tolerance and the
// mismatch is detected AND NAMED; an honest decision-time computation replays clean; an
// unpersisted RAG candidate pool classifies 'unverifiable' (the knob is never forced on); the
// always-unverifiable factors carry their backtestSafety receipts; the verdict floor yields an
// honest 'insufficient_sample' below the floor while a mismatch is evidence at any sample size;
// and the db-backed pass samples only matured decisions, advances its watermark, and upserts
// idempotently. Migration/deletion coverage for the new table lives in
// test/persistence-hardening.test.ts (schema version 75) and test/account-deletion-coverage.test.ts.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { OHLCBar } from "../src/lib/indicators";
import type { CandidateEvidence, MarketQuote } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-lookahead-audit-${randomUUID()}.db`)}`;
});

const DAY_MS = 86_400_000;
const DECISION_DATE = "2026-07-15";
const DECISION_AS_OF = "2026-07-15T15:00:00.000Z";
const NOW = Date.parse("2026-08-12T12:00:00.000Z");

function isoDate(startMs: number, dayIndex: number): string {
  return new Date(startMs + dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function bar(date: string, close: number, volume = 1_000_000): OHLCBar {
  return { time: `${date}T00:00:00.000Z`, open: close, high: close * 1.01, low: close * 0.99, close, volume };
}

const SERIES_START = Date.parse("2026-01-01T00:00:00.000Z");
/** 2026-01-01 + 195 days = 2026-07-15 — the decision-day bar index. */
const DECISION_INDEX = 195;

/** Rising series: +0.1/day from 100, running well past the decision date. */
function risingBars(count = 320): OHLCBar[] {
  return Array.from({ length: count }, (_, i) => bar(isoDate(SERIES_START, i), 100 + i * 0.1));
}

/** Same series through the decision date, then a planted FUTURE decline (-1.0/day). */
function barsWithFutureCrash(): OHLCBar[] {
  const base = risingBars(DECISION_INDEX + 1);
  const lastClose = 100 + DECISION_INDEX * 0.1;
  for (let i = 1; i <= 60; i++) {
    base.push(bar(isoDate(SERIES_START, DECISION_INDEX + i), lastClose - i * 1.0));
  }
  return base;
}

/** Decision-time factor breakdown computed HONESTLY (or leakily) from a given bar series, using
 *  the exact clone construction the audit replays — so the clean case matches to rounding and the
 *  leak case differs only by the future bars. */
async function breakdownFromSeries(seriesAsSeenAtDecision: OHLCBar[], refPrice: number, volume: number) {
  const { computeTechnicals } = await import("../src/lib/indicators");
  const { scoreFactors } = await import("../src/lib/market");
  const tech = computeTechnicals(seriesAsSeenAtDecision)!.score;
  const window = seriesAsSeenAtDecision.slice(-252);
  let high = -Infinity;
  let low = Infinity;
  for (const b of window) {
    high = Math.max(high, b.high ?? b.close);
    low = Math.min(low, b.low ?? b.close);
  }
  const quote: MarketQuote = {
    symbol: "AAPL",
    price: refPrice,
    volume,
    intradayChangePct: 1.2,
    positionMarketValue: 0,
    score: 0,
    technicalScore: tech,
    fiftyTwoWeekHigh: high,
    fiftyTwoWeekLow: low
  };
  return { breakdown: scoreFactors(quote), tech };
}

function evidenceFor(breakdown: CandidateEvidence["factorBreakdown"], tech: number, refPrice: number): CandidateEvidence {
  return {
    symbol: "AAPL",
    chosen: true,
    regime: "risk_on",
    score: 55,
    refPrice,
    factorBreakdown: breakdown,
    intradayChangePct: 1.2,
    technicalScore: tech,
    sources: { volume: "test-src", fiftyTwoWeekHigh: "test-src", fiftyTwoWeekLow: "test-src" }
  };
}

function decisionFor(evidence: CandidateEvidence, decisionId = "audit-1:AAPL", runId?: string) {
  return {
    decisionId,
    auditRowid: 1,
    ...(runId ? { runId } : {}),
    symbol: evidence.symbol,
    decisionDate: DECISION_DATE,
    asOf: DECISION_AS_OF,
    evidence
  };
}

describe("factor replay (pure)", () => {
  it("replays an honest decision clean (delta within rounding) for momentum AND liquidity", async () => {
    const { replayFactorFindings, truncateBarsToDecision } = await import("../src/lib/lookahead-audit");
    const bars = risingBars();
    const truncated = truncateBarsToDecision(bars, DECISION_DATE);
    expect(truncated[truncated.length - 1]!.close).toBeCloseTo(100 + DECISION_INDEX * 0.1, 10);
    const refPrice = truncated[truncated.length - 1]!.close;
    const { breakdown, tech } = await breakdownFromSeries(truncated, refPrice, 1_000_000);

    const findings = replayFactorFindings(decisionFor(evidenceFor(breakdown, tech, refPrice)), bars, 15);
    const momentum = findings.find((f) => f.factorOrField === "momentum")!;
    const liquidity = findings.find((f) => f.factorOrField === "liquidity")!;
    expect(momentum.classification).toBe("clean");
    expect(momentum.delta!).toBeLessThanOrEqual(0.01);
    expect(liquidity.classification).toBe("clean");
    expect(liquidity.delta!).toBeLessThanOrEqual(0.01);
  });

  it("detects and NAMES a momentum mismatch when the persisted score leaked future bars", async () => {
    const { replayFactorFindings } = await import("../src/lib/lookahead-audit");
    const leaked = barsWithFutureCrash();
    const refPrice = 100 + DECISION_INDEX * 0.1;
    // The leaky pipeline computed technicals/52w over the FULL series, future crash included.
    const { breakdown, tech } = await breakdownFromSeries(leaked, refPrice, 1_000_000);

    const findings = replayFactorFindings(decisionFor(evidenceFor(breakdown, tech, refPrice)), leaked, 15);
    const momentum = findings.find((f) => f.factorOrField === "momentum")!;
    expect(momentum.classification).toBe("mismatch");
    expect(momentum.factorOrField).toBe("momentum"); // named, not an anonymous aggregate
    expect(momentum.delta!).toBeGreaterThan(15);
    expect(momentum.persistedValue).toBeDefined();
    expect(momentum.recomputedValue).toBeDefined();
  });

  it("always labels the non-replayable factors 'unverifiable' with a backtestSafety receipt", async () => {
    const { replayFactorFindings, LOOKAHEAD_UNVERIFIABLE_FACTORS, LOOKAHEAD_BACKTEST_SAFETY_LABEL } = await import(
      "../src/lib/lookahead-audit"
    );
    const bars = risingBars();
    const refPrice = 100 + DECISION_INDEX * 0.1;
    const { breakdown, tech } = await breakdownFromSeries(bars.slice(0, DECISION_INDEX + 1), refPrice, 1_000_000);
    const findings = replayFactorFindings(decisionFor(evidenceFor(breakdown, tech, refPrice)), bars, 15);
    for (const factor of LOOKAHEAD_UNVERIFIABLE_FACTORS) {
      const finding = findings.find((f) => f.factorOrField === factor)!;
      expect(finding.classification).toBe("unverifiable");
      expect(finding.detail?.backtestSafety).toBe(LOOKAHEAD_BACKTEST_SAFETY_LABEL);
      expect(typeof finding.detail?.reason).toBe("string");
    }
  });

  it("classifies 'unverifiable' (never a fabricated diff) when the point-in-time inputs are missing", async () => {
    const { replayFactorFindings } = await import("../src/lib/lookahead-audit");
    // No bars at all → both replay fields are unverifiable, with reasons.
    const refPrice = 119.5;
    const { breakdown, tech } = await breakdownFromSeries(risingBars().slice(0, DECISION_INDEX + 1), refPrice, 1_000_000);
    const findings = replayFactorFindings(decisionFor(evidenceFor(breakdown, tech, refPrice)), null, 15);
    expect(findings.find((f) => f.factorOrField === "momentum")!.classification).toBe("unverifiable");
    expect(findings.find((f) => f.factorOrField === "liquidity")!.classification).toBe("unverifiable");

    // Volume without per-field provenance → liquidity may have scored from market cap; honest skip.
    const noVolumeSources = evidenceFor(breakdown, tech, refPrice);
    noVolumeSources.sources = { fiftyTwoWeekHigh: "test-src", fiftyTwoWeekLow: "test-src" };
    const findings2 = replayFactorFindings(decisionFor(noVolumeSources), risingBars(), 15);
    const liquidity = findings2.find((f) => f.factorOrField === "liquidity")!;
    expect(liquidity.classification).toBe("unverifiable");
    expect(liquidity.detail?.reason).toBe("no_persisted_volume_provenance");
  });
});

describe("RAG evidence replay classification (pure)", () => {
  const PIN = "2026-07-15T15:00:00.000Z";

  async function classify(overrides: {
    pools?: Array<{ auditId: string; queryHash?: string; asOf?: string; candidates: Array<{ id: string; used: boolean; asOf?: string; docType?: string }> }>;
    replay?: { status?: string; chunks: Array<{ id: string; doc_type?: string; as_of?: string }> };
    jaccardMin?: number;
  }) {
    const { classifyRagEvidenceReplay } = await import("../src/lib/lookahead-audit");
    const { hashQuery } = await import("../src/lib/rag-metering");
    const { deterministicFilingsRetrievalQuery } = await import("../src/lib/rag/information-routing");
    const expectedQueryHash = hashQuery(deterministicFilingsRetrievalQuery("AAPL"));
    const decision = decisionFor(
      { symbol: "AAPL", chosen: true, regime: "risk_on" },
      "audit-rag:AAPL",
      "run-rag"
    );
    return classifyRagEvidenceReplay({
      decision,
      pools: (overrides.pools ?? []).map((pool) => ({
        ...pool,
        queryHash: pool.queryHash === "__expected__" ? expectedQueryHash : pool.queryHash
      })),
      expectedQueryHash,
      replay: overrides.replay,
      jaccardMin: overrides.jaccardMin ?? 0.5
    });
  }

  it("classifies 'unverifiable' when no candidate pool was persisted — the knob stays off", async () => {
    const finding = await classify({ pools: [] });
    expect(finding.classification).toBe("unverifiable");
    expect(finding.detail?.reason).toBe("candidate_pool_not_persisted");
    expect(finding.detail?.knob).toBe("RAG_PERSIST_CANDIDATE_POOL");
  });

  it("classifies 'unverifiable' on query-builder drift (no pool matches the rebuilt hash)", async () => {
    const finding = await classify({
      pools: [{ auditId: "p1", queryHash: "deadbeefdeadbeef", asOf: PIN, candidates: [{ id: "c1", used: true }] }]
    });
    expect(finding.classification).toBe("unverifiable");
    expect(finding.detail?.reason).toBe("query_builder_drift");
  });

  it("hard-mismatches when a used candidate is stamped after the as-of pin — no replay needed", async () => {
    const finding = await classify({
      pools: [
        {
          auditId: "p1",
          queryHash: "__expected__",
          asOf: PIN,
          candidates: [
            { id: "c1", used: true, asOf: "2026-07-01T00:00:00.000Z" },
            { id: "leak", used: true, asOf: "2026-07-20T00:00:00.000Z" }
          ]
        }
      ]
    });
    expect(finding.classification).toBe("mismatch");
    expect(finding.detail?.reason).toBe("post_asof_chunk_in_decision_context");
    expect(finding.detail?.postAsOfChunkIds).toEqual(["leak"]);
  });

  it("hard-mismatches when the strict replay itself returns a post-as-of chunk", async () => {
    const finding = await classify({
      pools: [
        { auditId: "p1", queryHash: "__expected__", asOf: PIN, candidates: [{ id: "c1", used: true, asOf: "2026-07-01T00:00:00.000Z" }] }
      ],
      replay: { chunks: [{ id: "c1", as_of: "2026-08-01T00:00:00.000Z" }] }
    });
    expect(finding.classification).toBe("mismatch");
    expect(finding.detail?.reason).toBe("post_asof_chunk_in_strict_replay");
  });

  it("stays clean under benign reranker drift and mismatches beyond the Jaccard tolerance", async () => {
    const pools = [
      {
        auditId: "p1",
        queryHash: "__expected__",
        asOf: PIN,
        candidates: [
          { id: "c1", used: true, asOf: "2026-07-01T00:00:00.000Z" },
          { id: "c2", used: true, asOf: "2026-07-02T00:00:00.000Z" },
          { id: "c3", used: false }
        ]
      }
    ];
    const clean = await classify({ pools, replay: { chunks: [{ id: "c1" }, { id: "c2" }] } });
    expect(clean.classification).toBe("clean");
    expect(clean.persistedValue).toBe(2);
    expect(clean.delta).toBe(0);

    const drifted = await classify({ pools, replay: { chunks: [{ id: "x1" }, { id: "x2" }] } });
    expect(drifted.classification).toBe("mismatch");
    expect(drifted.detail?.reason).toBe("retrieval_drift_beyond_tolerance");
    expect(drifted.delta).toBe(1);
  });

  it("classifies 'unverifiable' when the replay could not run (budget/keys)", async () => {
    const finding = await classify({
      pools: [
        { auditId: "p1", queryHash: "__expected__", asOf: PIN, candidates: [{ id: "c1", used: true }] }
      ],
      replay: { status: "budget_skipped", chunks: [] }
    });
    expect(finding.classification).toBe("unverifiable");
    expect(finding.detail?.reason).toBe("retrieval_replay_unavailable");
  });
});

describe("verdict floor (pure)", () => {
  it("returns an honest 'insufficient_sample' below the floor instead of an all-clear", async () => {
    const { computeLookaheadVerdict } = await import("../src/lib/lookahead-audit");
    const verdict = computeLookaheadVerdict({ clean: 5, mismatch: 0, unverifiable: 40 }, 20);
    expect(verdict.verdict).toBe("insufficient_sample");
    expect(verdict.qualifying).toBe(5); // unverifiable rows never qualify
  });

  it("declares the all-clear only at/above the floor", async () => {
    const { computeLookaheadVerdict } = await import("../src/lib/lookahead-audit");
    expect(computeLookaheadVerdict({ clean: 20, mismatch: 0, unverifiable: 0 }, 20).verdict).toBe(
      "no_lookahead_bias_detected"
    );
  });

  it("treats any mismatch as evidence regardless of sample size", async () => {
    const { computeLookaheadVerdict } = await import("../src/lib/lookahead-audit");
    expect(computeLookaheadVerdict({ clean: 2, mismatch: 1, unverifiable: 99 }, 20).verdict).toBe(
      "lookahead_mismatch_detected"
    );
  });
});

describe("config + scheduling (pure)", () => {
  it("defaults on, with the documented kill switch and bounded knobs", async () => {
    const { loadLookaheadAuditConfig } = await import("../src/lib/lookahead-audit");
    const defaults = loadLookaheadAuditConfig({} as NodeJS.ProcessEnv);
    expect(defaults.enabled).toBe(true);
    expect(defaults.sampleSize).toBe(25);
    expect(defaults.verdictFloor).toBe(20);
    expect(defaults.cadenceDays).toBe(7);

    const killed = loadLookaheadAuditConfig({ LOOKAHEAD_AUDIT_ENABLED: "off" } as unknown as NodeJS.ProcessEnv);
    expect(killed.enabled).toBe(false);
    expect(killed.disabledReason).toBe("kill_switch");

    const tuned = loadLookaheadAuditConfig({
      LOOKAHEAD_AUDIT_SAMPLE: "9999",
      LOOKAHEAD_AUDIT_JACCARD_MIN: "0.8"
    } as unknown as NodeJS.ProcessEnv);
    expect(tuned.sampleSize).toBe(200); // clamped
    expect(tuned.jaccardMin).toBe(0.8);
  });

  it("nextLookaheadAuditDueAt lands strictly in the future, at most one cadence away", async () => {
    const { nextLookaheadAuditDueAt } = await import("../src/lib/lookahead-audit");
    const { dueAtISO, dedupeDate } = nextLookaheadAuditDueAt(NOW, 7);
    const due = Date.parse(dueAtISO);
    expect(due).toBeGreaterThan(NOW);
    expect(due - NOW).toBeLessThanOrEqual(7 * DAY_MS);
    expect(dedupeDate).toBe(dueAtISO.slice(0, 10));
  });
});

describe("audit pass (db-backed IO)", () => {
  it("samples only matured decisions, persists findings, advances the watermark, and upserts idempotently", async () => {
    const userId = `la-pass-${randomUUID().slice(0, 8)}`;
    const { audit } = await import("../src/lib/db");
    const { runLookaheadAuditPass } = await import("../src/lib/lookahead-audit");
    const { listLookaheadAuditFindings } = await import("../src/lib/db-lookahead-audit");
    const { hashQuery } = await import("../src/lib/rag-metering");
    const { deterministicFilingsRetrievalQuery } = await import("../src/lib/rag/information-routing");

    const bars = risingBars();
    const refPrice = 100 + DECISION_INDEX * 0.1;
    const truncated = bars.slice(0, DECISION_INDEX + 1);
    const { breakdown, tech } = await breakdownFromSeries(truncated, refPrice, 1_000_000);

    // Snapshot A: matured, clean AAPL decision — no candidate pool persisted for run-1.
    audit("signal_snapshot", { runId: "run-1", asOf: DECISION_AS_OF, signals: [evidenceFor(breakdown, tech, refPrice)] }, userId);
    // Snapshot B: matured MSFT decision with a persisted candidate pool (run-2) — RAG replays clean.
    audit(
      "signal_snapshot",
      { runId: "run-2", asOf: DECISION_AS_OF, signals: [{ symbol: "MSFT", chosen: false, regime: "risk_on" }] },
      userId
    );
    audit(
      "rag_candidate_pool",
      {
        runId: "run-2",
        symbol: "MSFT",
        queryHash: hashQuery(deterministicFilingsRetrievalQuery("MSFT")),
        asOf: DECISION_AS_OF,
        candidateCount: 2,
        candidates: [
          { id: "v1", used: true, asOf: "2026-07-01T00:00:00.000Z", docType: "10-k" },
          { id: "v2", used: false }
        ]
      },
      userId
    );
    // Snapshot C: NOT matured yet — must stop the scan without advancing past it.
    audit(
      "signal_snapshot",
      { runId: "run-3", asOf: "2026-08-11T15:00:00.000Z", signals: [{ symbol: "NVDA", chosen: true, regime: "risk_on" }] },
      userId
    );

    const result = await runLookaheadAuditPass(userId, {
      now: NOW,
      fetchOHLC: async (symbol) => (symbol === "AAPL" ? bars : null),
      retrieve: async () => [{ id: "v1", doc_type: "10-k", as_of: "2026-07-01T00:00:00.000Z" }],
      notifyOnMismatch: false
    });

    expect(result.sampled).toBe(2); // A + B; C is inside the outcome horizon
    expect(result.stoppedAtUnmatured).toBe(true);
    expect(result.mismatches).toBe(0);
    // 9 findings per decision: momentum, liquidity, 6 always-unverifiable factors, rag_evidence.
    expect(result.findings).toBe(18);

    const findings = listLookaheadAuditFindings(userId);
    expect(findings.length).toBe(18);
    const aaplRag = findings.find((f) => f.symbol === "AAPL" && f.factorOrField === "rag_evidence")!;
    expect(aaplRag.classification).toBe("unverifiable"); // pool never persisted for run-1
    expect(aaplRag.detail?.reason).toBe("candidate_pool_not_persisted");
    const msftRag = findings.find((f) => f.symbol === "MSFT" && f.factorOrField === "rag_evidence")!;
    expect(msftRag.classification).toBe("clean");
    expect(msftRag.persistedValue).toBe(1);
    // MSFT carried no factorBreakdown → factor replays are honest 'unverifiable', not fabricated.
    expect(findings.find((f) => f.symbol === "MSFT" && f.factorOrField === "momentum")!.classification).toBe("unverifiable");

    // Below the verdict floor (2 qualifying, floor 20) → honest 'insufficient_sample'.
    expect(result.verdict.verdict).toBe("insufficient_sample");
    expect(result.verdict.qualifying).toBe(3); // AAPL momentum + liquidity + MSFT rag_evidence

    // Second pass: the watermark sits at snapshot B; C is still unmatured — nothing re-sampled,
    // nothing duplicated.
    const again = await runLookaheadAuditPass(userId, {
      now: NOW,
      fetchOHLC: async () => bars,
      retrieve: async () => [],
      notifyOnMismatch: false
    });
    expect(again.sampled).toBe(0);
    expect(listLookaheadAuditFindings(userId).length).toBe(18);
  });

  it("flags a leaked decision as a mismatch pass with a mismatch verdict", async () => {
    const userId = `la-leak-${randomUUID().slice(0, 8)}`;
    const { audit } = await import("../src/lib/db");
    const { runLookaheadAuditPass } = await import("../src/lib/lookahead-audit");

    const leaked = barsWithFutureCrash();
    const refPrice = 100 + DECISION_INDEX * 0.1;
    const { breakdown, tech } = await breakdownFromSeries(leaked, refPrice, 1_000_000);
    audit("signal_snapshot", { runId: "run-leak", asOf: DECISION_AS_OF, signals: [evidenceFor(breakdown, tech, refPrice)] }, userId);

    const result = await runLookaheadAuditPass(userId, {
      now: NOW,
      fetchOHLC: async () => leaked,
      retrieve: async () => [],
      notifyOnMismatch: false
    });
    expect(result.mismatches).toBeGreaterThanOrEqual(1);
    expect(result.verdict.verdict).toBe("lookahead_mismatch_detected");
  });

  it("does NOT deliver lookahead_leak when the user has that event switched off — no force-include (owner ruling 2026-08-12)", async () => {
    const userId = `la-toggle-off-${randomUUID().slice(0, 8)}`;
    const { audit, getPolicy, setPolicy, listNotificationEvents } = await import("../src/lib/db");
    const { runLookaheadAuditPass } = await import("../src/lib/lookahead-audit");

    const policy = getPolicy(userId);
    setPolicy(
      {
        ...policy,
        notificationSettings: {
          ...policy.notificationSettings,
          enabledEvents: policy.notificationSettings.enabledEvents.filter((type) => type !== "lookahead_leak")
        }
      },
      userId
    );
    expect(getPolicy(userId).notificationSettings.enabledEvents).not.toContain("lookahead_leak");

    const leaked = barsWithFutureCrash();
    const refPrice = 100 + DECISION_INDEX * 0.1;
    const { breakdown, tech } = await breakdownFromSeries(leaked, refPrice, 1_000_000);
    audit(
      "signal_snapshot",
      { runId: "run-leak-toggle-off", asOf: DECISION_AS_OF, signals: [evidenceFor(breakdown, tech, refPrice)] },
      userId
    );

    const result = await runLookaheadAuditPass(userId, {
      now: NOW,
      fetchOHLC: async () => leaked,
      retrieve: async () => []
      // notifyOnMismatch defaults true — this test exists to prove delivery is still gated by the
      // user's real toggle even when the pass attempts to notify.
    });
    expect(result.mismatches).toBeGreaterThanOrEqual(1);
    expect(result.notified).toBe(true); // the attempt is made (sendNotification never throws here)

    const events = listNotificationEvents(userId, 50);
    const lookaheadEvent = events.find((event) => event.type === "lookahead_leak");
    expect(lookaheadEvent).toBeDefined();
    expect(lookaheadEvent?.status).toBe("skipped");
    expect(lookaheadEvent?.error).toBe("Notification type is disabled.");
  });
});
