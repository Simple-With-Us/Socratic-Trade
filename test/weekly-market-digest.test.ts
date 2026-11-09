import { describe, expect, it } from "vitest";
import { rocPct } from "../src/lib/indicators";
import {
  buildWeeklyMarketDigest,
  collectDigestUniverse,
  compactWeeklyScreensForPrompt,
  computeMomentumFromCloses,
  hydrateDigestUniverse,
  impliedMarketCapUsd,
  passesValueScreen,
  pctAbove52wLow,
  WEEKLY_DIGEST_FILTERS,
  type DigestQuote
} from "../src/lib/weekly-market-digest";

function quote(partial: DigestQuote): DigestQuote {
  return partial;
}

const fis: DigestQuote = quote({
  symbol: "FIS",
  companyName: "Fidelity National Information Services",
  sector: "Technology",
  price: 66,
  volume: 2_400_000,
  marketCap: 35_000_000_000,
  peRatio: 8.2,
  fiftyTwoWeekLow: 63
});

const fisv: DigestQuote = quote({
  symbol: "FISV",
  companyName: "Fiserv",
  sector: "Technology",
  price: 128,
  volume: 3_100_000,
  marketCap: 72_000_000_000,
  peRatio: 9.4,
  fiftyTwoWeekLow: 121
});

const liquidGrowth: DigestQuote = quote({
  symbol: "COIN",
  companyName: "Coinbase",
  sector: "Financials",
  price: 220,
  volume: 8_000_000,
  marketCap: 55_000_000_000,
  peRatio: 28,
  fiftyTwoWeekLow: 140
});

const weakTape: DigestQuote = quote({
  symbol: "CBOE",
  companyName: "Cboe Global Markets",
  sector: "Financials",
  price: 230,
  volume: 1_200_000,
  marketCap: 24_000_000_000,
  peRatio: 22,
  fiftyTwoWeekLow: 170
});

describe("impliedMarketCapUsd / pctAbove52wLow", () => {
  it("prefers an explicit cap and otherwise uses shares × price", () => {
    expect(impliedMarketCapUsd({ marketCap: 12_000_000_000, sharesOutstanding: 1, price: 10 })).toBe(12_000_000_000);
    expect(impliedMarketCapUsd({ sharesOutstanding: 500_000_000, price: 40 })).toBe(20_000_000_000);
    expect(impliedMarketCapUsd({ price: 40 })).toBeUndefined();
  });

  it("returns undefined instead of fabricating a 52-week distance", () => {
    expect(pctAbove52wLow(66, 63)).toBeCloseTo(4.761, 2);
    expect(pctAbove52wLow(66, 0)).toBeUndefined();
    expect(pctAbove52wLow(0, 63)).toBeUndefined();
  });
});

describe("passesValueScreen", () => {
  it("keeps FIS / FISV-style large-caps near the 52-week low with a trailing P/E ≤ 10", () => {
    expect(passesValueScreen(fis)).toBe(true);
    expect(passesValueScreen(fisv)).toBe(true);
  });

  it("excludes missing P/E, 52-week low, cap, or volume instead of inventing them", () => {
    expect(passesValueScreen({ ...fis, peRatio: undefined })).toBe(false);
    expect(passesValueScreen({ ...fis, peRatio: 0 })).toBe(false);
    expect(passesValueScreen({ ...fis, peRatio: -4 })).toBe(false);
    expect(passesValueScreen({ ...fis, fiftyTwoWeekLow: undefined })).toBe(false);
    expect(passesValueScreen({ ...fis, marketCap: undefined, sharesOutstanding: undefined })).toBe(false);
    expect(passesValueScreen({ ...fis, volume: undefined })).toBe(false);
    expect(passesValueScreen({ ...fis, volume: 100_000 })).toBe(false);
    expect(passesValueScreen({ ...fis, price: 4.5 })).toBe(false);
    expect(passesValueScreen(liquidGrowth)).toBe(false);
  });
});

describe("collectDigestUniverse + hydrate", () => {
  it("uses the full quotesBySymbol tape, not only topCandidates", () => {
    const universe = collectDigestUniverse({
      topCandidates: [{ symbol: "COIN", price: 220, volume: 8_000_000, score: 90 } as never],
      quotesBySymbol: {
        FIS: { symbol: "FIS", price: 66, volume: 2_400_000, score: 12, peRatio: 8.2, fiftyTwoWeekLow: 63, marketCap: 35_000_000_000 },
        COIN: { symbol: "COIN", price: 220, volume: 8_000_000, score: 90 }
      }
    });
    const symbols = universe.map((row) => row.symbol).sort();
    expect(symbols).toEqual(["COIN", "FIS"]);
  });

  it("hydrates P/E and 52-week low from the field store without overwriting a live price", () => {
    const [hydrated] = hydrateDigestUniverse(
      [{ symbol: "FIS", price: 66, volume: 2_400_000 }],
      { FIS: { peRatio: { value: 8.2 }, fiftyTwoWeekLow: { value: 63 }, marketCap: { value: 35_000_000_000 } } }
    );
    expect(hydrated.price).toBe(66);
    expect(hydrated.peRatio).toBe(8.2);
    expect(hydrated.fiftyTwoWeekLow).toBe(63);
    expect(hydrated.marketCap).toBe(35_000_000_000);
  });
});

describe("buildWeeklyMarketDigest", () => {
  const rising = [100, 104, 108, 112, 116, 124];
  const fading = [200, 199, 198, 197, 196, 194];

  it("ranks momentum by 5-day return and leaves a weak CBOE-like tape last", () => {
    const digest = buildWeeklyMarketDigest({
      quotes: [weakTape, liquidGrowth, fis],
      closesBySymbol: {
        CBOE: fading,
        COIN: rising,
        FIS: [60, 61, 62, 63, 64, 66]
      },
      generatedAt: "2026-08-21T12:00:00.000Z"
    });
    expect(digest.momentum[0]?.symbol).toBe("COIN");
    expect(digest.momentum.map((row) => row.symbol)).toContain("CBOE");
    expect(digest.momentum.at(-1)?.symbol).toBe("CBOE");
    expect(digest.momentum[0]?.return5d).toBeCloseTo(rocPct(rising, 5) ?? NaN, 5);
    expect(digest.value.map((row) => row.symbol)).toEqual(["FIS"]);
  });

  it("does not fabricate ROC / RSI / MA when bars are missing", () => {
    const digest = buildWeeklyMarketDigest({
      quotes: [fis],
      generatedAt: "2026-08-21T12:00:00.000Z",
      status: "value_only"
    });
    expect(digest.value).toHaveLength(1);
    expect(digest.value[0]?.return5d).toBeUndefined();
    expect(digest.value[0]?.rsi14).toBeUndefined();
    expect(digest.value[0]?.sma200).toBeUndefined();
    expect(digest.momentum).toHaveLength(0);
    expect(digest.status).toBe("value_only");
    expect(digest.warnings.some((w) => w.includes("Momentum is waiting"))).toBe(true);
  });

  it("reports overlap when a value name also leads the 5-day tape", () => {
    const digest = buildWeeklyMarketDigest({
      quotes: [fis, liquidGrowth],
      closesBySymbol: {
        FIS: rising,
        COIN: fading
      },
      generatedAt: "2026-08-21T12:00:00.000Z"
    });
    expect(digest.overlap).toEqual(["FIS"]);
  });

  it("warns when value and momentum are disjoint", () => {
    const digest = buildWeeklyMarketDigest({
      quotes: [fis, liquidGrowth],
      closesBySymbol: {
        COIN: rising
      },
      generatedAt: "2026-08-21T12:00:00.000Z"
    });
    expect(digest.value.map((row) => row.symbol)).toEqual(["FIS"]);
    expect(digest.momentum.map((row) => row.symbol)).toEqual(["COIN"]);
    expect(digest.overlap).toEqual([]);
    expect(digest.warnings.some((w) => w.includes("No overlap"))).toBe(true);
  });
});

describe("compactWeeklyScreensForPrompt", () => {
  it("marks the compact block as advisory DATA, not a command", () => {
    const digest = buildWeeklyMarketDigest({
      quotes: [fis, liquidGrowth],
      closesBySymbol: { COIN: [100, 104, 108, 112, 116, 124], FIS: [60, 61, 62, 63, 64, 66] },
      generatedAt: "2026-08-21T12:00:00.000Z"
    });
    const compact = compactWeeklyScreensForPrompt(digest);
    expect(compact?.note).toMatch(/Advisory DATA only/);
    expect(compact?.note).toMatch(/Never a standalone trigger/);
    expect(compact?.value[0]?.symbol).toBe("FIS");
    expect(compact?.momentum[0]?.symbol).toBe("COIN");
  });

  it("omits a pending empty digest so the prompt stays clean", () => {
    expect(compactWeeklyScreensForPrompt({
      generatedAt: "2026-08-21T12:00:00.000Z",
      status: "pending",
      universeSize: 0,
      valueEvaluated: 0,
      momentumRanked: 0,
      barsCovered: 0,
      groupedDaysUsed: 0,
      filters: WEEKLY_DIGEST_FILTERS,
      value: [],
      momentum: [],
      overlap: [],
      warnings: ["No persisted market scan yet."]
    })).toBeUndefined();
  });
});

describe("computeMomentumFromCloses / rocPct", () => {
  it("needs period+1 closes and refuses a non-positive lookback", () => {
    expect(rocPct([10, 11, 12, 13, 14], 5)).toBeUndefined();
    expect(rocPct([10, 11, 12, 13, 14, 15], 5)).toBeCloseTo(50);
    expect(rocPct([0, 1, 2, 3, 4, 5], 5)).toBeUndefined();
    const mom = computeMomentumFromCloses([100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126, 128, 130]);
    expect(mom.return5d).toBeCloseTo(((130 / 120) - 1) * 100, 2);
    expect(mom.roc14).toBeDefined();
    expect(mom.rsi14).toBeDefined();
  });
});

