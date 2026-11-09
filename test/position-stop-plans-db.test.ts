import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { EquityPosition, TradeProposal } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-stop-plans-${randomUUID()}.db`)}`;
});

describe("position_stop_plans persistence", () => {
  it("round-trips style/rationale/avgCost, upserts, and clears on close", async () => {
    const { getStopPlans, recordStopPlan, clearStopPlans } = await import("../src/lib/db");
    const acct = "ACCT1";

    expect(getStopPlans(acct)).toEqual({});

    recordStopPlan(acct, "NVDA", "trailing", undefined, 100);
    recordStopPlan(acct, "AAPL", "none", "high-conviction thesis, no stop desired", 200);
    expect(getStopPlans(acct)).toEqual({
      NVDA: { style: "trailing", rationale: undefined, avgCost: 100, side: "long" },
      AAPL: { style: "none", rationale: "high-conviction thesis, no stop desired", avgCost: 200, side: "long" }
    });

    // Upsert advances style/rationale/avgCost for the same key (no duplicate row).
    recordStopPlan(acct, "NVDA", "fixed", "reconsidered on a scale-in", 105);
    expect(getStopPlans(acct).NVDA).toEqual({ style: "fixed", rationale: "reconsidered on a scale-in", avgCost: 105, side: "long" });

    expect(getStopPlans("OTHER")).toEqual({}); // scoped per account

    clearStopPlans(acct, []); // no-op
    expect(Object.keys(getStopPlans(acct))).toHaveLength(2);
    clearStopPlans(acct, ["NVDA"]);
    expect(getStopPlans(acct)).toEqual({
      AAPL: { style: "none", rationale: "high-conviction thesis, no stop desired", avgCost: 200, side: "long" }
    });
  });

  it("falls back to 'default' for an unrecognized/invalid style, never throwing", async () => {
    const { getStopPlans, recordStopPlan } = await import("../src/lib/db");
    recordStopPlan("ACCT2", "MSFT", "not-a-real-style", undefined, 50);
    expect(getStopPlans("ACCT2").MSFT).toEqual({ style: "default", rationale: undefined, avgCost: 50, side: "long" });
  });

  it("scopes plans per userId, not just accountNumber", async () => {
    const { getStopPlans, recordStopPlan } = await import("../src/lib/db");
    recordStopPlan("ACCT3", "TSLA", "atr", undefined, 300, "user-a");
    expect(getStopPlans("ACCT3", "user-a").TSLA).toMatchObject({ style: "atr" });
    expect(getStopPlans("ACCT3", "user-b")).toEqual({});
  });
});

describe("stop plan is committed ON FILL (an opening buy/short with a fresh stopPlan), not at proposal time", () => {
  const open = (stopPlan?: TradeProposal["stopPlan"], side: TradeProposal["side"] = "buy"): TradeProposal => ({
    symbol: "NVDA",
    side,
    type: "market",
    quantity: 4,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "opening buy",
    tradeThesisTag: "Breakout",
    entryMarketRegime: "Bull",
    ...(stopPlan ? { stopPlan } : {})
  });

  it("recordFillFromProposal persists a fresh 'trailing' plan on an opening BUY fill", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP1", source: "live", status: "filled",
      proposal: open({ style: "trailing" }),
      execution: { orderId: "o1", refId: "r1", state: "filled", averagePrice: 100, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP1")).toEqual({ NVDA: { style: "trailing", rationale: undefined, avgCost: 100, side: "long" } });
  });

  it("persists a 'none' plan with its rationale on an opening SHORT fill", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP2", source: "live", status: "filled",
      proposal: open({ style: "none", rationale: "deep value, riding through drawdown" }, "short"),
      execution: { orderId: "o2", refId: "r2", state: "filled", averagePrice: 50, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP2").NVDA).toMatchObject({ style: "none", rationale: "deep value, riding through drawdown" });
  });

  it("does NOT persist a 'default' plan (no behavior change from before this feature existed)", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP3", source: "live", status: "filled",
      proposal: open({ style: "default" }),
      execution: { orderId: "o3", refId: "r3", state: "filled", averagePrice: 100, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP3")).toEqual({});
  });

  it("does NOT persist a stop plan for a CLOSING fill (sell/cover), even if one were somehow attached", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP4", source: "live", status: "filled",
      proposal: open({ style: "trailing" }, "sell"),
      execution: { orderId: "o4", refId: "r4", state: "filled", averagePrice: 100, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP4")).toEqual({});
  });

  it("a fill with no stopPlan at all is a no-op (does not touch the table)", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP5", source: "live", status: "filled",
      proposal: open(undefined),
      execution: { orderId: "o5", refId: "r5", state: "filled", averagePrice: 100, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP5")).toEqual({});
  });

  it("does NOT persist a plan while the live broker order is still 'pending_reconciliation' — a canceled/expired order must never leave a plan governing a lot that never opened (Codex review, PR #1371)", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP6", source: "live", status: "pending_reconciliation",
      proposal: open({ style: "trailing" }),
      execution: { orderId: "o6", refId: "r6", state: "new", raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP6")).toEqual({});
  });

  it("an EXPLICIT 'default' plan on a scale-in fill CLEARS an existing persisted override (the only way to ever reset a position back to the account's own precedence — Codex review, PR #1371)", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP7", source: "live", status: "filled",
      proposal: open({ style: "none", rationale: "initial thesis: ride it out" }),
      execution: { orderId: "o7a", refId: "r7a", state: "filled", averagePrice: 100, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP7").NVDA).toMatchObject({ style: "none" });

    recordFillFromProposal({
      accountNumber: "FILLACCT-SP7", source: "live", status: "filled",
      proposal: open({ style: "default" }), // a scale-in add that explicitly resets
      execution: { orderId: "o7b", refId: "r7b", state: "filled", averagePrice: 105, filledQuantity: 2, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP7")).toEqual({});
  });

  it("stamps a SCALE-IN's plan with the position's post-fill BLENDED avgCost (not this fill's raw price), so filterStopPlansByLiveBasis KEEPS it next run instead of discarding it as stale (Codex review, PR #1371)", async () => {
    const { getStopPlans, filterStopPlansByLiveBasis } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    const acct = "FILLACCT-SP8";

    // Prior open: NVDA 4 shares @ 100, with a persisted "trailing" plan (recorded basis 100).
    recordFillFromProposal({
      accountNumber: acct, source: "live", status: "filled",
      proposal: open({ style: "trailing" }),
      execution: { orderId: "o8a", refId: "r8a", state: "filled", averagePrice: 100, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans(acct).NVDA).toMatchObject({ style: "trailing", avgCost: 100 });

    // Scale-in add: 4 more shares fill at 110 with a fresh "fixed" plan. The broker's post-fill
    // blended basis is (4*100 + 4*110) / 8 = 105 — the plan must record 105, NOT this one fill's 110.
    recordFillFromProposal({
      accountNumber: acct, source: "live", status: "filled",
      proposal: open({ style: "fixed" }),
      execution: { orderId: "o8b", refId: "r8b", state: "filled", averagePrice: 110, filledQuantity: 4, raw: {} },
      existingPosition: { averageCost: 100, quantity: 4 }
    });
    // Pre-fix this recorded avgCost=110 (the raw fill price); post-fix it records the blended 105.
    expect(getStopPlans(acct).NVDA).toMatchObject({ style: "fixed", avgCost: 105 });

    // Next run: the live position now shows the broker's blended averageCost of 105. The just-recorded
    // plan must SURVIVE the live-basis filter — pre-fix it recorded 110 and |110 - 105| = 5 >= 0.005
    // silently discarded the owner/LLM's chosen "fixed" plan, dropping the position to account default.
    const livePosition: EquityPosition = { symbol: "NVDA", quantity: 8, averageCost: 105, marketValue: 840 };
    expect(filterStopPlansByLiveBasis(getStopPlans(acct), [livePosition])).toEqual({ NVDA: "fixed" });
  });
});

describe("bracket sibling-leg teardown queue (position_stop_plan_open_brackets -> pending_bracket_teardowns)", () => {
  it("recordStopPlan persists an openingOrderId for a fresh fixed/atr plan", async () => {
    const { getStopPlans, recordStopPlan } = await import("../src/lib/db");
    const acct = "ACCT-BRACKET-1";
    recordStopPlan(acct, "AAPL", "fixed", "pin to flat stop", 190, "local", undefined, "long", "bracket-order-1");
    expect(getStopPlans(acct).AAPL).toMatchObject({ style: "fixed", openingOrderId: "bracket-order-1" });
  });

  it("enqueues a teardown when a fixed/atr plan with a tracked bracket changes to trailing/none", async () => {
    const { getStopPlans, recordStopPlan, listPendingBracketTeardowns } = await import("../src/lib/db");
    const acct = "ACCT-BRACKET-2";
    recordStopPlan(acct, "MSFT", "fixed", "pin to flat stop", 300, "local", undefined, "long", "bracket-order-2");
    expect(listPendingBracketTeardowns(acct)).toEqual([]); // not yet — still fixed

    recordStopPlan(acct, "MSFT", "trailing", "switch to trailing on a scale-in", 300, "local", undefined, "long");
    const pending = listPendingBracketTeardowns(acct);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ symbol: "MSFT", orderId: "bracket-order-2", accountNumber: acct, attempts: 0 });
    // The new row no longer carries the stale bracket order id.
    expect(getStopPlans(acct).MSFT.openingOrderId).toBeUndefined();
  });

  it("does NOT tear down the OLD bracket on a same-style scale-in — it's still valid protection for the pre-existing lot (Codex review, PR #1667)", async () => {
    const { getStopPlans, recordStopPlan, listPendingBracketTeardowns, listOpenBracketOrders } = await import("../src/lib/db");
    const acct = "ACCT-BRACKET-3";
    recordStopPlan(acct, "TSLA", "fixed", "initial", 400, "local", undefined, "long", "bracket-order-3");
    // A scale-in re-affirms "fixed" and places a BRAND-NEW, independent broker-native bracket for the
    // ADDED shares only (Alpaca sizes orderArgs.qty from the new order's own quantity; Tradier sizes
    // each exit leg to that order's own wholeQty) — it does NOT replace or resize the OLD bracket,
    // which is still the genuine, still-needed protection for the pre-existing lot. An earlier,
    // incomplete fix (adversarial review of PR #1661) wrongly tore down the OLD bracket here on the
    // theory that only the LATEST order id should be tracked — Codex correctly flagged that this
    // cancels a live, correct stop-loss/take-profit and leaves the earlier lot with NO protection.
    recordStopPlan(acct, "TSLA", "fixed", "reaffirmed on scale-in", 405, "local", undefined, "long", "bracket-order-3b");
    expect(listPendingBracketTeardowns(acct)).toEqual([]); // neither bracket is torn down yet
    // BOTH bracket orders are tracked — each still protects its own lot.
    expect(listOpenBracketOrders(acct, "TSLA").map((r) => r.orderId).sort()).toEqual(["bracket-order-3", "bracket-order-3b"]);
    expect(getStopPlans(acct).TSLA.openingOrderId).toBe("bracket-order-3b"); // display-only, latest

    // Only once the plan genuinely LEAVES the fixed/atr family are BOTH brackets torn down together.
    recordStopPlan(acct, "TSLA", "trailing", "switch off distance stops entirely", 405, "local", undefined, "long");
    const pending = listPendingBracketTeardowns(acct);
    expect(pending.map((r) => r.orderId).sort()).toEqual(["bracket-order-3", "bracket-order-3b"]);
    expect(listOpenBracketOrders(acct, "TSLA")).toEqual([]); // tracking cleared once enqueued
  });

  it("does NOT tear down brackets on a fixed<->atr transition either — same reasoning as same-style scale-ins (Codex review, PR #1667, second attempt)", async () => {
    const { listPendingBracketTeardowns, listOpenBracketOrders, recordStopPlan } = await import("../src/lib/db");
    const acct = "ACCT-BRACKET-FIXED-ATR";
    recordStopPlan(acct, "NVDA", "fixed", "initial fixed stop", 500, "local", undefined, "long", "bracket-fixed-1");
    // A scale-in switches the STYLE from fixed to atr (still within the distance-bracket family) and
    // places a new bracket for the added shares. A prior codex-autofix attempt on this PR tore down
    // the OLD bracket on exactly this transition, reasoning that fixed and atr are "different
    // distances" — but mechanically both are independent, lot-scoped brackets with nothing else
    // recreating protection for the earlier lot, so tearing down here is exactly as harmful as doing
    // it on a same-style scale-in (reverted; see recordStopPlan's doc comment for the full argument).
    recordStopPlan(acct, "NVDA", "atr", "switched to ATR-based stop on scale-in", 505, "local", undefined, "long", "bracket-atr-1");
    expect(listPendingBracketTeardowns(acct)).toEqual([]);
    expect(listOpenBracketOrders(acct, "NVDA").map((r) => r.orderId).sort()).toEqual(["bracket-atr-1", "bracket-fixed-1"]);

    // Switching atr -> fixed again is the same story — still no teardown.
    recordStopPlan(acct, "NVDA", "fixed", "back to fixed", 505, "local", undefined, "long", "bracket-fixed-2");
    expect(listPendingBracketTeardowns(acct)).toEqual([]);
    expect(listOpenBracketOrders(acct, "NVDA")).toHaveLength(3);

    // Only a genuine exit from the whole distance-bracket family tears everything down together.
    recordStopPlan(acct, "NVDA", "none", "done with distance stops", 505, "local", undefined, "long");
    expect(listPendingBracketTeardowns(acct).map((r) => r.orderId).sort()).toEqual(["bracket-atr-1", "bracket-fixed-1", "bracket-fixed-2"]);
    expect(listOpenBracketOrders(acct, "NVDA")).toEqual([]);
  });

  it("does NOT double-track the same bracket order id on a redundant re-record (no new bracket placed)", async () => {
    const { recordStopPlan, listPendingBracketTeardowns, listOpenBracketOrders } = await import("../src/lib/db");
    const acct = "ACCT-BRACKET-3B";
    recordStopPlan(acct, "TSLA", "fixed", "initial", 400, "local", undefined, "long", "bracket-order-3c");
    // A rationale/avgCost-only rewrite that doesn't correspond to a fresh fill re-passes the SAME
    // tracked opening order id — nothing new to track, and no teardown is warranted.
    recordStopPlan(acct, "TSLA", "fixed", "rationale tweak only", 401, "local", undefined, "long", "bracket-order-3c");
    expect(listOpenBracketOrders(acct, "TSLA")).toHaveLength(1);
    expect(listPendingBracketTeardowns(acct)).toEqual([]);
  });

  it("does NOT enqueue a teardown when there was no tracked openingOrderId to begin with", async () => {
    const { recordStopPlan, listPendingBracketTeardowns } = await import("../src/lib/db");
    const acct = "ACCT-BRACKET-4";
    recordStopPlan(acct, "AMD", "fixed", "no bracket ever placed (e.g. Robinhood)", 100, "local"); // no openingOrderId
    recordStopPlan(acct, "AMD", "none", "switched off", 100, "local");
    expect(listPendingBracketTeardowns(acct)).toEqual([]);
  });

  it("clearStopPlans enqueues a teardown for a closed position's fixed/atr plan with a tracked bracket", async () => {
    const { recordStopPlan, clearStopPlans, listPendingBracketTeardowns } = await import("../src/lib/db");
    const acct = "ACCT-BRACKET-5";
    recordStopPlan(acct, "GOOG", "atr", "pin to ATR distance", 150, "local", undefined, "long", "bracket-order-5");
    clearStopPlans(acct, ["GOOG"]);
    const pending = listPendingBracketTeardowns(acct);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ symbol: "GOOG", orderId: "bracket-order-5" });
  });

  it("removePendingBracketTeardown removes the row; bumpPendingBracketTeardownAttempts increments attempts", async () => {
    const { recordStopPlan, clearStopPlans, listPendingBracketTeardowns, removePendingBracketTeardown, bumpPendingBracketTeardownAttempts } = await import("../src/lib/db");
    const acct = "ACCT-BRACKET-6";
    recordStopPlan(acct, "IBM", "fixed", "x", 100, "local", undefined, "long", "bracket-order-6");
    clearStopPlans(acct, ["IBM"]);
    const [row] = listPendingBracketTeardowns(acct);
    expect(row.attempts).toBe(0);

    bumpPendingBracketTeardownAttempts(row.id);
    expect(listPendingBracketTeardowns(acct)[0].attempts).toBe(1);

    removePendingBracketTeardown(row.id);
    expect(listPendingBracketTeardowns(acct)).toEqual([]);
  });

  it("scopes pending teardowns per account (never leaks across accounts)", async () => {
    const { recordStopPlan, clearStopPlans, listPendingBracketTeardowns } = await import("../src/lib/db");
    recordStopPlan("ACCT-BRACKET-7A", "F", "fixed", "x", 10, "local", undefined, "long", "order-7a");
    clearStopPlans("ACCT-BRACKET-7A", ["F"]);
    expect(listPendingBracketTeardowns("ACCT-BRACKET-7A")).toHaveLength(1);
    expect(listPendingBracketTeardowns("ACCT-BRACKET-7B")).toEqual([]);
  });
});

describe("Exit Contract B1 — resolved distance/price persistence", () => {
  it("recordStopPlan persists Exit Contract columns and getStopPlans round-trips them", async () => {
    const { getStopPlans, recordStopPlan, persistedOrFallbackStopPct, deriveExitContractFromOpening } = await import("../src/lib/db");
    const acct = "ACCT-EXIT-B1";
    const contract = deriveExitContractFromOpening({
      side: "buy",
      avgCost: 100,
      bracketStopLoss: 92,
      bracketTakeProfit: 120
    });
    expect(contract.resolvedStopPct).toBeCloseTo(8, 5);
    expect(contract.stopPrice).toBe(92);
    expect(contract.takeProfitPrice).toBe(120);

    recordStopPlan(acct, "NVDA", "fixed", "plan", 100, "local", undefined, "long", "ord-1", contract);
    const plan = getStopPlans(acct).NVDA;
    expect(plan).toMatchObject({
      style: "fixed",
      avgCost: 100,
      resolvedStopPct: expect.closeTo(8, 5),
      stopPrice: 92,
      takeProfitPrice: 120
    });
    expect(persistedOrFallbackStopPct(plan, 15)).toBeCloseTo(8, 5);
    expect(persistedOrFallbackStopPct(undefined, 15)).toBe(15);
  });

  it("opening fill with bracketStopLoss writes Exit Contract via recordFillFromProposal", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    const acct = "FILLACCT-EXIT-B1";
    recordFillFromProposal({
      accountNumber: acct,
      source: "live",
      status: "filled",
      proposal: {
        symbol: "AAPL",
        side: "buy",
        type: "market",
        quantity: 2,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "open",
        tradeThesisTag: "Breakout",
        entryMarketRegime: "Bull",
        stopPlan: { style: "fixed", rationale: "8pct" },
        bracketStopLoss: 184,
        bracketTakeProfit: 220
      },
      execution: { orderId: "o-exit-1", refId: "r-exit-1", state: "filled", averagePrice: 200, filledQuantity: 2, raw: {} }
    });
    const plan = getStopPlans(acct).AAPL;
    expect(plan).toMatchObject({
      style: "fixed",
      stopPrice: 184,
      takeProfitPrice: 220,
      resolvedStopPct: expect.closeTo(8, 5)
    });
  });
});
