/**
 * Auditable proposal repair-ladder receipts (TradeProposal.dataAdjustments — dsa lesson: receipts):
 * deterministic post-generation consistency checks whose corrections are VISIBLE, kind-prefixed,
 * machine-queryable receipts — never silent edits, never blocks.
 *   1. sessionPhrasingReceipt (proposal-phase-guard.ts): rationale timing language vs the actual
 *      market session — conservative, null on unknown session, never rewrites the rationale.
 *   2. degradedCoreInputs + the confidenceCapDataDegraded sizing cap (strategy-risk.ts): honest
 *      per-symbol scan-quote signal; cap mechanics mirror convictionCapUncorroborated exactly.
 *   3. enrichOpeningProposal receipts (strategy.ts): the ATR>beta>flat bracket-stop fallback and
 *      the existing [Risk]/[Execution] disclosures also emit matching receipts; rationale text is
 *      byte-identical to before.
 *   4. Persistence: dataAdjustments survives the whole trade_proposals JSON round trip, including
 *      the approval-time reprice writer.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { degradedCoreInputs, sessionPhrasingReceipt } from "../src/lib/proposal-phase-guard";
import { applyDeterministicSizing } from "../src/lib/strategy-risk";
import { enrichOpeningProposal } from "../src/lib/strategy";
import type { EquityPosition, MarketQuote, MarketScan, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-dataadj-${randomUUID()}.db`)}`;
});

const THESIS = "Momentum-Breakout";
const REGIME = "Tech-Bull";

const PORTFOLIO: Portfolio = {
  accountNumber: "A",
  totalMarketValue: 1_000_000,
  buyingPower: 1_000_000,
  equityMarketValue: 0,
  optionMarketValue: 0,
  cash: 1_000_000
};

const NO_POSITIONS: EquityPosition[] = [];

function buyProposal(confidenceScore: number, over: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol: "NVDA",
    side: "buy",
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "entry",
    tradeThesisTag: THESIS,
    entryMarketRegime: REGIME,
    confidenceScore,
    ...over
  };
}

function policyFor(account: string, tuning?: TradingPolicy["tuning"]): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber: account,
    maxOrderNotional: 10_000,
    maxOrderPctOfNav: undefined,
    scoringWeights: { ...DEFAULT_POLICY.scoringWeights },
    tuning
  };
}

function quote(partial: Partial<MarketQuote> & { symbol: string; price: number }): MarketQuote {
  return {
    volume: 1_000_000,
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 1,
    ...partial
  } as MarketQuote;
}

function scanWith(quotes: MarketQuote[]): MarketScan {
  return {
    source: "test",
    generatedAt: "2026-08-12T00:00:00.000Z",
    scannedSymbols: quotes.length,
    returnedQuotes: quotes.length,
    topCandidates: quotes,
    sectorBySymbol: {},
    quotesBySymbol: Object.fromEntries(
      quotes.map((q) => [q.symbol, { symbol: q.symbol, price: q.price, score: q.score, beta: q.beta, fieldObservations: q.fieldObservations }])
    ),
    warnings: []
  };
}

/** Seed `count` closed round-trips for THESIS @ REGIME (same shape as conviction-size-cap tests). */
async function seedClosedLots(opts: { account: string; count: number; wins: number; winPct: number; lossPct: number }) {
  const { insertFillEvent } = await import("../src/lib/db");
  const { account, count, wins, winPct, lossPct } = opts;
  let t = 0;
  for (let i = 0; i < count; i++) {
    const sym = `SYM${i}`;
    const entry = 100;
    const exit = i < wins ? entry * (1 + winPct / 100) : entry * (1 - lossPct / 100);
    insertFillEvent({
      accountNumber: account,
      source: "paper",
      symbol: sym,
      side: "buy",
      quantity: 1,
      price: entry,
      notional: entry,
      status: "filled",
      filledAt: `2026-06-15T00:${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t++ % 60).padStart(2, "0")}.000Z`,
      raw: { proposal: { tradeThesisTag: THESIS, entryMarketRegime: REGIME } }
    });
    insertFillEvent({
      accountNumber: account,
      source: "paper",
      symbol: sym,
      side: "sell",
      quantity: 1,
      price: exit,
      notional: exit,
      status: "filled",
      filledAt: `2026-06-15T00:${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t++ % 60).padStart(2, "0")}.000Z`
    });
  }
}

describe("sessionPhrasingReceipt", () => {
  it("flags immediate-action phrasing while the market is closed", () => {
    const receipt = sessionPhrasingReceipt("Strong setup — buy now before the crowd notices.", "closed");
    expect(receipt).not.toBeNull();
    expect(receipt).toMatch(/^session_phrase_mismatch: /);
    expect(receipt).toContain('"buy now"');
    expect(receipt).toContain("closed");
  });

  it("flags immediate-action phrasing during premarket, naming the session", () => {
    const receipt = sessionPhrasingReceipt("Enter at the open on the gap continuation.", "pre");
    expect(receipt).toMatch(/^session_phrase_mismatch: /);
    expect(receipt).toContain('"at the open"');
    expect(receipt).toContain("premarket");
  });

  it("is case-insensitive", () => {
    expect(sessionPhrasingReceipt("BUY NOW — momentum is here.", "closed")).toMatch(/^session_phrase_mismatch: /);
  });

  it("does NOT flag immediate-action phrasing during the regular session", () => {
    expect(sessionPhrasingReceipt("Buy now on the breakout.", "regular")).toBeNull();
  });

  it("flags end-of-day recap phrasing during the regular session", () => {
    const receipt = sessionPhrasingReceipt("The name closed up 4% after earnings and momentum persists.", "regular");
    expect(receipt).toMatch(/^session_phrase_mismatch: /);
    expect(receipt).toContain('"closed up"');
  });

  it("does NOT flag recap phrasing while the market is closed (that phrasing is correct then)", () => {
    expect(sessionPhrasingReceipt("The name closed up 4% after earnings.", "closed")).toBeNull();
  });

  it("fires nothing after-hours (neither phrase list applies to the post session)", () => {
    expect(sessionPhrasingReceipt("Buy now — after the close it closed up.", "post")).toBeNull();
  });

  it("returns null on an unknown session — no signal, no claim", () => {
    expect(sessionPhrasingReceipt("Buy now.", null)).toBeNull();
    expect(sessionPhrasingReceipt("Buy now.", undefined)).toBeNull();
  });

  it("returns null for neutral phrasing in every session", () => {
    for (const session of ["closed", "pre", "regular", "post"] as const) {
      expect(sessionPhrasingReceipt("Accumulate on weakness with a 2% stop below support.", session)).toBeNull();
    }
  });

  it("returns null for an empty/absent rationale", () => {
    expect(sessionPhrasingReceipt("", "closed")).toBeNull();
    expect(sessionPhrasingReceipt(undefined, "closed")).toBeNull();
  });
});

describe("degradedCoreInputs", () => {
  it("claims nothing without a marketScan (no signal at the seam)", () => {
    expect(degradedCoreInputs("NVDA", undefined)).toEqual([]);
    expect(degradedCoreInputs("NVDA", null)).toEqual([]);
  });

  it("claims nothing for an empty vestigial scan", () => {
    expect(degradedCoreInputs("NVDA", scanWith([]))).toEqual([]);
  });

  it("names a missing quote when the scan carries candidates but none for the symbol", () => {
    expect(degradedCoreInputs("NVDA", scanWith([quote({ symbol: "AAPL", price: 200 })]))).toEqual([
      "no scan quote for the symbol"
    ]);
  });

  it("names a non-positive price", () => {
    expect(degradedCoreInputs("NVDA", scanWith([quote({ symbol: "NVDA", price: 0 })]))).toEqual([
      "no positive price on the scan quote"
    ]);
  });

  it("names the all-providers-failed enrichment stamp", () => {
    const degraded = quote({
      symbol: "NVDA",
      price: 100,
      fieldObservations: { price: { source: "enrichment-cascade", fetchedAt: "2026-08-12T00:00:00.000Z", status: "failed" } }
    });
    expect(degradedCoreInputs("NVDA", scanWith([degraded]))).toEqual(["enrichment failed across all providers"]);
  });

  it("returns [] for a healthy quote", () => {
    expect(degradedCoreInputs("NVDA", scanWith([quote({ symbol: "NVDA", price: 100 })]))).toEqual([]);
  });
});

describe("degraded-data confidence cap (confidenceCapDataDegraded)", () => {
  const HEALTHY = () => scanWith([quote({ symbol: "NVDA", price: 100 })]);
  const MISSING = () => scanWith([quote({ symbol: "AAPL", price: 200 })]);

  it("caps conviction to the 0.7 default on degraded inputs and appends the receipt; math mirrors the uncorroborated cap (Math.min upside-only)", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "DEG-A";
    // Corroborated stats (18 wins +5% / 2 losses -1%) so convictionCapUncorroborated never binds and
    // this test isolates the degraded cap: raw conviction 0.95 → Math.min(0.95, 0.7) = 0.70.
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    const healthy = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS, HEALTHY());
    const degraded = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS, MISSING());
    // Mirror check: capping 0.95 to 0.7 must size exactly like an honest conviction of 0.70.
    const conf70 = applyDeterministicSizing(buyProposal(70), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS, HEALTHY());

    expect(degraded.dollarAmount).toBeGreaterThan(0);
    expect(degraded.dollarAmount).toBeLessThan(healthy.dollarAmount ?? 0);
    expect(degraded.dollarAmount).toBe(conf70.dollarAmount);
    expect(degraded.dataAdjustments).toHaveLength(1);
    expect(degraded.dataAdjustments?.[0]).toMatch(/^confidence_capped_degraded_data: /);
    expect(degraded.dataAdjustments?.[0]).toContain("no scan quote for the symbol");
    // Healthy inputs: no cap, no receipt.
    expect(healthy.dataAdjustments).toBeUndefined();
    expect(conf70.dataAdjustments).toBeUndefined();
  });

  it("caps on the all-providers-failed enrichment stamp too, naming that input", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "DEG-B";
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    const failedObs = scanWith([
      quote({
        symbol: "NVDA",
        price: 100,
        fieldObservations: { price: { source: "enrichment-cascade", fetchedAt: "2026-08-12T00:00:00.000Z", status: "failed" } }
      })
    ]);
    const sized = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS, failedObs);
    expect(sized.dataAdjustments?.[0]).toMatch(/^confidence_capped_degraded_data: /);
    expect(sized.dataAdjustments?.[0]).toContain("enrichment failed across all providers");
  });

  it("knob semantics mirror convictionCapUncorroborated: an explicit 1 never binds (disabled)", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "DEG-C";
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    const healthy = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS, HEALTHY());
    const disabled = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account, { confidenceCapDataDegraded: 1 }),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      MISSING()
    );
    expect(disabled.dollarAmount).toBe(healthy.dollarAmount);
    expect(disabled.dataAdjustments).toBeUndefined();
  });

  it("an explicit 0 removes confidence's contribution (floors at the exploratory band) and still receipts", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "DEG-D";
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    const zeroed = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account, { confidenceCapDataDegraded: 0 }),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      MISSING()
    );
    // Multiplier collapses to 0 → clamped to the 10% sizing floor of maxOrderNotional 10000.
    expect(zeroed.dollarAmount).toBe(1000);
    expect(zeroed.dataAdjustments?.[0]).toMatch(/^confidence_capped_degraded_data: /);
  });

  it("no marketScan → no claim, no cap, no receipt", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "DEG-E";
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    const healthy = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS, HEALTHY());
    const noScan = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    expect(noScan.dollarAmount).toBe(healthy.dollarAmount);
    expect(noScan.dataAdjustments).toBeUndefined();
  });

  it("appends to (never replaces) receipts already on the proposal", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "DEG-F";
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    const prior = "session_phrase_mismatch: prior receipt";
    const sized = applyDeterministicSizing(
      buyProposal(95, { dataAdjustments: [prior] }),
      policyFor(account),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      MISSING()
    );
    expect(sized.dataAdjustments).toHaveLength(2);
    expect(sized.dataAdjustments?.[0]).toBe(prior);
    expect(sized.dataAdjustments?.[1]).toMatch(/^confidence_capped_degraded_data: /);
  });
});

describe("enrichOpeningProposal repair receipts", () => {
  const alpacaPolicy = (over: Partial<TradingPolicy> = {}): TradingPolicy => ({
    ...DEFAULT_POLICY,
    accountNumber: "ENR",
    activeBroker: "alpaca",
    ...over
  });

  it("stop leg attached by the flat fallback carries a bracket_stop_fallback_flat receipt; rationale is untouched", () => {
    // atrStops is ON by default but no ATR precompute is supplied, and the quote has no beta →
    // the flat riskRules.stopLossPct (8%) fills in.
    const enriched = enrichOpeningProposal(
      buyProposal(80, { dollarAmount: 1000 }),
      alpacaPolicy(),
      scanWith([quote({ symbol: "NVDA", price: 100 })])
    );
    expect(enriched.bracketStopLoss).toBe(92);
    expect(enriched.dataAdjustments).toContainEqual(expect.stringMatching(/^bracket_stop_fallback_flat: /));
    expect(enriched.rationale).toBe("entry"); // receipts never rewrite the rationale
  });

  it("names ATR as the fallback source when the ATR precompute supplies the distance", () => {
    const enriched = enrichOpeningProposal(
      buyProposal(80, { dollarAmount: 1000 }),
      alpacaPolicy(),
      scanWith([quote({ symbol: "NVDA", price: 100 })]),
      { NVDA: 5 }
    );
    expect(enriched.bracketStopLoss).toBe(95);
    expect(enriched.dataAdjustments).toContainEqual(expect.stringMatching(/^bracket_stop_fallback_atr: /));
  });

  it("names beta as the fallback source when only beta-scaling applies", () => {
    const enriched = enrichOpeningProposal(
      buyProposal(80, { dollarAmount: 1000 }),
      alpacaPolicy(),
      scanWith([quote({ symbol: "NVDA", price: 100, beta: 2 })])
    );
    expect(enriched.bracketStopLoss).toBe(84); // 8% flat × beta 2 = 16% below 100
    expect(enriched.dataAdjustments).toContainEqual(expect.stringMatching(/^bracket_stop_fallback_beta: /));
  });

  it("receipts a wrong-side LLM stop discard alongside the fallback repricing", () => {
    // A stop ABOVE entry on a long is nonsense — today it is silently discarded; now it receipts.
    const enriched = enrichOpeningProposal(
      buyProposal(80, { dollarAmount: 1000, bracketStopLoss: 120 }),
      alpacaPolicy(),
      scanWith([quote({ symbol: "NVDA", price: 100 })])
    );
    expect(enriched.bracketStopLoss).toBe(92); // fallback repriced it
    expect(enriched.dataAdjustments).toContainEqual(expect.stringMatching(/^bracket_stop_invalid_discarded: /));
    expect(enriched.dataAdjustments).toContainEqual(expect.stringMatching(/^bracket_stop_fallback_flat: /));
  });

  it("receipts a wrong-side LLM take-profit discard", () => {
    const enriched = enrichOpeningProposal(
      buyProposal(80, { dollarAmount: 1000, bracketTakeProfit: 90 }),
      alpacaPolicy(),
      scanWith([quote({ symbol: "NVDA", price: 100 })])
    );
    expect(enriched.dataAdjustments).toContainEqual(expect.stringMatching(/^bracket_take_profit_invalid_discarded: /));
  });

  it("sub-share bracket skip emits its receipt at the same site as the existing [Risk] disclosure", () => {
    const enriched = enrichOpeningProposal(
      buyProposal(80, { dollarAmount: 50 }),
      alpacaPolicy(),
      scanWith([quote({ symbol: "NVDA", price: 100 })])
    );
    expect(enriched.rationale).toContain("[Risk] Native Alpaca bracket skipped");
    expect(enriched.dataAdjustments).toContainEqual(expect.stringMatching(/^bracket_skip_subshare: /));
  });

  it("marketable-limit conversion emits its receipt at the same site as the [Execution] disclosure", () => {
    const enriched = enrichOpeningProposal(
      buyProposal(80, { dollarAmount: 1000 }),
      alpacaPolicy({ marketableLimitEntries: true }),
      scanWith([quote({ symbol: "NVDA", price: 100, ask: 100.1, bid: 99.9 })])
    );
    expect(enriched.type).toBe("limit");
    expect(enriched.rationale).toContain("[Execution] Marketable-limit entry");
    expect(enriched.dataAdjustments).toContainEqual(expect.stringMatching(/^marketable_limit_entry: /));
  });

  it("emits no receipts when nothing needed repair (whole-share order with a valid LLM stop)", () => {
    const enriched = enrichOpeningProposal(
      buyProposal(80, { dollarAmount: 1000, bracketStopLoss: 91, bracketTakeProfit: 125 }),
      alpacaPolicy(),
      scanWith([quote({ symbol: "NVDA", price: 100 })])
    );
    expect(enriched.bracketStopLoss).toBe(91); // the LLM's own valid stop is honored
    expect(enriched.dataAdjustments).toBeUndefined();
  });
});

describe("dataAdjustments persistence round-trip", () => {
  it("survives insertProposal → getProposal → listPendingProposals → reprice rewrite", async () => {
    const { getProposal, insertProposal, listPendingProposals, updatePendingProposalReprice } = await import("../src/lib/db");
    const receipts = [
      "session_phrase_mismatch: recorded at parse time",
      "bracket_stop_fallback_flat: recorded at enrichment time"
    ];
    const id = randomUUID();
    insertProposal({
      id,
      runId: randomUUID(),
      accountNumber: "RECEIPTS",
      proposal: { ...buyProposal(80, { dollarAmount: 500, referencePrice: 100 }), dataAdjustments: receipts },
      decision: { approved: true, reasons: [] },
      status: "proposed"
    });

    const stored = getProposal(id);
    expect(stored?.proposal.dataAdjustments).toEqual(receipts);

    const pending = listPendingProposals("RECEIPTS");
    expect(pending.find((row) => row.id === id)?.proposal.dataAdjustments).toEqual(receipts);

    // The approval-time reprice writer rewrites the whole proposal JSON — receipts must ride along.
    const repriced = { ...stored!.proposal, limitPrice: 101 };
    expect(updatePendingProposalReprice(id, { proposal: repriced })).toBe(true);
    expect(getProposal(id)?.proposal.dataAdjustments).toEqual(receipts);
  });
});
