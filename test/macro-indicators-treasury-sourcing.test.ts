import { describe, expect, it } from "vitest";
import { buildSections, macroSourcing, type Board } from "../app/console/macro/indicators";
import type { MacroData } from "../src/lib/macro";

const BLANK_MACRO: MacroData = {
  fedFundsRate: "",
  dgs3moTreasury: "",
  dgs2Treasury: "",
  dgs10Treasury: "",
  inflationExpectation10y: "",
  cpiInflation: "",
  corePCE: "",
  realGDPGrowth: "",
  unemploymentRate: "",
  initialClaims: "",
  m2MoneySupply: "",
  m2GrowthYoY: "",
  hyCreditSpread: "",
  usdIndex: "",
  wtiOil: "",
  housingStarts: "",
  consumerSentiment: "",
  nonfarmPayrollsChangeK: "",
  vix: "",
  vix3m: "",
  asOf: "unavailable",
  fredSourced: false,
  treasurySourced: false
};

function makeBoard(macro: Partial<MacroData>): Board {
  return {
    macro: { ...BLANK_MACRO, ...macro },
    derived: {},
    signals: {},
    regime: "Unknown"
  };
}

describe("macroSourcing — treasury dimension", () => {
  it("is false when treasurySourced is unset/false (older payload or no keyless fallback ran)", () => {
    expect(macroSourcing(makeBoard({})).treasury).toBe(false);
    expect(macroSourcing(makeBoard({ treasurySourced: false })).treasury).toBe(false);
  });

  it("is true when the keyless Treasury.gov fallback populated the rate fields", () => {
    expect(macroSourcing(makeBoard({ treasurySourced: true, asOf: "2026-07-31" })).treasury).toBe(true);
  });

  it("does not default to the asOf-live heuristic the way fredSourced does (a live asOf alone isn't proof)", () => {
    // asOf is live (VIX-only fallback succeeded) but treasurySourced was never set — must stay false.
    const sourcing = macroSourcing(makeBoard({ asOf: "2026-07-31", vix: "22.50" }));
    expect(sourcing.treasury).toBe(false);
  });
});

describe("buildSections — 3M/2Y/10Y + curve tiles light up from the keyless Treasury fallback", () => {
  it("shows EM_DASH for rate/curve tiles when neither FRED nor Treasury sourced anything", () => {
    const board = makeBoard({});
    const sections = buildSections(board, macroSourcing(board));
    const rates = sections.find((s) => s.id === "rates")!.tiles;
    expect(rates.find((t) => t.key === "dgs10")!.value).toBe("—");
    expect(rates.find((t) => t.key === "curve3m10y")!.value).toBe("—");
  });

  it("shows real 3M/2Y/10Y values and derived curves when only the keyless Treasury fallback sourced them (no FRED key)", () => {
    const board: Board = {
      macro: {
        ...BLANK_MACRO,
        asOf: "2026-07-31",
        treasurySourced: true,
        dgs3moTreasury: "3.90%",
        dgs2Treasury: "4.20%",
        dgs10Treasury: "4.55%"
      },
      derived: { curve3m10y: 0.65, curve2s10s: 0.35 },
      signals: {},
      regime: "Unknown"
    };
    const sourcing = macroSourcing(board);
    expect(sourcing.fred).toBe(false);
    expect(sourcing.treasury).toBe(true);
    const rates = buildSections(board, sourcing).find((s) => s.id === "rates")!.tiles;
    expect(rates.find((t) => t.key === "dgs3mo")!.value).toBe("3.90%");
    expect(rates.find((t) => t.key === "dgs2")!.value).toBe("4.20%");
    expect(rates.find((t) => t.key === "dgs10")!.value).toBe("4.55%");
    expect(rates.find((t) => t.key === "curve3m10y")!.value).toBe("+0.65 pp");
    expect(rates.find((t) => t.key === "curve2s10s")!.value).toBe("+0.35 pp");
    // Fed funds and the policy curve (10Y − Fed funds) have no keyless source — stay blank.
    expect(rates.find((t) => t.key === "fedFunds")!.value).toBe("—");
    expect(rates.find((t) => t.key === "curvePolicy")!.value).toBe("—");
  });

  it("still blanks the rate tiles when Treasury sourcing failed too (both keyless lanes down)", () => {
    const board = makeBoard({ asOf: "unavailable", treasurySourced: false });
    const sections = buildSections(board, macroSourcing(board));
    const rates = sections.find((s) => s.id === "rates")!.tiles;
    expect(rates.find((t) => t.key === "dgs10")!.value).toBe("—");
  });
});

describe("macroSourcing — bls dimension", () => {
  it("is false when blsSourced is unset/false, and does not fall back to the asOf-live heuristic", () => {
    expect(macroSourcing(makeBoard({})).bls).toBe(false);
    expect(macroSourcing(makeBoard({ asOf: "2026-07-31", vix: "22.50" })).bls).toBe(false);
  });

  it("is true when the keyless/lightly-keyed BLS fallback populated CPI/unemployment/payrolls", () => {
    expect(macroSourcing(makeBoard({ blsSourced: true, asOf: "2026-07-31" })).bls).toBe(true);
  });
});

describe("buildSections — CPI/unemployment/payrolls + misery light up from the BLS fallback", () => {
  it("shows EM_DASH for cpi/unemployment/payrolls/misery when neither FRED nor BLS sourced anything", () => {
    const board = makeBoard({});
    const sections = buildSections(board, macroSourcing(board));
    const inflation = sections.find((s) => s.id === "inflation")!.tiles;
    const liquidity = sections.find((s) => s.id === "liquidity")!.tiles;
    expect(inflation.find((t) => t.key === "cpi")!.value).toBe("—");
    expect(inflation.find((t) => t.key === "misery")!.value).toBe("—");
    expect(liquidity.find((t) => t.key === "unemployment")!.value).toBe("—");
    expect(liquidity.find((t) => t.key === "nonfarmPayrolls")!.value).toBe("—");
  });

  it("shows real CPI/unemployment/payrolls and a computed misery index when only BLS sourced them (no FRED key)", () => {
    const board: Board = {
      macro: {
        ...BLANK_MACRO,
        asOf: "2026-07-31",
        blsSourced: true,
        cpiInflation: "3.53%",
        unemploymentRate: "4.20%",
        nonfarmPayrollsChangeK: "+57K"
      },
      derived: { miseryIndex: 7.73 },
      signals: {},
      regime: "Unknown"
    };
    const sourcing = macroSourcing(board);
    expect(sourcing.fred).toBe(false);
    expect(sourcing.bls).toBe(true);
    const inflation = buildSections(board, sourcing).find((s) => s.id === "inflation")!.tiles;
    const liquidity = buildSections(board, sourcing).find((s) => s.id === "liquidity")!.tiles;
    expect(inflation.find((t) => t.key === "cpi")!.value).toBe("3.53%");
    expect(inflation.find((t) => t.key === "misery")!.value).toBe("7.7");
    expect(liquidity.find((t) => t.key === "unemployment")!.value).toBe("4.20%");
    expect(liquidity.find((t) => t.key === "nonfarmPayrolls")!.value).toBe("+57K");
    // corePCE/realGDPGrowth have no BLS/keyless equivalent — stay blank.
    expect(inflation.find((t) => t.key === "corePce")!.value).toBe("—");
  });

  it("still blanks cpi/unemployment/payrolls when BLS sourcing failed too (both keyless lanes down)", () => {
    const board = makeBoard({ asOf: "unavailable", blsSourced: false });
    const sections = buildSections(board, macroSourcing(board));
    const inflation = sections.find((s) => s.id === "inflation")!.tiles;
    expect(inflation.find((t) => t.key === "cpi")!.value).toBe("—");
  });
});
