import { describe, it, expect } from "vitest";
import { parseFamaFrenchDaily, trailingSum } from "../src/lib/market-signals/famafrench";
import { summarizeCotRow } from "../src/lib/market-signals/cftc";

describe("parseFamaFrenchDaily", () => {
  const csv = [
    "This file was created by ...",
    "",
    ",Mkt-RF,SMB,HML,RF",
    "20260101,    0.10,   -0.20,    0.30,    0.02",
    "20260102,    0.20,    0.10,   -0.10,    0.02",
    "20260103,   -0.30,    0.05,    0.15,    0.02",
    "",
    "  Copyright 2026"
  ].join("\n");

  it("extracts factor columns and dated rows, skipping the preamble", () => {
    const parsed = parseFamaFrenchDaily(csv);
    expect(parsed.columns).toEqual(["Mkt-RF", "SMB", "HML", "RF"]);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]).toEqual({ date: "20260101", values: [0.1, -0.2, 0.3, 0.02] });
  });

  it("sums trailing daily values per factor (≈ cumulative return)", () => {
    const parsed = parseFamaFrenchDaily(csv);
    expect(trailingSum(parsed, "Mkt-RF", 3)).toBe(0); // 0.10 + 0.20 - 0.30
    expect(trailingSum(parsed, "SMB", 3)).toBe(-0.05); // -0.20 + 0.10 + 0.05
    expect(trailingSum(parsed, "HML", 2)).toBe(0.05); // last two: -0.10 + 0.15
    expect(trailingSum(parsed, "Mom", 3)).toBeUndefined(); // column absent
    expect(trailingSum(parsed, "Mkt-RF", 10)).toBeUndefined(); // not enough rows
  });
});

describe("summarizeCotRow", () => {
  it("computes large-spec and commercial net positioning and % of open interest", () => {
    const s = summarizeCotRow({
      contract_market_name: "E-MINI S&P 500",
      report_date_as_yyyy_mm_dd: "2026-06-09T00:00:00.000",
      open_interest_all: "2203164",
      noncomm_positions_long_all: "300000",
      noncomm_positions_short_all: "505644",
      comm_positions_long_all: "1500000",
      comm_positions_short_all: "1300000"
    });
    expect(s.contract).toBe("E-MINI S&P 500");
    expect(s.reportDate).toBe("2026-06-09");
    expect(s.nonCommNet).toBe(-205644); // net short
    expect(s.commNet).toBe(200000);
    expect(s.openInterest).toBe(2203164);
    expect(s.nonCommNetPctOI).toBe(-9.3); // -205644 / 2203164
  });
});
