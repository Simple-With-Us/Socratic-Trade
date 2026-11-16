import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { EquityPosition, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";
import { applyDeterministicSizing } from "../src/lib/strategy-risk";

// Fractional-Kelly sizing integration (policy.tuning.fractionalKellySizing, default OFF). Runs
// BESIDE the existing Kelly-lite edgeFactor multiplier in applyDeterministicSizing — never
// replaces it. Flag OFF: sizing must be byte-identical to today; a rationale receipt still
// appears whenever the bucket clears the sample gate and has a computable payoff ratio. Flag ON:
// final size = min(existing multiplier, kelly-suggested multiplier) — Kelly may only REDUCE size.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-kelly-sizing-${randomUUID()}.db`)}`;
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

function buyProposal(confidenceScore: number, thesisTag = THESIS, regime = REGIME): TradeProposal {
  return {
    symbol: "NVDA",
    side: "buy",
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "entry",
    tradeThesisTag: thesisTag,
    entryMarketRegime: regime,
    confidenceScore
  };
}

function shortProposal(confidenceScore: number, thesisTag = THESIS, regime = REGIME): TradeProposal {
  return { ...buyProposal(confidenceScore, thesisTag, regime), side: "short" };
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

/**
 * Seed `count` closed round-trips for thesis/regime on `account`. First `wins` lots are winners
 * (+winPct%), the rest losers (-lossPct%). Each round-trip uses a unique symbol so FIFO lots don't
 * mix, ascending filledAt. Mirrors test/conviction-size-cap.test.ts's seedClosedLots helper.
 */
async function seedClosedLots(opts: {
  account: string;
  thesisTag?: string;
  regime?: string;
  count: number;
  wins: number;
  winPct: number;
  lossPct: number;
}) {
  const { insertFillEvent } = await import("../src/lib/db");
  const { account, thesisTag = THESIS, regime = REGIME, count, wins, winPct, lossPct } = opts;
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
      raw: { proposal: { tradeThesisTag: thesisTag, entryMarketRegime: regime } }
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

function notionalFromRationale(p: TradeProposal): number {
  return p.dollarAmount ?? 0;
}

describe("fractional-Kelly sizing", () => {
  it("flag OFF: sizing is byte-identical to baseline, but the informational receipt still appears", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "KELLY-OFF";
    // 20 lots: 12 winners @ +10%, 8 losers @ -5%. shrunkWinRate=58 (corroborated), shrunkAvgReturn=3.2%.
    await seedClosedLots({ account, count: 20, wins: 12, winPct: 10, lossPct: 5 });
    setPolicy(policyFor(account));

    const withoutFlag = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const explicitOff = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account, { fractionalKellySizing: false }),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    // Byte-identical dollarAmount whether the flag key is absent or explicitly false.
    expect(notionalFromRationale(withoutFlag)).toBe(notionalFromRationale(explicitOff));
    // Kelly's suggested multiplier (~0.094) is well below the existing bounded multiplier (~0.551)
    // for these stats, so the receipt should show up even though nothing was applied.
    expect(withoutFlag.rationale).toContain("[Sizing] Fractional-Kelly");
    expect(withoutFlag.rationale).toContain("informational only, not applied");
    expect(withoutFlag.rationale).not.toContain("— applied");
  });

  it("flag ON: size = min(existing multiplier, kelly suggestion) when kelly is smaller, note says applied", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "KELLY-ON";
    await seedClosedLots({ account, count: 20, wins: 12, winPct: 10, lossPct: 5 });
    setPolicy(policyFor(account));

    const baseline = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const withKelly = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account, { fractionalKellySizing: true }),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    expect(notionalFromRationale(withKelly)).toBeGreaterThan(0);
    expect(notionalFromRationale(withKelly)).toBeLessThan(notionalFromRationale(baseline));
    expect(withKelly.rationale).toContain("[Sizing] Fractional-Kelly");
    expect(withKelly.rationale).toContain("— applied");
    expect(withKelly.rationale).not.toContain("informational only");

    // Sanity-check the hand-computed suggested multiplier printed in the note: p=0.58, b=2,
    // sigma_down=sqrt(10)=3.16, penalty=(3.2/3.16 clamped to 2)/2=0.506, half-Kelly f*=0.37 ->
    // suggested ~= 0.37*0.5*0.506 = 0.0936 -> ~9% of max.
    expect(withKelly.rationale).toMatch(/suggests 9% of max/);
  });

  it("thin bucket (< minTrades) -> no Kelly note at all, no size change", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "KELLY-THIN";
    // Only 5 closed lots (< default minClosedLotsForWeightShift=20) -> unproven, exploratory floor applies
    // regardless of Kelly; the Kelly note itself must be suppressed exactly like other trust-the-stats notes.
    await seedClosedLots({ account, count: 5, wins: 3, winPct: 10, lossPct: 5 });
    setPolicy(policyFor(account));

    const off = applyDeterministicSizing(buyProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const on = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account, { fractionalKellySizing: true }),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    expect(off.rationale).not.toContain("Fractional-Kelly");
    expect(on.rationale).not.toContain("Fractional-Kelly");
    expect(notionalFromRationale(off)).toBe(notionalFromRationale(on));
    expect(off.rationale).toContain("EXPLORATORY floor");
  });

  it("bucket with no losers (b uncomputable) -> no Kelly note, never fabricates a payoff ratio", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "KELLY-NOLOSS";
    await seedClosedLots({ account, count: 20, wins: 20, winPct: 8, lossPct: 5 });
    setPolicy(policyFor(account));

    const sized = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account, { fractionalKellySizing: true }),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    expect(sized.rationale).not.toContain("Fractional-Kelly");
  });

  it("shorts: receipt marks the payoff split as uncalibrated", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "KELLY-SHORT";
    await seedClosedLots({ account, count: 20, wins: 12, winPct: 10, lossPct: 5 });
    setPolicy(policyFor(account));

    const sized = applyDeterministicSizing(shortProposal(95), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);

    expect(sized.rationale).toContain("[Sizing] Fractional-Kelly");
    expect(sized.rationale).toContain("(short: uncalibrated)");
  });

  it("kellyFraction tuning knob changes the suggested multiplier (quarter-Kelly vs half-Kelly)", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "KELLY-FRACTION";
    await seedClosedLots({ account, count: 20, wins: 12, winPct: 10, lossPct: 5 });
    setPolicy(policyFor(account));

    const half = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account, { fractionalKellySizing: true, kellyFraction: 0.5 }),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );
    const quarter = applyDeterministicSizing(
      buyProposal(95),
      policyFor(account, { fractionalKellySizing: true, kellyFraction: 0.25 }),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    expect(notionalFromRationale(quarter)).toBeLessThan(notionalFromRationale(half));
  });

  it("safety invariant: Kelly may only REDUCE size — even when the suggested multiplier is HIGHER than the existing bounded multiplier, flag ON must stay byte-identical to flag OFF (guarded by suggestedPctOfCeiling < boundedMultiplier)", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "KELLY-GUARD-NO-INCREASE";
    // 60 lots, 59 winners @ +1%, 1 loser @ -1%, low confidenceScore (50, uncorroborated conviction
    // cap 0.6): the existing Kelly-lite multiplier lands at ~33% of max (95% shrunkWinRate * 0.5
    // conviction cap * 0.7 edgeFactor), while the raw Kelly payoff suggestion (p=.95, b=1, full
    // penalty since avgReturn > 2*sigma_down) computes to ~45% of max — i.e. suggested > existing.
    // This is exactly the scenario the `suggestedPctOfCeiling < boundedMultiplier` guard in
    // applyKelly (strategy.ts) exists for: without it, Kelly would size UP. Verified by mutation:
    // relaxing the guard to `=== true` (dropping the reduce-only check) makes this test fail
    // (dollarAmount goes from $3,324 to $4,536, and the note flips to "— applied").
    await seedClosedLots({ account, count: 60, wins: 59, winPct: 1, lossPct: 1 });
    setPolicy(policyFor(account));

    const off = applyDeterministicSizing(buyProposal(50), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const on = applyDeterministicSizing(
      buyProposal(50),
      policyFor(account, { fractionalKellySizing: true }),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    // Sanity: confirm the fixture actually produces suggested > existing (45% > 33%), i.e. this
    // test is exercising the "Kelly wants to size UP" branch, not a vacuously-passing case.
    expect(off.rationale).toMatch(/suggests 45% of max/);
    expect(off.rationale).toMatch(/fallback sized to \$3,324 \(33% of max\)/);

    // The invariant: flag ON must NOT increase size above flag OFF, even though Kelly's own
    // suggestion is numerically higher than the pre-existing multiplier.
    expect(notionalFromRationale(on)).toBe(notionalFromRationale(off));
    expect(on.rationale).toContain("informational only, not applied");
    expect(on.rationale).not.toContain("— applied");
  });

  it("audit event sizing_fractional_kelly_applied is recorded only when Kelly actually changes size", async () => {
    const { setPolicy, listAuditByKind } = await import("../src/lib/db");
    const account = "KELLY-AUDIT";
    const symbol = "KLYAUD";
    await seedClosedLots({ account, count: 20, wins: 12, winPct: 10, lossPct: 5 });
    setPolicy(policyFor(account));
    const proposal: TradeProposal = { ...buyProposal(95), symbol };

    applyDeterministicSizing(proposal, policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    // Filter to THIS test's distinguishing symbol — listAuditByKind is not account-scoped, and other
    // tests in this file also emit this audit kind, so an absolute/global count would be order-dependent.
    const eventsWhenOff = listAuditByKind("sizing_fractional_kelly_applied", 500, "local").filter(
      (e) => (e.payload as { symbol?: string })?.symbol === symbol
    );
    expect(eventsWhenOff.length).toBe(0);

    applyDeterministicSizing(
      proposal,
      policyFor(account, { fractionalKellySizing: true }),
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );
    const eventsWhenOn = listAuditByKind("sizing_fractional_kelly_applied", 500, "local").filter(
      (e) => (e.payload as { symbol?: string })?.symbol === symbol
    );
    expect(eventsWhenOn.length).toBe(1);
  });
});
