import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { TradeProposal, TradingPolicy } from "../src/lib/types";
import {
  assessProtectiveExitRepriceDrift,
  extendedHoursExitBufferBps,
  marketableLimitExitPrice,
  protectiveExitMarketSession,
  repriceStoredProtectiveExit,
  resolveProtectiveExitRouting
} from "../src/lib/protective-exit-routing";
import { generateProactiveRiskProposals } from "../src/lib/strategy";

// Build a UTC Date at a given ET wall-clock time. June is always EDT (UTC-4), so utcHour = etHour + 4.
// 2026-06-10 is a Wednesday. Pre = 08:00 ET, regular = 10:00 ET, post = 17:00 ET, closed = 02:00 ET
// (before the 04:00 pre-market open). Keep etHour+4 < 24 so the UTC string stays same-day/valid.
function etDate(etHour: number, etMinute = 0): Date {
  const utcHour = etHour + 4;
  return new Date(`2026-06-10T${String(utcHour).padStart(2, "0")}:${String(etMinute).padStart(2, "0")}:00Z`);
}
const PRE = etDate(8);
const REGULAR = etDate(10);
const POST = etDate(17);
const CLOSED = etDate(2);

const policyWith = (over: Partial<TradingPolicy>): TradingPolicy => ({ ...DEFAULT_POLICY, ...over });

describe("extendedHoursExitBufferBps", () => {
  it("undefined when the toggle is off (default), regardless of session", () => {
    expect(extendedHoursExitBufferBps(DEFAULT_POLICY, PRE)).toBeUndefined();
    expect(extendedHoursExitBufferBps(DEFAULT_POLICY, POST)).toBeUndefined();
  });

  it("undefined in a regular or closed session even when the toggle is on", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(extendedHoursExitBufferBps(p, REGULAR)).toBeUndefined();
    expect(extendedHoursExitBufferBps(p, CLOSED)).toBeUndefined();
  });

  it("returns the default 15 bps in pre/post when the toggle is on", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(extendedHoursExitBufferBps(p, PRE)).toBe(15);
    expect(extendedHoursExitBufferBps(p, POST)).toBe(15);
  });

  it("honors a tuned buffer", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true, tuning: { marketableLimitBufferBps: 25 } });
    expect(extendedHoursExitBufferBps(p, PRE)).toBe(25);
  });

  it("falls back to the default for a stored zero/negative/non-finite buffer (it would invert the marketable price)", () => {
    for (const bad of [0, -10, Number.NaN]) {
      const p = policyWith({ allowExtendedHoursSyntheticStops: true, tuning: { marketableLimitBufferBps: bad } });
      expect(extendedHoursExitBufferBps(p, PRE)).toBe(15);
    }
  });

  it("caps an absurd stored buffer at 500 bps (typo/units-mistake guard)", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true, tuning: { marketableLimitBufferBps: 10_000 } });
    expect(extendedHoursExitBufferBps(p, PRE)).toBe(500);
  });

  it("undefined when limit orders are not a permitted order type (a limit is mandatory in extended hours)", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true, permittedOrderTypes: ["market"] });
    expect(extendedHoursExitBufferBps(p, PRE)).toBeUndefined();
  });
});

describe("early-close (13:00 ET) session resolution", () => {
  // Black Friday 2026 = Fri 2026-11-27, an NYSE early-close day (09:30–13:00 ET regular session).
  // November is EST (UTC-5), so ET hour + 5 = UTC hour.
  const earlyCloseAfternoon = new Date("2026-11-27T19:00:00Z"); // 14:00 ET — after the 13:00 close
  const earlyCloseBoundary = new Date("2026-11-27T18:00:00Z"); // 13:00 ET exactly — market just closed
  const earlyCloseMorning = new Date("2026-11-27T16:00:00Z"); // 11:00 ET — regular session, market open
  const normalFridayAfternoon = new Date("2026-11-20T19:00:00Z"); // 14:00 ET a week earlier — regular

  it("treats post-close time on an early-close day as the post session (currentMarketSession would say regular)", () => {
    expect(protectiveExitMarketSession(earlyCloseAfternoon)).toBe("post");
    expect(protectiveExitMarketSession(earlyCloseBoundary)).toBe("post");
    expect(protectiveExitMarketSession(earlyCloseMorning)).toBe("regular");
    expect(protectiveExitMarketSession(normalFridayAfternoon)).toBe("regular");
  });

  it("extended-hours exit routing applies 13:00–16:00 ET on an early-close day (no downgrade to a queued market order)", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(extendedHoursExitBufferBps(p, earlyCloseAfternoon)).toBe(15);
    expect(extendedHoursExitBufferBps(p, earlyCloseMorning)).toBeUndefined();
    expect(extendedHoursExitBufferBps(p, normalFridayAfternoon)).toBeUndefined();
    expect(resolveProtectiveExitRouting(p, "sell", { price: 100 }, earlyCloseAfternoon)).toEqual({
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 99.85
    });
  });

  it("an approval-time reprice at 14:00 ET on an early-close day KEEPS the extended-hours limit", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    const stored: TradeProposal = {
      symbol: "AAPL",
      side: "sell",
      type: "limit",
      quantity: 5,
      limitPrice: 219.67,
      timeInForce: "gfd",
      marketHours: "extended_hours",
      rationale: "Proactive stop-loss exit.",
      tradeThesisTag: "Risk-Exit",
      entryMarketRegime: "Active Risk Check"
    };
    const repriced = repriceStoredProtectiveExit(stored, p, { price: 200, bid: 199, ask: 200 }, earlyCloseAfternoon);
    expect(repriced).toMatchObject({ type: "limit", marketHours: "extended_hours", limitPrice: 198.7 });
  });
});

describe("marketableLimitExitPrice", () => {
  it("a SELL (long exit) crosses DOWN off the ref price when no bid is available", () => {
    expect(marketableLimitExitPrice({ price: 100 }, "sell", 15)).toBe(99.85); // 100 * (1 - 0.0015)
  });
  it("a COVER (short buy-to-close) crosses UP off the ref price when no ask is available", () => {
    expect(marketableLimitExitPrice({ price: 100 }, "cover", 15)).toBe(100.15); // 100 * (1 + 0.0015)
  });
  it("a SELL anchors to the BID, not the ask-biased composite price (bid 99 / ask 100 spread)", () => {
    // Off the composite (ask) the limit would be 99.85 — ABOVE the 99 bid, not marketable at all.
    expect(marketableLimitExitPrice({ price: 100, bid: 99, ask: 100 }, "sell", 15)).toBe(98.85); // 99 * (1 - 0.0015)
  });
  it("a COVER anchors to the ASK", () => {
    expect(marketableLimitExitPrice({ price: 99, bid: 99, ask: 100 }, "cover", 15)).toBe(100.15); // 100 * (1 + 0.0015)
  });
  it("a zero/absent bid (common on the free tier after hours) falls back to the composite price", () => {
    expect(marketableLimitExitPrice({ price: 100, bid: 0 }, "sell", 15)).toBe(99.85);
  });
  it("undefined when no usable anchor exists", () => {
    expect(marketableLimitExitPrice({ price: 0 }, "sell", 15)).toBeUndefined();
    expect(marketableLimitExitPrice({ price: -5 }, "cover", 15)).toBeUndefined();
    expect(marketableLimitExitPrice({}, "sell", 15)).toBeUndefined();
  });

  it("sub-$1 SELL rounds OUTWARD at 4 dp — never up through the bid (2 dp would rest at $0.50 above a $0.496 bid)", () => {
    const price = marketableLimitExitPrice({ price: 0.5, bid: 0.496 }, "sell", 15);
    expect(price).toBe(0.4952); // floor(0.496 * 0.9985 = 0.495256 at 4 dp)
    expect(price!).toBeLessThanOrEqual(0.496); // still marketable against the bid
  });

  it("sub-$1 COVER rounds OUTWARD (up) at 4 dp so the limit stays at/above the ask", () => {
    const price = marketableLimitExitPrice({ price: 0.49, ask: 0.496 }, "cover", 15);
    expect(price).toBe(0.4968); // ceil(0.496 * 1.0015 = 0.496744 at 4 dp)
    expect(price!).toBeGreaterThanOrEqual(0.496);
  });

  it("at/above $1 rounds OUTWARD to the penny (symmetric rounding could un-cross a tight buffer)", () => {
    // SELL: 100.5 * 0.9985 = 100.34925 — Math.round would give 100.35, ABOVE the crossed price.
    expect(marketableLimitExitPrice({ price: 100.5 }, "sell", 15)).toBe(100.34);
    // COVER: 100.4 * 1.0015 = 100.5506 — Math.round would give 100.55, BELOW the crossed price.
    expect(marketableLimitExitPrice({ price: 100.4 }, "cover", 15)).toBe(100.56);
  });

  it("snaps an exactly-on-tick product instead of pushing it one tick further out", () => {
    expect(marketableLimitExitPrice({ price: 100 }, "sell", 15)).toBe(99.85); // 100 * 0.9985 is exactly on-tick
    expect(marketableLimitExitPrice({ price: 100 }, "cover", 15)).toBe(100.15);
  });
});

describe("assessProtectiveExitRepriceDrift (live typed-confirm materiality)", () => {
  const p = policyWith({ allowExtendedHoursSyntheticStops: true });
  const stored: TradeProposal = {
    symbol: "AAPL",
    side: "sell",
    type: "limit",
    quantity: 5,
    limitPrice: 219.67,
    timeInForce: "gfd",
    marketHours: "extended_hours",
    rationale: "Proactive stop-loss exit.",
    tradeThesisTag: "Risk-Exit",
    entryMarketRegime: "Active Risk Check"
  };

  it("a large price move between confirmation and placement is material", () => {
    const repriced: TradeProposal = { ...stored, limitPrice: 198.7 }; // ~954 bps below the confirmed 219.67
    const drift = assessProtectiveExitRepriceDrift(stored, repriced, p, { price: 200, bid: 199, ask: 200 });
    expect(drift.material).toBe(true);
    expect(drift.toleranceBps).toBe(15);
    expect(drift.priceDriftBps!).toBeGreaterThan(900);
  });

  it("drift within the marketable-limit buffer tolerance is immaterial", () => {
    const repriced: TradeProposal = { ...stored, limitPrice: 219.56 }; // ~5 bps
    const drift = assessProtectiveExitRepriceDrift(stored, repriced, p, { price: 219.9, bid: 219.89 });
    expect(drift.material).toBe(false);
    expect(drift.priceDriftBps!).toBeLessThan(15);
  });

  it("a session-expiry degrade to market with an UNMOVED quote is immaterial (fresh marketable price matches the confirmed limit)", () => {
    const repriced: TradeProposal = { ...stored, type: "market", limitPrice: undefined, marketHours: "regular_hours" };
    const drift = assessProtectiveExitRepriceDrift(stored, repriced, p, { price: 220, bid: 220 });
    expect(drift.material).toBe(false); // 220 * 0.9985 = 219.67 — exactly what was confirmed
  });

  it("a degrade to market with NO usable fresh quote is material (what would be placed cannot be verified)", () => {
    const repriced: TradeProposal = { ...stored, type: "market", limitPrice: undefined, marketHours: "regular_hours" };
    const drift = assessProtectiveExitRepriceDrift(stored, repriced, p, undefined);
    expect(drift.material).toBe(true);
    expect(drift.priceDriftBps).toBeUndefined();
  });

  it("a confirmed-notional mismatch beyond tolerance is material even when the price barely moved", () => {
    const repriced: TradeProposal = { ...stored, limitPrice: 219.6 }; // ~3 bps price drift
    const drift = assessProtectiveExitRepriceDrift(stored, repriced, p, { price: 219.9, bid: 219.9 }, 900); // confirmed $900, now ~$1,098
    expect(drift.material).toBe(true);
    expect(drift.notionalDriftBps!).toBeGreaterThan(15);
  });
});

describe("resolveProtectiveExitRouting", () => {
  it("market + regular_hours when the toggle is off (queue to the open)", () => {
    expect(resolveProtectiveExitRouting(DEFAULT_POLICY, "sell", { price: 100 }, PRE)).toEqual({
      type: "market",
      marketHours: "regular_hours"
    });
  });

  it("market + regular_hours in a regular session even with the toggle on", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(resolveProtectiveExitRouting(p, "sell", { price: 100 }, REGULAR)).toEqual({
      type: "market",
      marketHours: "regular_hours"
    });
  });

  it("marketable-limit + extended_hours in pre/post when the toggle is on", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(resolveProtectiveExitRouting(p, "sell", { price: 100 }, PRE)).toEqual({
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 99.85
    });
    expect(resolveProtectiveExitRouting(p, "cover", { price: 100 }, POST)).toEqual({
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 100.15
    });
  });

  it("anchors the extended-hours SELL limit to the bid when one is supplied", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(resolveProtectiveExitRouting(p, "sell", { price: 100, bid: 99, ask: 100 }, PRE)).toEqual({
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 98.85
    });
  });

  it("keeps a FRACTIONAL exit quantity on market/regular (fractional orders are regular-hours-only)", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(resolveProtectiveExitRouting(p, "sell", { price: 100 }, PRE, 10.5)).toEqual({
      type: "market",
      marketHours: "regular_hours"
    });
    // A whole-share quantity still takes the extended-hours limit.
    expect(resolveProtectiveExitRouting(p, "sell", { price: 100 }, PRE, 10)).toEqual({
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 99.85
    });
  });

  it("falls back to market/regular when no usable price is available", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(resolveProtectiveExitRouting(p, "sell", undefined, PRE)).toEqual({
      type: "market",
      marketHours: "regular_hours"
    });
  });
});

describe("repriceStoredProtectiveExit (approval-held exits)", () => {
  const storedExit: TradeProposal = {
    symbol: "AAPL",
    side: "sell",
    type: "limit",
    quantity: 5,
    limitPrice: 219.67, // priced off a $220 quote at generation time
    timeInForce: "gfd",
    marketHours: "extended_hours",
    rationale: "Proactive stop-loss exit.",
    tradeThesisTag: "Risk-Exit",
    entryMarketRegime: "Active Risk Check"
  };
  const p = policyWith({ allowExtendedHoursSyntheticStops: true });

  it("reprices a stale extended-hours limit off the FRESH bid so it is marketable again", () => {
    // The quote fell through the stored 219.67 limit while the card waited for approval.
    const repriced = repriceStoredProtectiveExit(storedExit, p, { price: 200, bid: 199, ask: 200 }, PRE);
    expect(repriced).toMatchObject({ type: "limit", marketHours: "extended_hours", limitPrice: 198.7 }); // 199 * (1 - 0.0015)
  });

  it("degrades to market/regular_hours when the extended session no longer applies at approval time", () => {
    const repriced = repriceStoredProtectiveExit(storedExit, p, { price: 200, bid: 199, ask: 200 }, REGULAR);
    expect(repriced).toMatchObject({ type: "market", marketHours: "regular_hours" });
    expect(repriced.limitPrice).toBeUndefined();
  });

  it("degrades to market/regular_hours when no fresh quote is available", () => {
    const repriced = repriceStoredProtectiveExit(storedExit, p, undefined, PRE);
    expect(repriced).toMatchObject({ type: "market", marketHours: "regular_hours" });
  });

  it("returns the proposal unchanged when the fresh routing matches the stored limit", () => {
    const fresh = repriceStoredProtectiveExit(storedExit, p, { price: 220, bid: 220, ask: 220.2 }, PRE);
    // 220 * (1 - 0.0015) = 219.67 — identical, so the exact same object passes through.
    expect(fresh).toBe(storedExit);
  });

  it("passes non-protective and non-extended-hours proposals through untouched", () => {
    const entry: TradeProposal = { ...storedExit, side: "buy", tradeThesisTag: "Momentum-Breakout" };
    expect(repriceStoredProtectiveExit(entry, p, { price: 1 }, PRE)).toBe(entry);
    const regularExit: TradeProposal = { ...storedExit, type: "market", limitPrice: undefined, marketHours: "regular_hours" };
    expect(repriceStoredProtectiveExit(regularExit, p, { price: 1 }, PRE)).toBe(regularExit);
  });
});

describe("generateProactiveRiskProposals — extended-hours routing", () => {
  // MSFT long down 10% (breaches the 8% stop): a proactive SELL exit is generated.
  const positions = [{ symbol: "MSFT", quantity: 5, averageCost: 400, marketValue: 1800 }];
  const currentPrices = { MSFT: 360 };
  const policy = policyWith({ riskRules: { stopLossPct: 8 } });

  it("defaults to a market order that queues to the open (no buffer passed)", () => {
    const [exit] = generateProactiveRiskProposals(positions, currentPrices, policy, {}, {});
    expect(exit).toMatchObject({ symbol: "MSFT", side: "sell", type: "market", marketHours: "regular_hours" });
    expect(exit.limitPrice).toBeUndefined();
  });

  it("becomes a marketable-limit tagged extended_hours when a buffer is supplied", () => {
    const [exit] = generateProactiveRiskProposals(positions, currentPrices, policy, {}, {}, 15);
    expect(exit).toMatchObject({
      symbol: "MSFT",
      side: "sell",
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 359.46 // 360 * (1 - 0.0015)
    });
  });

  it("anchors the SELL limit to the real BID when the scan carries one (composite price is ask-biased)", () => {
    const [exit] = generateProactiveRiskProposals(positions, currentPrices, policy, {}, {}, 15, {
      MSFT: { bid: 358, ask: 360 }
    });
    expect(exit).toMatchObject({
      symbol: "MSFT",
      side: "sell",
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 357.46 // 358 * (1 - 0.0015)
    });
  });

  it("keeps a FRACTIONAL position on the market/queue-to-open exit even when a buffer is supplied", () => {
    // A fractional extended-hours limit would be hard-blocked by policy ("Fractional or dollar-based
    // orders must be regular-hours only.") — the breached stop must queue to the open, not vanish.
    const fractional = [{ symbol: "MSFT", quantity: 5.5, averageCost: 400, marketValue: 1980 }];
    const [exit] = generateProactiveRiskProposals(fractional, currentPrices, policy, {}, {}, 15);
    expect(exit).toMatchObject({
      symbol: "MSFT",
      side: "sell",
      type: "market",
      quantity: 5.5,
      marketHours: "regular_hours"
    });
    expect(exit.limitPrice).toBeUndefined();
  });

  it("routes a SHORT cover exit UP through the price in extended hours", () => {
    // Short at 100, now 112 → a short is down 12%, breaching the 8% stop → COVER.
    const shortPos = [{ symbol: "TSLA", quantity: -3, averageCost: 100, marketValue: -336 }];
    const shortPolicy = policyWith({ riskRules: { stopLossPct: 8 }, shortSellingEnabled: true });
    const [exit] = generateProactiveRiskProposals(shortPos, { TSLA: 112 }, shortPolicy, {}, {}, 15);
    expect(exit).toMatchObject({
      symbol: "TSLA",
      side: "cover",
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 112.17 // 112 * (1 + 0.0015)
    });
  });
});
