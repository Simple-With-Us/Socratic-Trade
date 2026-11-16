import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getTaxSummary, getWashSaleLockedSymbols, getWashSaleLockedSymbolsForUser, overlayAccountTaxationType, realizedPnlNetOfEstimatedTax, reconcileOpenLotsAgainstPositions } from "../src/lib/tax";
import type { FillEvent } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tax-${randomUUID()}.db`)}`;
});

const NOW = new Date("2026-06-16T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

function fill(input: Partial<FillEvent> & { id: string; side: "buy" | "sell"; quantity: number; price: number; notional: number; filledAt: string; accountNumber: string; symbol: string }): FillEvent {
  return { proposalId: "p1", runId: "r1", source: "paper", status: "filled", raw: undefined, ...input };
}

// SUPERSEDES the 2026-06-20 "T12 long-only" pin (docs/rollouts/2026-06-20-money-path-tranche-3-tests.md).
// That pin characterized a long-only-era limitation — it never claimed excluding shorts was correct
// tax treatment. Shorting shipped afterward (owner decision 2026-07-10), so a covered short is real
// realized money and belongs in the figure.
describe("tax — short/cover round trips are realized", () => {
  it("counts a short/cover round-trip in short-term realized", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TAX_SHORT_ONLY";
    const base = { proposalId: "p1", runId: "r1", source: "paper" as const, status: "filled", raw: undefined, accountNumber: a, symbol: "TSLA" };
    // Profitable short within the year: short @100 (20d ago), cover @80 (10d ago) → +$20 on a SHORT lot.
    insertFillEvent({ ...base, id: "t12-s1", side: "short", quantity: 1, price: 100, notional: 100, filledAt: daysAgo(20) });
    insertFillEvent({ ...base, id: "t12-s2", side: "cover", quantity: 1, price: 80, notional: 80, filledAt: daysAgo(10) });

    const summary = getTaxSummary(a, "paper", {}, undefined, NOW);
    // A covered short is ALWAYS short-term (IRC 1233 — the holding period runs from the property
    // used to close it, bought at cover), so it never lands in the long-term bucket.
    expect(summary.shortTermRealized).toBeCloseTo(20);
    expect(summary.longTermRealized).toBeCloseTo(0);
  });

  it("still counts an equivalent long round-trip (control)", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TAX_LONG_CTRL";
    const base = { proposalId: "p1", runId: "r1", source: "paper" as const, status: "filled", raw: undefined, accountNumber: a, symbol: "AAPL" };
    insertFillEvent({ ...base, id: "t12-l1", side: "buy", quantity: 1, price: 100, notional: 100, filledAt: daysAgo(20) });
    insertFillEvent({ ...base, id: "t12-l2", side: "sell", quantity: 1, price: 130, notional: 130, filledAt: daysAgo(10) });

    const summary = getTaxSummary(a, "paper", {}, undefined, NOW);
    expect(summary.shortTermRealized).toBeCloseTo(30); // long round-trip IS taxed
  });
});

describe("tax", () => {
  it("locks a symbol sold at a loss within 30 days and flags the wash sale", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TAXWASH";
    // Buy 40d ago @100, sell 10d ago @90 (-$10 short-term loss), rebuy 5d ago @92 (replacement -> wash sale).
    insertFillEvent(fill({ id: "w1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "AAPL", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "w2", side: "sell", quantity: 1, price: 90, notional: 90, accountNumber: a, symbol: "AAPL", filledAt: daysAgo(10) }));
    insertFillEvent(fill({ id: "w3", side: "buy", quantity: 1, price: 92, notional: 92, accountNumber: a, symbol: "AAPL", filledAt: daysAgo(5) }));

    const locked = getWashSaleLockedSymbols(a, "paper", NOW);
    expect(locked.has("AAPL")).toBe(true);

    const tax = getTaxSummary(a, "paper", { AAPL: 95 }, undefined, NOW);
    expect(tax.lockedSymbols).toContain("AAPL");
    expect(tax.washSales.length).toBe(1);
    expect(tax.washSales[0].disallowedLoss).toBeCloseTo(10);
    // The -$10 loss is a disallowed wash sale, so it does not reduce short-term realized.
    expect(tax.shortTermRealized).toBeCloseTo(0);
    expect(tax.disallowedWashSaleLoss).toBeCloseTo(10);
    // The 5-day-old rebuy is an open short-term lot.
    const openAapl = tax.openLots.find((l) => l.symbol === "AAPL");
    expect(openAapl?.isLongTerm).toBe(false);
    expect(openAapl?.daysToLongTerm).toBe(360);
  });

  it("classifies a >1-year gain as long-term and estimates tax at the long-term rate", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TAXLT";
    insertFillEvent(fill({ id: "l1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "MSFT", filledAt: daysAgo(400) }));
    insertFillEvent(fill({ id: "l2", side: "sell", quantity: 1, price: 130, notional: 130, accountNumber: a, symbol: "MSFT", filledAt: daysAgo(10) }));

    const tax = getTaxSummary(a, "paper", {}, { washSaleGuard: true, shortTermRatePct: 24, longTermRatePct: 15 }, NOW);
    expect(tax.longTermRealized).toBeCloseTo(30);
    expect(tax.shortTermRealized).toBeCloseTo(0);
    expect(tax.estimatedLongTermTax).toBeCloseTo(4.5); // 30 * 15%
    expect(tax.estimatedTaxLiability).toBeCloseTo(4.5);
    expect(getWashSaleLockedSymbols(a, "paper", NOW).has("MSFT")).toBe(false); // gain, not a loss
  });

  it("does not lock a loss sale older than 30 days, and keeps its loss deductible", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TAXOLD";
    insertFillEvent(fill({ id: "o1", side: "buy", quantity: 1, price: 50, notional: 50, accountNumber: a, symbol: "T", filledAt: daysAgo(90) }));
    insertFillEvent(fill({ id: "o2", side: "sell", quantity: 1, price: 45, notional: 45, accountNumber: a, symbol: "T", filledAt: daysAgo(40) }));

    expect(getWashSaleLockedSymbols(a, "paper", NOW).has("T")).toBe(false);
    const tax = getTaxSummary(a, "paper", {}, undefined, NOW);
    expect(tax.washSales.length).toBe(0);
    expect(tax.shortTermRealized).toBeCloseTo(-5); // deductible short-term loss
  });

  it("surfaces unrealized losers as tax-loss-harvest candidates", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TAXHARV";
    insertFillEvent(fill({ id: "h1", side: "buy", quantity: 2, price: 100, notional: 200, accountNumber: a, symbol: "NVDA", filledAt: daysAgo(20) }));
    const tax = getTaxSummary(a, "paper", { NVDA: 90 }, undefined, NOW); // marked down 10/share
    const cand = tax.harvestCandidates.find((c) => c.symbol === "NVDA");
    expect(cand?.unrealizedLoss).toBeCloseTo(-20);
  });

  it("treats an IRA as tax-sheltered: 0% rates, no estimated tax, and no own-account wash-sale lockout", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "IRA1";
    // A short-term gain that WOULD be taxed in a taxable account (+$30).
    insertFillEvent(fill({ id: "i1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "AMD", filledAt: daysAgo(20) }));
    insertFillEvent(fill({ id: "i2", side: "sell", quantity: 1, price: 130, notional: 130, accountNumber: a, symbol: "AMD", filledAt: daysAgo(5) }));
    // A loss sale within 30 days that WOULD lock in a taxable account.
    insertFillEvent(fill({ id: "i3", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "INTC", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "i4", side: "sell", quantity: 1, price: 90, notional: 90, accountNumber: a, symbol: "INTC", filledAt: daysAgo(10) }));

    const tax = getTaxSummary(a, "paper", {}, { taxationType: "roth_ira" }, NOW);
    expect(tax.settings.shortTermRatePct).toBe(0);
    expect(tax.settings.longTermRatePct).toBe(0);
    expect(tax.settings.washSaleGuard).toBe(false);
    expect(tax.estimatedTaxLiability).toBeCloseTo(0);
    // IRA bypasses its own wash-sale lockout (a wash sale has no benefit inside the IRA).
    expect(tax.lockedSymbols).not.toContain("INTC");
    // An open loser is still not a harvest candidate — the IRA cannot deduct the loss.
    insertFillEvent(fill({ id: "i5", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "NWG", filledAt: daysAgo(15) }));
    const taxWithLoser = getTaxSummary(a, "paper", { NWG: 90 }, { taxationType: "roth_ira" }, NOW);
    expect(taxWithLoser.harvestCandidates).toEqual([]);
  });

  it("overlays the connected-account taxationType over policy taxSettings", () => {
    expect(overlayAccountTaxationType({ taxationType: "taxable" }, "roth_ira").taxationType).toBe("roth_ira");
    expect(overlayAccountTaxationType({ taxationType: "roth_ira" }, undefined).taxationType).toBe("roth_ira");
    expect(overlayAccountTaxationType(undefined, "traditional_ira").taxationType).toBe("traditional_ira");
  });

  it("locks a symbol across ALL accounts (incl. IRA) when the loss is realized in a TAXABLE account", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const taxable = "XACCT-TAXABLE";
    const ira = "XACCT-IRA";
    insertFillEvent(fill({ id: "x1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: taxable, symbol: "TSLA", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "x2", side: "sell", quantity: 1, price: 90, notional: 90, accountNumber: taxable, symbol: "TSLA", filledAt: daysAgo(8) }));

    const locked = getWashSaleLockedSymbolsForUser(
      [
        { accountNumber: taxable, source: "paper", taxationType: "taxable" },
        { accountNumber: ira, source: "paper", taxationType: "roth_ira" }
      ],
      NOW
    );
    // The taxable-account loss locks TSLA rebuys everywhere, including the IRA (Rev. Rul. 2008-5).
    expect(locked.has("TSLA")).toBe(true);
  });

  it("does NOT create a cross-account lockout from a loss realized inside an IRA", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const ira = "IRA-ONLYLOSS";
    insertFillEvent(fill({ id: "y1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: ira, symbol: "BABA", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "y2", side: "sell", quantity: 1, price: 90, notional: 90, accountNumber: ira, symbol: "BABA", filledAt: daysAgo(8) }));

    const locked = getWashSaleLockedSymbolsForUser(
      [{ accountNumber: ira, source: "paper", taxationType: "traditional_ira" }],
      NOW
    );
    expect(locked.has("BABA")).toBe(false);
  });

  it("computes unrealizedGain and earlyExitTaxPremium for near-long-term lots with current prices", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TURNOVER_COST";
    // Buy 40 days ago @100, current price @110 → $10 unrealized gain on 1 share
    // With 24% short-term and 15% long-term rates: earlyExitTaxPremium = $10 * (24-15)/100 = $0.90
    insertFillEvent(fill({ id: "tc1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "XYZ", filledAt: daysAgo(40) }));

    const tax = getTaxSummary(a, "paper", { XYZ: 110 }, { shortTermRatePct: 24, longTermRatePct: 15 }, NOW);
    const xyzLot = tax.openLots.find((l) => l.symbol === "XYZ");
    expect(xyzLot?.unrealizedGain).toBeCloseTo(10);
    expect(xyzLot?.earlyExitTaxPremium).toBeCloseTo(0.9);
  });

  it("does not compute earlyExitTaxPremium for lots without current price", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "NO_PRICE";
    insertFillEvent(fill({ id: "np1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "UNKNOWN", filledAt: daysAgo(40) }));

    const tax = getTaxSummary(a, "paper", {}, { shortTermRatePct: 24, longTermRatePct: 15 }, NOW);
    const unknownLot = tax.openLots.find((l) => l.symbol === "UNKNOWN");
    expect(unknownLot?.unrealizedGain).toBeUndefined();
    expect(unknownLot?.earlyExitTaxPremium).toBeUndefined();
  });

  it("does not compute earlyExitTaxPremium for lots at a loss", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "AT_LOSS";
    // Buy 40 days ago @100, current price @90 → -$10 unrealized loss
    insertFillEvent(fill({ id: "al1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "DOWN", filledAt: daysAgo(40) }));

    const tax = getTaxSummary(a, "paper", { DOWN: 90 }, { shortTermRatePct: 24, longTermRatePct: 15 }, NOW);
    const downLot = tax.openLots.find((l) => l.symbol === "DOWN");
    expect(downLot?.unrealizedGain).toBeCloseTo(-10);
    expect(downLot?.earlyExitTaxPremium).toBeUndefined();
  });
});

describe("tax — washSaleMinLossUsd materiality floor", () => {
  it("skips a below-threshold loss when building the lockout, keeps an above-threshold one", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "WSMIN";
    // Small loss: -$10 on TINY (buy @100, sell @90).
    insertFillEvent(fill({ id: "m1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "TINY", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "m2", side: "sell", quantity: 1, price: 90, notional: 90, accountNumber: a, symbol: "TINY", filledAt: daysAgo(10) }));
    // Big loss: -$500 on BIGL (buy @1000, sell @500).
    insertFillEvent(fill({ id: "m3", side: "buy", quantity: 1, price: 1000, notional: 1000, accountNumber: a, symbol: "BIGL", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "m4", side: "sell", quantity: 1, price: 500, notional: 500, accountNumber: a, symbol: "BIGL", filledAt: daysAgo(10) }));

    // Threshold $50: the -$10 loss does not lock; the -$500 loss still does.
    const locked = getWashSaleLockedSymbols(a, "paper", NOW, "local", undefined, 50);
    expect(locked.has("TINY")).toBe(false);
    expect(locked.has("BIGL")).toBe(true);

    // Threaded through getTaxSummary via taxSettings.washSaleMinLossUsd.
    const tax = getTaxSummary(a, "paper", {}, { washSaleGuard: true, shortTermRatePct: 24, longTermRatePct: 15, washSaleMinLossUsd: 50 }, NOW);
    expect(tax.lockedSymbols).not.toContain("TINY");
    expect(tax.lockedSymbols).toContain("BIGL");
  });

  it("locks a loss exactly AT the threshold (floor is inclusive)", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "WSMIN-EDGE";
    insertFillEvent(fill({ id: "e1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "EDGE", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "e2", side: "sell", quantity: 1, price: 50, notional: 50, accountNumber: a, symbol: "EDGE", filledAt: daysAgo(10) }));
    expect(getWashSaleLockedSymbols(a, "paper", NOW, "local", undefined, 50).has("EDGE")).toBe(true);
    expect(getWashSaleLockedSymbols(a, "paper", NOW, "local", undefined, 50.01).has("EDGE")).toBe(false);
  });

  it("default (undefined) keeps current behavior: every loss locks", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "WSMIN-DEFAULT";
    insertFillEvent(fill({ id: "d1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "ANY", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "d2", side: "sell", quantity: 1, price: 99.5, notional: 99.5, accountNumber: a, symbol: "ANY", filledAt: daysAgo(10) }));
    expect(getWashSaleLockedSymbols(a, "paper", NOW).has("ANY")).toBe(true);
    const tax = getTaxSummary(a, "paper", {}, undefined, NOW);
    expect(tax.lockedSymbols).toContain("ANY");
  });

  it("applies each account's own threshold in the cross-account lockout", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const strict = "XMIN-STRICT"; // no threshold — every loss locks
    const lax = "XMIN-LAX"; // $100 threshold — small losses ignored
    insertFillEvent(fill({ id: "xa1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: strict, symbol: "SSSS", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "xa2", side: "sell", quantity: 1, price: 95, notional: 95, accountNumber: strict, symbol: "SSSS", filledAt: daysAgo(10) }));
    insertFillEvent(fill({ id: "xb1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: lax, symbol: "LLLL", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "xb2", side: "sell", quantity: 1, price: 95, notional: 95, accountNumber: lax, symbol: "LLLL", filledAt: daysAgo(10) }));

    const locked = getWashSaleLockedSymbolsForUser(
      [
        { accountNumber: strict, source: "paper", taxationType: "taxable" },
        { accountNumber: lax, source: "paper", taxationType: "taxable", washSaleMinLossUsd: 100 }
      ],
      NOW
    );
    expect(locked.has("SSSS")).toBe(true); // strict account: -$5 locks
    expect(locked.has("LLLL")).toBe(false); // lax account: -$5 < $100 floor
  });
});

describe("tax — lot ledger vs live positions (#2548)", () => {
  it("reconcileOpenLotsAgainstPositions flags sign flips, orphans, and magnitude gaps", () => {
    const lots = [
      { symbol: "T", quantity: 91.119 }, // live case: ledger long, broker book short −1.881
      { symbol: "AXP", quantity: 5 }, // orphan lot: no position at all
      { symbol: "AAPL", quantity: 10 }, // healthy: matches
      { symbol: "MSFT", quantity: 50 }, // magnitude gap: broker holds 100
      { symbol: "NVDA", quantity: 3.0000001 } // fractional dust vs 3 — NOT a mismatch
    ];
    const mismatched = reconcileOpenLotsAgainstPositions(lots, {
      T: -1.881,
      AAPL: 10,
      MSFT: 100,
      NVDA: 3
    });
    expect(mismatched.has("T")).toBe(true);
    expect(mismatched.has("AXP")).toBe(true);
    expect(mismatched.has("MSFT")).toBe(true);
    expect(mismatched.has("AAPL")).toBe(false);
    expect(mismatched.has("NVDA")).toBe(false);
  });

  it("flags the row, suppresses lot-derived money figures, and skips harvest for a mismatched symbol", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "LEDGER_MM_T";
    // Ledger: open long lot of 91.119 T (the un-closed FIFO state from the live bug).
    insertFillEvent(fill({ id: "lm1", side: "buy", quantity: 91.119, price: 27, notional: 2460.21, accountNumber: a, symbol: "T", filledAt: daysAgo(13) }));
    // A healthy loser for the harvest control.
    insertFillEvent(fill({ id: "lm2", side: "buy", quantity: 2, price: 100, notional: 200, accountNumber: a, symbol: "NVDA", filledAt: daysAgo(20) }));

    // Broker book: T is SHORT −1.881 (sign flip vs the ledger), NVDA matches.
    const tax = getTaxSummary(a, "paper", { T: 25, NVDA: 90 }, undefined, NOW, "local", undefined, undefined, { T: -1.881, NVDA: 2 });
    expect(tax.ledgerMismatchedSymbols).toEqual(["T"]);
    const tLot = tax.openLots.find((l) => l.symbol === "T");
    expect(tLot?.ledgerMismatch).toBe(true);
    // T is marked down $2/share — but the lot is wrong, so NO money figures from it.
    expect(tLot?.unrealizedGain).toBeUndefined();
    expect(tLot?.earlyExitTaxPremium).toBeUndefined();
    expect(tax.harvestCandidates.some((h) => h.symbol === "T")).toBe(false);
    // Healthy symbol untouched: flagged false, harvest still works.
    const nvdaLot = tax.openLots.find((l) => l.symbol === "NVDA");
    expect(nvdaLot?.ledgerMismatch).toBeUndefined();
    expect(nvdaLot?.unrealizedGain).toBeCloseTo(-20);
    expect(tax.harvestCandidates.find((h) => h.symbol === "NVDA")?.unrealizedLoss).toBeCloseTo(-20);
  });

  it("flags an orphan lot (ledger open, broker book flat — the AXP case)", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "LEDGER_MM_AXP";
    insertFillEvent(fill({ id: "lo1", side: "buy", quantity: 5, price: 240, notional: 1200, accountNumber: a, symbol: "AXP", filledAt: daysAgo(37) }));

    const tax = getTaxSummary(a, "paper", { AXP: 250 }, undefined, NOW, "local", undefined, undefined, {});
    expect(tax.ledgerMismatchedSymbols).toEqual(["AXP"]);
    expect(tax.openLots.find((l) => l.symbol === "AXP")?.ledgerMismatch).toBe(true);
    expect(tax.openLots.find((l) => l.symbol === "AXP")?.unrealizedGain).toBeUndefined();
  });

  it("excludes a mismatched symbol's wash-sale flag from the disallowed aggregate", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "LEDGER_MM_WASH";
    // Wash sale on ZZWS: buy → loss sale → rebuy within 30d. The rebuy leaves an open lot.
    insertFillEvent(fill({ id: "wm1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "ZZWS", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "wm2", side: "sell", quantity: 1, price: 90, notional: 90, accountNumber: a, symbol: "ZZWS", filledAt: daysAgo(10) }));
    insertFillEvent(fill({ id: "wm3", side: "buy", quantity: 1, price: 92, notional: 92, accountNumber: a, symbol: "ZZWS", filledAt: daysAgo(5) }));

    // Without positions: the wash sale is flagged as before.
    const trusted = getTaxSummary(a, "paper", {}, undefined, NOW);
    expect(trusted.washSales.length).toBe(1);
    expect(trusted.disallowedWashSaleLoss).toBeCloseTo(10);
    expect(trusted.ledgerMismatchedSymbols).toBeUndefined();

    // Broker book contradicts the ledger (no ZZWS position) → wash-sale math for it is dropped,
    // not silently computed from wrong lots.
    const reconciled = getTaxSummary(a, "paper", {}, undefined, NOW, "local", undefined, undefined, {});
    expect(reconciled.ledgerMismatchedSymbols).toEqual(["ZZWS"]);
    expect(reconciled.washSales.length).toBe(0);
    expect(reconciled.disallowedWashSaleLoss).toBeCloseTo(0);
  });

  it("no live position map = no reconciliation (previous behavior unchanged)", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "LEDGER_MM_OFF";
    insertFillEvent(fill({ id: "off1", side: "buy", quantity: 5, price: 10, notional: 50, accountNumber: a, symbol: "GHOST", filledAt: daysAgo(10) }));
    const tax = getTaxSummary(a, "paper", { GHOST: 12 }, undefined, NOW);
    expect(tax.ledgerMismatchedSymbols).toBeUndefined();
    const lot = tax.openLots.find((l) => l.symbol === "GHOST");
    expect(lot?.ledgerMismatch).toBeUndefined();
    expect(lot?.unrealizedGain).toBeCloseTo(10);
  });
});

describe("realizedPnlNetOfEstimatedTax", () => {
  it("subtracts estimated tax when subtractFromResults is on", () => {
    expect(realizedPnlNetOfEstimatedTax(1000, 150, true)).toBe(850);
  });

  it("returns realized unchanged when subtractFromResults is off", () => {
    expect(realizedPnlNetOfEstimatedTax(1000, 150, false)).toBe(1000);
  });

  it("returns undefined when realized is undefined", () => {
    expect(realizedPnlNetOfEstimatedTax(undefined, 150, true)).toBeUndefined();
  });
});
