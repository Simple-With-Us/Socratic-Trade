import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSp500ConstituentsCache,
  fetchSp500Constituents,
  parseCsvLine,
  parseSp500ConstituentsCsv
} from "../src/lib/market-signals/sp500-constituents";

// Realistic sample rows, shape live-verified against
// https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv
// on 2026-08-02. Header order and column names are the actual current schema.
const REALISTIC_CSV = `Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location,Date added,CIK,Founded
MMM,3M,Industrials,Industrial Conglomerates,"Saint Paul, Minnesota",1957-03-04,66740,1902
AOS,A. O. Smith,Industrials,Building Products,"Milwaukee, Wisconsin",2017-07-26,91142,1916
ABT,Abbott Laboratories,Health Care,Health Care Equipment,"North Chicago, Illinois",1957-03-04,1800,1888
BRK.B,Berkshire Hathaway,Financials,Multi-Sector Holdings,"Omaha, Nebraska",2010-02-16,1067983,1839
BF.B,Brown-Forman,Consumer Staples,Distillers & Vintners,"Louisville, Kentucky",1982-10-31,14693,1870`;

describe("parseCsvLine", () => {
  it("splits plain comma-separated fields", () => {
    expect(parseCsvLine("MMM,3M,Industrials")).toEqual(["MMM", "3M", "Industrials"]);
  });

  it("honors a quoted field containing a comma", () => {
    expect(parseCsvLine('MMM,3M,Industrials,Industrial Conglomerates,"Saint Paul, Minnesota",1957-03-04,66740,1902')).toEqual([
      "MMM",
      "3M",
      "Industrials",
      "Industrial Conglomerates",
      "Saint Paul, Minnesota",
      "1957-03-04",
      "66740",
      "1902"
    ]);
  });

  it("unescapes doubled quotes inside a quoted field", () => {
    expect(parseCsvLine('A,"Say ""hi""",B')).toEqual(["A", 'Say "hi"', "B"]);
  });
});

describe("parseSp500ConstituentsCsv", () => {
  it("parses realistic rows into symbol/name/sector", () => {
    const rows = parseSp500ConstituentsCsv(REALISTIC_CSV);
    expect(rows).toEqual([
      { symbol: "MMM", name: "3M", sector: "Industrials" },
      { symbol: "AOS", name: "A. O. Smith", sector: "Industrials" },
      { symbol: "ABT", name: "Abbott Laboratories", sector: "Health Care" },
      { symbol: "BRK-B", name: "Berkshire Hathaway", sector: "Financials" },
      { symbol: "BF-B", name: "Brown-Forman", sector: "Consumer Staples" }
    ]);
  });

  it("canonicalizes dotted share-class symbols to this repo's hyphen convention", () => {
    const rows = parseSp500ConstituentsCsv(REALISTIC_CSV);
    const brk = rows.find((r) => r.name === "Berkshire Hathaway");
    expect(brk?.symbol).toBe("BRK-B");
    const bf = rows.find((r) => r.name === "Brown-Forman");
    expect(bf?.symbol).toBe("BF-B");
  });

  it("returns [] for a header-only CSV", () => {
    expect(
      parseSp500ConstituentsCsv(
        "Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location,Date added,CIK,Founded"
      )
    ).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(parseSp500ConstituentsCsv("")).toEqual([]);
  });

  it("returns [] when the header doesn't contain the required Symbol/Security columns (malformed/unrecognized schema)", () => {
    expect(parseSp500ConstituentsCsv("Ticker,CompanyName\nMMM,3M")).toEqual([]);
  });

  it("skips a row missing symbol or name but keeps the rest", () => {
    const csv = `Symbol,Security,GICS Sector
MMM,3M,Industrials
,Missing Symbol Co,Industrials
AOS,,Industrials
ABT,Abbott Laboratories,Health Care`;
    expect(parseSp500ConstituentsCsv(csv)).toEqual([
      { symbol: "MMM", name: "3M", sector: "Industrials" },
      { symbol: "ABT", name: "Abbott Laboratories", sector: "Health Care" }
    ]);
  });

  it("omits sector when the GICS Sector column is absent", () => {
    expect(parseSp500ConstituentsCsv("Symbol,Security\nMMM,3M")).toEqual([{ symbol: "MMM", name: "3M" }]);
  });
});

describe("fetchSp500Constituents", () => {
  beforeEach(() => {
    clearSp500ConstituentsCache();
    delete process.env.SP500_CONSTITUENTS_CACHE_TTL_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSp500ConstituentsCache();
    delete process.env.SP500_CONSTITUENTS_CACHE_TTL_MS;
  });

  it("fetches and parses the live CSV shape on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => REALISTIC_CSV }));
    const result = await fetchSp500Constituents(Date.UTC(2026, 7, 2));
    expect(result).toEqual([
      { symbol: "MMM", name: "3M", sector: "Industrials" },
      { symbol: "AOS", name: "A. O. Smith", sector: "Industrials" },
      { symbol: "ABT", name: "Abbott Laboratories", sector: "Health Care" },
      { symbol: "BRK-B", name: "Berkshire Hathaway", sector: "Financials" },
      { symbol: "BF-B", name: "Brown-Forman", sector: "Consumer Staples" }
    ]);
  });

  it("caches within the TTL — a second call inside the window doesn't refetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => REALISTIC_CSV });
    vi.stubGlobal("fetch", fetchMock);
    const t0 = Date.UTC(2026, 7, 2);
    const first = await fetchSp500Constituents(t0);
    const second = await fetchSp500Constituents(t0 + 60_000); // 1 minute later, well inside the 24h default TTL
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has elapsed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => REALISTIC_CSV });
    vi.stubGlobal("fetch", fetchMock);
    const t0 = Date.UTC(2026, 7, 2);
    await fetchSp500Constituents(t0);
    await fetchSp500Constituents(t0 + 25 * 60 * 60_000); // 25h later, past the 24h default TTL
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null on a non-200 response (never fabricates)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await fetchSp500Constituents(Date.UTC(2026, 7, 2))).toBeNull();
  });

  it("returns null on a network error (never fabricates)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await fetchSp500Constituents(Date.UTC(2026, 7, 2))).toBeNull();
  });

  it("returns null on malformed/empty body instead of an empty-but-fresh-looking list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "not a csv at all" }));
    expect(await fetchSp500Constituents(Date.UTC(2026, 7, 2))).toBeNull();
  });

  it("does not cache a failed fetch — a subsequent success is served normally", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, text: async () => REALISTIC_CSV });
    vi.stubGlobal("fetch", fetchMock);
    const t0 = Date.UTC(2026, 7, 2);
    expect(await fetchSp500Constituents(t0)).toBeNull();
    const result = await fetchSp500Constituents(t0 + 1000);
    expect(result?.length).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
