import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { EquityPosition, MarketScan, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";
import { applyDeterministicSizing } from "../src/lib/strategy-risk";
import { setInternalSetting } from "../src/lib/db-settings";
import { SIGNAL_HEALTH_HORIZONS } from "../src/lib/signal-health";

// Conviction-size cap (panel finding): AI confidenceScore is a direct linear multiplier on size and
// a learned "fact" can inflate it. The 20-lot evidence floor only protects UNPROVEN theses, so a
// PROVEN-but-mediocre thesis could size up on confidence alone. The cap clamps confidence's UPSIDE
// contribution UNLESS the thesis's own realized edge corroborates it. It reads ONLY the realized
// scorecard stats (sourced from getThesisScorecard / getThesisRegimeScorecard over closed lots) +
// the proposal's own confidenceScore — NEVER learned_context (Phase-0 byte-identical invariant).

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-confcap-${randomUUID()}.db`)}`;
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

/** A buy proposal under the proven thesis/regime. confidenceScore drives raw conviction. */
function buyProposal(confidenceScore: number): TradeProposal {
  return {
    symbol: "NVDA",
    side: "buy",
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "entry",
    tradeThesisTag: THESIS,
    entryMarketRegime: REGIME,
    confidenceScore
  };
}

function shortProposal(confidenceScore: number): TradeProposal {
  return {
    ...buyProposal(confidenceScore),
    side: "short"
  };
}

/** Policy with a clean notional base: 10000 max, no NAV cap, conservative cap defaults left ON. */
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

/**
 * Seed `count` closed round-trips for THESIS @ REGIME on `account`. The first `wins` are winners
 * (+winPct%), the rest losers (-lossPct%). Each round-trip uses a unique symbol so FIFO lots don't
 * mix, and ascending filledAt. Thesis/regime are carried on the opening (buy) fill's raw.proposal.
 */
async function seedClosedLots(opts: {
  account: string;
  count: number;
  wins: number;
  winPct: number;
  lossPct: number;
  /** Defaults to insertFillEvent's own "local" default — pass explicitly only when a test needs
   *  fills scoped to a non-default userId (e.g. to isolate per-test drift-alarm state, which is
   *  keyed by the SAME userId passed to applyDeterministicSizing). */
  userId?: string;
}) {
  const { insertFillEvent } = await import("../src/lib/db");
  const { account, count, wins, winPct, lossPct, userId } = opts;
  let t = 0;
  for (let i = 0; i < count; i++) {
    const sym = `SYM${i}`;
    const entry = 100;
    const exit = i < wins ? entry * (1 + winPct / 100) : entry * (1 - lossPct / 100);
    insertFillEvent({
      userId,
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
      userId,
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

const NO_POSITIONS: EquityPosition[] = [];

function notionalFromRationale(p: TradeProposal): number {
  return p.dollarAmount ?? 0;
}

describe("conviction-size cap", () => {
  it("(a) proven + high confidence + mediocre realized stats → cap BINDS, size strictly smaller than corroborated, note present", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "CAP-A";
    // 20 closed lots (>= minLots, PROVEN). 10 winners (+2%) / 10 losers (-3%):
    //   shrunkWinRate  = round((10 + 0.5*5)/(20+5) * 100) = 50% (< 58, fails win-rate gate)
    //   shrunkAvgReturn = round((10*2 + 10*(-3))/(20+5), 2) = -0.4% (<= 0, fails edge gate)
    // => NOT corroborated; raw conviction 0.95 clamps to the 0.6 default cap.
    await seedClosedLots({ account, count: 20, wins: 10, winPct: 5, lossPct: 3 });
    setPolicy(policyFor(account));

    // Capped result (cap ON, default 0.6).
    const capped = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);

    // Corroborated-equivalent: SAME mediocre realized inputs, but cap effectively disabled
    // (convictionCapUncorroborated = 1 so Math.min(0.95, 1) = 0.95). Isolates exactly the cap's effect.
    const uncapped = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account, { convictionCapUncorroborated: 1 }),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    expect(notionalFromRationale(capped)).toBeGreaterThan(0);
    expect(notionalFromRationale(capped)).toBeLessThan(notionalFromRationale(uncapped)); // strictly smaller
    expect(capped.rationale).toContain("[Sizing] Conviction capped to 0.6");
    expect(capped.rationale).toContain("not yet corroborated by realized edge");
    // The corroborated-equivalent does NOT carry the cap note.
    expect(uncapped.rationale).not.toContain("Conviction capped");
  });

  it("(b) proven + high confidence + strong realized stats → cap does NOT bind; full conviction-scaled size; no note", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "CAP-B";
    // 20 closed lots. 18 winners (+5%) / 2 losers (-1%):
    //   shrunkWinRate  = round((18 + 2.5)/25 * 100) = 82% (>= 58)
    //   shrunkAvgReturn = round((18*5 + 2*(-1))/25, 2) = 3.52% (> 0)
    // => CORROBORATED; full raw conviction 0.95 applies, cap never binds.
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    const sized = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);

    // With the cap disabled the result is identical — proof the cap did not bind on strong stats.
    const uncapped = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account, { convictionCapUncorroborated: 1 }),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    expect(notionalFromRationale(sized)).toBe(notionalFromRationale(uncapped));
    expect(sized.rationale).not.toContain("Conviction capped");
  });

  it("(c) low confidence → size reduced regardless; cap does not touch the downside path", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "CAP-C";
    // Mediocre (uncorroborated) stats, identical to (a).
    await seedClosedLots({ account, count: 20, wins: 10, winPct: 5, lossPct: 3 });
    setPolicy(policyFor(account));

    const lowConf = applyDeterministicSizing(buyProposal(20), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const highConfCapped = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);

    // raw conviction 0.20 < cap 0.6 → cap is a no-op (Math.min(0.20, 0.6) = 0.20). Low confidence
    // still shrinks size, and is strictly smaller than the capped-high-confidence size (0.20 < 0.6).
    expect(lowConf.rationale).not.toContain("Conviction capped");
    expect(notionalFromRationale(lowConf)).toBeGreaterThan(0);
    expect(notionalFromRationale(lowConf)).toBeLessThan(notionalFromRationale(highConfCapped));
  });

  it("preserves an explicit LLM-advised notional when it is inside risk limits", async () => {
    const account = "CAP-LLM-A";
    const sized = applyDeterministicSizing(
      { ...buyProposal(95), dollarAmount: 499 },
      policyFor(account),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    expect(notionalFromRationale(sized)).toBe(499);
    expect(sized.rationale).toContain("LLM advised $499; preserved within risk limits.");
  });

  it("keeps LLM-advised opening sizes below the hard policy cap with execution headroom", async () => {
    const account = "CAP-LLM-HEADROOM";
    const sized = applyDeterministicSizing(
      { ...buyProposal(95), dollarAmount: 5 },
      { ...policyFor(account), maxOrderNotional: 4.99, maxDailyNotional: 100 },
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    expect(sized.dollarAmount).toBe(4.74);
    expect(sized.rationale).toContain("risk controls limited it");
    expect(sized.rationale).toContain("5% execution buffer");
  });

  it("keeps deterministic shorts below maxShortOrderNotional with execution headroom", async () => {
    const account = "CAP-SHORT-HEADROOM";
    const sized = applyDeterministicSizing(
      { ...shortProposal(95), dollarAmount: 100 },
      {
        ...policyFor(account),
        maxOrderNotional: 1000,
        maxShortOrderNotional: 100,
        shortSellingEnabled: true,
        riskRules: { ...DEFAULT_POLICY.riskRules, shortStopLossPct: 10 }
      },
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    expect(sized.dollarAmount).toBe(95);
    expect(sized.rationale).toContain("risk controls limited it");
    expect(sized.rationale).toContain("max short order limit");
    expect(sized.rationale).toContain("5% execution buffer");
  });

  it("preserves a larger explicit LLM-advised notional when hard caps allow it", async () => {
    const account = "CAP-LLM-B";
    const sized = applyDeterministicSizing(
      { ...buyProposal(95), dollarAmount: 9_000 },
      policyFor(account),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    expect(notionalFromRationale(sized)).toBe(9_000);
    expect(sized.rationale).toContain("LLM advised $9,000; preserved within risk limits.");
  });

  it("trims an explicit LLM-advised notional to remaining per-symbol capacity", async () => {
    const account = "CAP-LLM-C";
    const smallPortfolio: Portfolio = { ...PORTFOLIO, totalMarketValue: 10_000, buyingPower: 10_000, cash: 10_000 };
    const positions: EquityPosition[] = [{ symbol: "NVDA", quantity: 4, averageCost: 100, marketValue: 400 }];
    const sized = applyDeterministicSizing(
      { ...buyProposal(95), dollarAmount: 900 },
      { ...policyFor(account), maxSymbolExposurePct: 5 },
      smallPortfolio,
      "paper",
      "local",
      positions
    );

    expect(notionalFromRationale(sized)).toBe(100);
    expect(sized.rationale).toContain("risk controls limited it to $100");
    expect(sized.rationale).toContain("5% NVDA exposure cap");
  });

  it("trims an explicit LLM-advised notional to remaining sector capacity", async () => {
    const account = "CAP-LLM-D";
    const smallPortfolio: Portfolio = { ...PORTFOLIO, totalMarketValue: 10_000, buyingPower: 10_000, cash: 10_000 };
    const positions: EquityPosition[] = [{ symbol: "MSFT", quantity: 12, averageCost: 200, marketValue: 2_400, sector: "Technology" }];
    const marketScan = {
      sectorBySymbol: { NVDA: "Technology" },
      quotesBySymbol: {},
      topCandidates: []
    } as unknown as MarketScan;
    const sized = applyDeterministicSizing(
      { ...buyProposal(95), dollarAmount: 900 },
      { ...policyFor(account), sectorCaps: { Technology: 25 } },
      smallPortfolio,
      "paper",
      "local",
      positions,
      marketScan
    );

    expect(notionalFromRationale(sized)).toBe(100);
    expect(sized.rationale).toContain("risk controls limited it to $100");
    expect(sized.rationale).toContain("Technology sector cap");
  });

  it("(d) unproven thesis (< minLots) stays pinned to the sizing floor (existing behavior preserved)", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "CAP-D";
    // Only 3 closed lots (< 20 minLots) under the thesis → UNPROVEN. High confidence must NOT size up.
    await seedClosedLots({ account, count: 3, wins: 0, winPct: 2, lossPct: 3 });
    setPolicy(policyFor(account));

    const sized = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);

    // floor = 10% of 10000 = 1000. Pinned to floor; reports the exploratory reason, not the cap note.
    expect(notionalFromRationale(sized)).toBe(1000);
    expect(sized.rationale).toContain("EXPLORATORY floor");
    expect(sized.rationale).not.toContain("Conviction capped");
  });

  it("(e) sizing is deterministic: identical inputs produce identical output", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "CAP-E";
    await seedClosedLots({ account, count: 20, wins: 10, winPct: 2, lossPct: 3 });
    setPolicy(policyFor(account));

    const a = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const b = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);

    expect(notionalFromRationale(a)).toBe(notionalFromRationale(b));
    expect(a.rationale).toBe(b.rationale);
  });
});

// Signal-health auto-throttle (opt-in — policy.tuning.signalHealthAutoThrottle, default OFF):
// while a CONFIRMED drift alarm is active (src/lib/signal-health.ts's signalHealthDriftActive,
// read at strategy-risk.ts ~lines 541-547), conviction's upside is capped at the SAME
// convictionCapUncorroborated value even for a thesis that WOULD otherwise be corroborated by
// realized edge. Seeds the drift alarm exactly the way production reads it: a `settings` row at
// signal-health.ts's private driftStateKey format (`signal_health:drift:{userId}:{horizon}`) —
// there is no public seam to inject drift state, so this mirrors the on-disk contract directly
// rather than running the full observation → detectDrift → runSignalHealthRefresh pipeline.
function seedActiveDriftAlarm(userId: string, horizon: string = SIGNAL_HEALTH_HORIZONS[0]): void {
  setInternalSetting(`signal_health:drift:${userId}:${horizon}`, {
    active: true,
    horizon,
    detectedAt: "2026-06-01",
    rankIC: -0.2,
    slope: -0.01,
    trailingDeclines: 3
  });
}

describe("signal-health auto-throttle (drift alarm caps conviction upside)", () => {
  // Corroborated stats identical in shape to case (b) above: 18 winners (+5%) / 2 losers (-1%)
  // clears both the win-rate and edge corroboration gates, so WITHOUT the throttle raw conviction
  // 0.95 rides through uncapped. Fills are seeded under `userId` explicitly — the scorecard lookup
  // (getThesisRegimeScorecard/getThesisScorecard) is scoped by (account, userId), and it's the SAME
  // userId that signalHealthDriftActive reads the drift alarm under, so both must line up.
  async function seedCorroboratedStats(account: string, userId: string) {
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1, userId });
  }

  it("(f) ACTIVE drift + throttle ON caps conviction upside at convictionCapUncorroborated on an otherwise-corroborated thesis, with a confidence_capped_signal_drift receipt", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "CAP-DRIFT-F";
    const userId = `drift-throttle-${randomUUID()}`;
    await seedCorroboratedStats(account, userId);
    setPolicy(policyFor(account), userId);
    seedActiveDriftAlarm(userId);

    const throttled = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account, { signalHealthAutoThrottle: true }),
      PORTFOLIO,
      "paper",
      userId,
      NO_POSITIONS
    );
    // Same corroborated inputs, throttle knob OFF — the pre-existing corroborated-thesis behavior
    // (case (b)): raw conviction rides through uncapped despite the active drift row in the DB.
    const baseline = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account),
      PORTFOLIO,
      "paper",
      userId,
      NO_POSITIONS
    );

    expect(notionalFromRationale(throttled)).toBeGreaterThan(0);
    expect(notionalFromRationale(throttled)).toBeLessThan(notionalFromRationale(baseline));
    expect(throttled.rationale).toContain("60% AI conviction"); // convictionCapUncorroborated default 0.6
    expect(baseline.rationale).toContain("95% AI conviction"); // uncapped — proves the throttle, not the stats, did this
    expect(throttled.dataAdjustments?.some((note) => note.startsWith("confidence_capped_signal_drift"))).toBe(true);
    expect(baseline.dataAdjustments ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(/^confidence_capped_signal_drift/)]));
  });

  it("(g) throttle knob OFF (default): an active drift alarm never caps sizing — corroborated-thesis behavior is untouched", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "CAP-DRIFT-G";
    const userId = `drift-throttle-off-${randomUUID()}`;
    await seedCorroboratedStats(account, userId);
    setPolicy(policyFor(account), userId);
    seedActiveDriftAlarm(userId); // active drift row present for this exact userId

    const sized = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", userId, NO_POSITIONS);

    expect(sized.rationale).toContain("95% AI conviction"); // uncapped — the drift row is never read
    expect(sized.rationale).not.toContain("Conviction capped");
    expect(sized.dataAdjustments ?? []).toEqual([]);
  });

  it("(h) throttle knob ON but NO active drift: sizing is unchanged from the knob-off case", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "CAP-DRIFT-H";
    const userId = `drift-throttle-nodrift-${randomUUID()}`; // no seedActiveDriftAlarm call for this userId
    await seedCorroboratedStats(account, userId);
    setPolicy(policyFor(account), userId);

    const throttleOnNoDrift = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account, { signalHealthAutoThrottle: true }),
      PORTFOLIO,
      "paper",
      userId,
      NO_POSITIONS
    );
    const throttleOff = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", userId, NO_POSITIONS);

    expect(notionalFromRationale(throttleOnNoDrift)).toBe(notionalFromRationale(throttleOff));
    expect(throttleOnNoDrift.rationale).toContain("95% AI conviction");
    expect(throttleOnNoDrift.dataAdjustments ?? []).toEqual([]);
  });
});
