import { describe, expect, it } from "vitest";
import {
  buildPatch,
  classify,
  classifyExtraPatch,
  clearedFallback,
  computeDiff,
  type FieldDef
} from "../app/console/lib/policy-diff";
import { ALL_DEFS, PANIC_BRAKE, PROTECTIVE_STOPS } from "../app/console/guardrails/field-defs";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { TradingPolicy } from "../src/lib/types";

const defByPath = (path: string): FieldDef => {
  const def = ALL_DEFS.find((d) => d.path === path);
  if (!def) throw new Error(`No guardrails FieldDef for ${path}`);
  return def;
};

const policy: TradingPolicy = {
  ...DEFAULT_POLICY,
  includedIndices: ["sp500"],
  additionalSymbols: ["AAPL"],
  blocklist: ["GME", "AMC"],
  permittedOrderTypes: ["market", "limit"],
  sellToFundBuy: "off"
};

describe("console guardrails: protective-toggle loosening direction (Codex findings 3 & 4)", () => {
  it("declares DISABLING the volatility panic brake as the loosening", () => {
    const def = PANIC_BRAKE.find((d) => d.path === "volPanicBrakeEnabled")!;
    expect(def.looserWhen).toBe("off");
    expect(classify(def, true, false)).toBe("looser");
    expect(classify(def, false, true)).toBe("tighter");
  });

  it("declares DISABLING broker-held brackets as the loosening", () => {
    const def = PROTECTIVE_STOPS.find((d) => d.path === "brokerBracketsEnabled")!;
    expect(def.looserWhen).toBe("off");
    expect(classify(def, true, false)).toBe("looser");
    expect(classify(def, false, true)).toBe("tighter");
  });

  it("keeps enabling-is-looser semantics for genuinely risk-increasing toggles", () => {
    expect(classify(defByPath("shortSellingEnabled"), false, true)).toBe("looser");
    expect(classify(defByPath("permitExtendedHours"), false, true)).toBe("looser");
    expect(classify(defByPath("shortSellingEnabled"), true, false)).toBe("tighter");
  });
});

describe("console guardrails: extraPatch loosening classification (Codex finding 2)", () => {
  it("classifies universe broadening as looser and narrowing as tighter", () => {
    const [broadened] = classifyExtraPatch(policy, { includedIndices: ["sp500", "russell2000"] });
    expect(broadened.direction).toBe("looser");
    expect(broadened.label).toBe("Indices");
    expect(broadened.summary).toBe("adds Russell 2000");
    expect(broadened.summary).not.toMatch(/sp500|russell2000/);

    const [narrowed] = classifyExtraPatch(policy, { includedIndices: [] });
    expect(narrowed.direction).toBe("tighter");
    expect(narrowed.summary).toBe("removes S&P 500");
    expect(narrowed.summary).not.toMatch(/sp500/);
  });

  it("classifies added always-include symbols as looser", () => {
    const [entry] = classifyExtraPatch(policy, { additionalSymbols: ["AAPL", "TSLA"] });
    expect(entry.direction).toBe("looser");
    expect(entry.summary).toContain("TSLA");
  });

  it("classifies REMOVING blocklist entries as looser and adding as tighter", () => {
    const [loosened] = classifyExtraPatch(policy, { blocklist: ["GME"] });
    expect(loosened.direction).toBe("looser");
    expect(loosened.summary).toContain("AMC");

    const [tightened] = classifyExtraPatch(policy, { blocklist: ["GME", "AMC", "BBBY"] });
    expect(tightened.direction).toBe("tighter");
  });

  it("classifies enabling more order types as looser", () => {
    const [entry] = classifyExtraPatch(policy, { permittedOrderTypes: ["market", "limit", "stop_market"] });
    expect(entry.direction).toBe("looser");
    const [removed] = classifyExtraPatch(policy, { permittedOrderTypes: ["limit"] });
    expect(removed.direction).toBe("tighter");
  });

  it("classifies escalating sell-to-fund-buy as looser and de-escalating as tighter", () => {
    const [escalated] = classifyExtraPatch(policy, { sellToFundBuy: "automated" });
    expect(escalated.label).toBe("Sell to Fund Buys");
    expect(escalated.direction).toBe("looser");
    expect(escalated.summary).toBe("Off → Automated");
    const [deescalated] = classifyExtraPatch({ ...policy, sellToFundBuy: "automated" }, { sellToFundBuy: "off" });
    expect(deescalated.direction).toBe("tighter");
    expect(deescalated.summary).toBe("Automated → Off");
  });

  it("returns nothing for an absent extraPatch", () => {
    expect(classifyExtraPatch(policy, undefined)).toEqual([]);
  });
});

describe("console guardrails: cleared-field honesty (Codex finding 9)", () => {
  it("knows which cleared fields revert to a shipped default vs turn off", () => {
    // stopLossPct has a DEFAULT_POLICY value — clearing reverts to it (guard stays ON).
    expect(clearedFallback(defByPath("riskRules.stopLossPct"))).toBe(DEFAULT_POLICY.riskRules.stopLossPct);
    // maxOrderNotional ships without a default — clearing genuinely turns the cap off.
    expect(clearedFallback(defByPath("maxOrderNotional"))).toBeUndefined();
    // universeFloor keys live in a whole-stored object that overrides the default —
    // clearing one truly turns that floor off.
    expect(clearedFallback(defByPath("universeFloor.minPrice"))).toBeUndefined();
  });

  it("classifies clearing against the effective post-clear value, not blindly as 'looser'", () => {
    const stopLoss = defByPath("riskRules.stopLossPct");
    const shippedDefault = DEFAULT_POLICY.riskRules.stopLossPct!; // 8
    // 20% -> cleared: reverts to the 8% default, i.e. a TIGHTER stop.
    expect(classify(stopLoss, shippedDefault + 12, null)).toBe("tighter");
    // 5% -> cleared: reverts to 8%, i.e. LOOSER protection.
    expect(classify(stopLoss, shippedDefault - 3, null)).toBe("looser");
    // Clearing a no-default cap removes it entirely — the loosest move.
    expect(classify(defByPath("maxOrderNotional"), 100, null)).toBe("looser");
    // Clearing a no-default FLOOR also removes a guard — looser, not tighter.
    expect(classify(defByPath("universeFloor.minPrice"), 5, null)).toBe("looser");
    // Introducing a guard where none existed is tightening.
    expect(classify(defByPath("maxOrderNotional"), undefined, 250)).toBe("tighter");
  });

  it("classifies a LOWERED universe floor as looser (widens the universe), a raised one as tighter", () => {
    // Regression: a prior version returned `up ? looser : tighter` for BOTH looserWhen cases, so
    // lowering a "down" floor (e.g. min share price $5 -> $3) was mislabeled "Locks Down" when it
    // actually lets MORE names into the universe.
    const minPrice = defByPath("universeFloor.minPrice");
    expect(minPrice.looserWhen).toBe("down");
    expect(classify(minPrice, 5, 3)).toBe("looser"); // $5 -> $3: wider universe
    expect(classify(minPrice, 3, 5)).toBe("tighter"); // $3 -> $5: narrower universe
    expect(classify(defByPath("universeFloor.minDollarVolume"), 1_000_000, 500_000)).toBe("looser");
    // A regular "up" cap is unaffected: raising it still loosens.
    expect(classify(defByPath("maxGrossExposurePct"), 80, 90)).toBe("looser");
    expect(classify(defByPath("maxGrossExposurePct"), 90, 80)).toBe("tighter");
  });

  it("seeds whole-replaced nested parents in the PUT body so sibling floors survive", () => {
    const def = defByPath("universeFloor.minPrice");
    const diff = computeDiff(policy, { "universeFloor.minPrice": null }, [def]);
    expect(diff).toHaveLength(1);
    const patch = buildPatch(diff, policy) as { universeFloor: Record<string, unknown> };
    // The cleared key is null (stripNullsDeep => absent server-side)...
    expect(patch.universeFloor.minPrice).toBeNull();
    // ...and the untouched sibling floors ride along, because /api/policy
    // replaces universeFloor wholesale rather than deep-merging it.
    expect(patch.universeFloor.minMarketCapUsd).toBe(policy.universeFloor?.minMarketCapUsd);
    expect(patch.universeFloor.minDollarVolume).toBe(policy.universeFloor?.minDollarVolume);
  });
});

describe("console guardrails: configurable daily cap mode", () => {
  const money = defByPath("maxDailyNotional");
  const percent = defByPath("maxDailyPctOfNav");

  it("builds an exclusive percent-mode patch from the Guardrails draft", () => {
    const fixedPolicy = { ...policy, maxDailyNotional: 1_000, maxDailyPctOfNav: undefined };
    const diff = computeDiff(
      fixedPolicy,
      { maxDailyNotional: null, maxDailyPctOfNav: 20 },
      [money, percent]
    );

    expect(buildPatch(diff, fixedPolicy)).toMatchObject({
      maxDailyNotional: null,
      maxDailyPctOfNav: 20
    });
  });

  it("builds an exclusive fixed-dollar patch when switched back", () => {
    const percentPolicy = { ...policy, maxDailyNotional: undefined, maxDailyPctOfNav: 20 };
    const diff = computeDiff(
      percentPolicy,
      { maxDailyNotional: 250, maxDailyPctOfNav: null },
      [money, percent]
    );

    expect(buildPatch(diff, percentPolicy)).toMatchObject({
      maxDailyNotional: 250,
      maxDailyPctOfNav: null
    });
  });
});

describe("console guardrails: washSaleHandling select classification", () => {
  const def = defByPath("taxSettings.washSaleHandling");

  it("is a select field with the three modes ranked block < ask < auto", () => {
    expect(def.kind).toBe("select");
    expect(def.label).toBe("Taxable-account wash-sale rebuys");
    expect(def.hint).toContain("Auto (default)");
    expect(def.options?.map((o) => o.value)).toEqual(["block", "ask", "auto"]);
    expect(def.looseRank).toEqual({ block: 0, ask: 1, auto: 2 });
  });

  it("classifies block->ask and block->auto as LOOSER (typed word on LIVE)", () => {
    expect(classify(def, "block", "ask")).toBe("looser");
    expect(classify(def, "block", "auto")).toBe("looser");
    expect(classify(def, "ask", "auto")).toBe("looser");
  });

  it("classifies tightening back toward block as TIGHTER (one click, no typed word)", () => {
    expect(classify(def, "auto", "ask")).toBe("tighter");
    expect(classify(def, "ask", "block")).toBe("tighter");
    expect(classify(def, "auto", "block")).toBe("tighter");
  });

  it("treats a blank stored value as the shipped default ('auto', owner decision 2026-07-03)", () => {
    // Unset field: blank -> "block" or "ask" is TIGHTENING (auto is the loosest rank), one click.
    expect(classify(def, undefined, "block")).toBe("tighter");
    expect(classify(def, undefined, "ask")).toBe("tighter");
    expect(classify(def, "ask", undefined)).toBe("looser"); // ask(1) -> blank/auto(2): looser, typed word
    expect(classify(def, undefined, "auto")).toBe("changed"); // same rank as the default: no direction
  });
});

describe("console guardrails: iraWashSaleHandling select classification", () => {
  const def = defByPath("taxSettings.iraWashSaleHandling");

  it("is a select with block < auto < disregard looseness ranking", () => {
    expect(def.kind).toBe("select");
    expect(def.label).toBe("IRA taxable-loss rebuys");
    expect(def.hint).toContain("Under Rev. Rul. 2008-5");
    expect(def.options?.map((o) => o.value)).toEqual(["block", "auto", "disregard"]);
    expect(def.looseRank).toEqual({ block: 0, auto: 1, disregard: 2 });
  });

  it("classifies block->auto->disregard as LOOSER and back as TIGHTER", () => {
    expect(classify(def, "block", "auto")).toBe("looser");
    expect(classify(def, "auto", "disregard")).toBe("looser");
    expect(classify(def, "block", "disregard")).toBe("looser");
    expect(classify(def, "disregard", "auto")).toBe("tighter");
    expect(classify(def, "auto", "block")).toBe("tighter");
    expect(classify(def, "disregard", "block")).toBe("tighter");
  });

  it("treats a blank stored value as the shipped default ('disregard', owner decision 2026-07-03)", () => {
    // Unset field: blank -> "block" is TIGHTENING (disregard is the looser rank), one click.
    expect(classify(def, undefined, "block")).toBe("tighter");
    expect(classify(def, "block", undefined)).toBe("looser");
    expect(classify(def, undefined, "auto")).toBe("tighter");
    expect(classify(def, undefined, "disregard")).toBe("changed"); // same rank as the default: no direction
  });
});
