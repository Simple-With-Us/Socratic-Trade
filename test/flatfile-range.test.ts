import { describe, expect, it } from "vitest";
import { businessDaysBetween, pivotDayAggsToSeries, type FlatFileBar } from "../src/lib/market-signals/massive-s3";

describe("businessDaysBetween", () => {
  it("returns inclusive weekdays, skipping Sat/Sun", () => {
    // 2026-06-25 is a Thursday; 2026-06-29 is the next Monday.
    expect(businessDaysBetween("2026-06-25", "2026-06-29")).toEqual([
      "2026-06-25", // Thu
      "2026-06-26", // Fri
      // 27 Sat, 28 Sun skipped
      "2026-06-29" // Mon
    ]);
  });

  it("handles a single day and an empty/reversed/invalid range", () => {
    expect(businessDaysBetween("2026-06-25", "2026-06-25")).toEqual(["2026-06-25"]); // Thursday
    expect(businessDaysBetween("2026-06-27", "2026-06-28")).toEqual([]); // Sat–Sun only
    expect(businessDaysBetween("2026-06-29", "2026-06-25")).toEqual([]); // reversed
    expect(businessDaysBetween("not-a-date", "2026-06-25")).toEqual([]);
  });
});

describe("pivotDayAggsToSeries", () => {
  const day = (date: string, rows: Array<[string, number, number?]>): { date: string; bars: FlatFileBar[] } => ({
    date,
    bars: rows.map(([ticker, close, volume]) => ({ ticker, close, volume }))
  });

  it("pivots per-day grouped bars into per-ticker ascending series with the file date as the bar time", () => {
    const series = pivotDayAggsToSeries([
      day("2026-06-23", [["AAPL", 200, 1000], ["MSFT", 400]]),
      day("2026-06-24", [["AAPL", 205, 1100]])
    ]);
    expect(series.get("AAPL")).toEqual([
      { time: "2026-06-23", open: undefined, high: undefined, low: undefined, close: 200, volume: 1000 },
      { time: "2026-06-24", open: undefined, high: undefined, low: undefined, close: 205, volume: 1100 }
    ]);
    expect(series.get("MSFT")).toHaveLength(1);
  });

  it("filters to the requested tickers and uppercases", () => {
    const series = pivotDayAggsToSeries(
      [day("2026-06-23", [["aapl", 200], ["NVDA", 1000], ["MSFT", 400]])],
      new Set(["AAPL", "NVDA"])
    );
    expect([...series.keys()].sort()).toEqual(["AAPL", "NVDA"]);
    expect(series.get("AAPL")?.[0].close).toBe(200);
  });
});

import { isBarSeriesFresh, mergeOHLCBars, type OHLCBar } from "../src/lib/history";

describe("isBarSeriesFresh & mergeOHLCBars", () => {
  it("isBarSeriesFresh evaluates series freshness by trading session, not calendar days", () => {
    const mondayBar: OHLCBar = { time: "2026-08-03", close: 100 }; // Monday
    const fridayBar: OHLCBar = { time: "2026-07-31", close: 90 };
    const wednesdayNow = new Date("2026-08-05T16:00:00Z").getTime(); // Wed during session

    expect(isBarSeriesFresh([fridayBar, mondayBar], wednesdayNow)).toBe(false);
    expect(isBarSeriesFresh([mondayBar, { time: "2026-08-04", close: 101 }], wednesdayNow)).toBe(true);
    expect(isBarSeriesFresh(null)).toBe(false);
    expect(isBarSeriesFresh([])).toBe(false);
  });

  it("isBarSeriesFresh treats a recent session bar as fresh across a weekend gap", () => {
    const thursdayBar: OHLCBar = { time: "2026-08-20", close: 99 };
    const fridayBar: OHLCBar = { time: "2026-08-21", close: 100 };
    const mondayMorning = new Date("2026-08-24T14:00:00Z").getTime(); // Mon 10:00 ET (EDT)
    expect(isBarSeriesFresh([thursdayBar, fridayBar], mondayMorning)).toBe(true);
  });

  it("mergeOHLCBars deduplicates by YYYY-MM-DD date and sorts ascending", () => {
    const existing: OHLCBar[] = [
      { time: "2026-08-01", close: 100, open: 98, high: 101, low: 97 },
      { time: "2026-08-02", close: 102, open: 100, high: 103, low: 99 }
    ];
    const incoming: OHLCBar[] = [
      { time: "2026-08-02", close: 102.5, open: 100, high: 103, low: 99 }, // update L2
      { time: "2026-08-03", close: 105, open: 103, high: 106, low: 102 }   // new L3
    ];

    const merged = mergeOHLCBars(existing, incoming);
    expect(merged).toHaveLength(3);
    expect(merged.map((b) => b.time)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(merged[1].close).toBe(102.5);
  });
});
