import { describe, expect, it } from "vitest";
import {
  bookDepthFrom,
  classifyMarketKind,
  crowdLeanFromYes,
  isUsScopedQuestion,
  parseYesNoPercents,
  themesForQuote,
  tiltFrom,
  yesImpliesForKind
} from "../src/lib/polymarket-signals";
import { attachThemesToSymbols } from "../src/lib/polymarket-provider";

describe("polymarket-signals", () => {
  it("classifies question kinds without inventing a side for garbage", () => {
    expect(classifyMarketKind("Will Apple beat earnings estimates?")).toBe("earnings_beat");
    expect(classifyMarketKind("Will NVDA close above $200?")).toBe("price_above");
    expect(classifyMarketKind("US recession by end of 2026?")).toBe("recession");
    expect(classifyMarketKind("How many Fed rate cuts in 2026?")).toBe("fed_cut");
    expect(classifyMarketKind("Will the Fed hike in September?")).toBe("fed_hike");
    expect(classifyMarketKind("US CPI above 3%?")).toBe("inflation");
    expect(classifyMarketKind("WTI oil above $90?")).toBe("oil");
    expect(classifyMarketKind("Trump imposes a semiconductor tariff?")).toBe("tariff");
    expect(classifyMarketKind("Will the DOJ break up Google?")).toBe("regulation");
    expect(classifyMarketKind("Will the Chiefs win the Super Bowl?")).toBe("other");
  });

  it("derives tilt from Yes token + kind, not from whichever side is winning", () => {
    expect(tiltFrom("bullish", "yes_favored", "ok")).toBe("bullish");
    expect(tiltFrom("bearish", "no_favored", "ok")).toBe("bullish");
    expect(tiltFrom("bearish", "near_even", "ok")).toBe("neutral");
    expect(tiltFrom("unclear", "yes_favored", "deep")).toBe("unclear");
    expect(tiltFrom("bullish", "yes_favored", "thin")).toBe("neutral");
  });

  it("parses Yes/No by label without shifting a bad price entry", () => {
    expect(parseYesNoPercents(["Yes", "No"], [0.62, 0.38])).toEqual({ yesPct: 62, noPct: 38 });
    expect(parseYesNoPercents(["No", "Yes"], [0.92, 0.08])).toEqual({ yesPct: 8, noPct: 92 });
    expect(parseYesNoPercents(["Yes", "No"], [Number.NaN, 0.4])).toBeUndefined();
  });

  it("maps NVDA semiconductors to the chip theme and leaves AAPL out", () => {
    const nvda = themesForQuote({ sector: "Technology", industry: "Semiconductors" }).map((t) => t.id);
    const aapl = themesForQuote({ sector: "Technology", industry: "Consumer Electronics" }).map((t) => t.id);
    expect(nvda).toContain("semiconductors");
    expect(aapl).not.toContain("semiconductors");
  });

  it("drops non-US recession/inflation questions from the macro filter", () => {
    expect(isUsScopedQuestion("US recession by end of 2026?")).toBe(true);
    expect(isUsScopedQuestion("Japan recession in 2026?")).toBe(false);
    expect(isUsScopedQuestion("Argentina monthly inflation 1.8%?")).toBe(false);
    expect(isUsScopedQuestion("Will the Fed cut rates?")).toBe(true);
  });

  it("attaches theme books only to matching symbols", () => {
    const merged = attachThemesToSymbols(
      [
        { symbol: "NVDA", sector: "Technology", industry: "Semiconductors" },
        { symbol: "AAPL", sector: "Technology", industry: "Consumer Electronics" }
      ],
      {
        semiconductors: [
          {
            question: "Trump imposes a semiconductor tariff?",
            impliedProbabilityPct: 41,
            yesPct: 41,
            noPct: 59,
            scope: "theme",
            themeId: "semiconductors",
            kind: "tariff",
            tilt: "neutral",
            bookDepth: "ok"
          }
        ]
      },
      {
        NVDA: [{ question: "Will NVDA beat earnings?", impliedProbabilityPct: 60, scope: "company" }],
        AAPL: [{ question: "Will AAPL beat earnings?", impliedProbabilityPct: 55, scope: "company" }]
      }
    );
    expect(merged.NVDA?.some((row) => row.themeId === "semiconductors")).toBe(true);
    expect(merged.AAPL?.some((row) => row.themeId === "semiconductors")).toBe(false);
  });

  it("labels book depth without emitting a score", () => {
    expect(bookDepthFrom(200)).toBe("thin");
    expect(bookDepthFrom(5_000)).toBe("ok");
    expect(bookDepthFrom(80_000)).toBe("deep");
    expect(crowdLeanFromYes(62)).toBe("yes_favored");
    expect(crowdLeanFromYes(8)).toBe("no_favored");
    expect(yesImpliesForKind("recession")).toBe("bearish");
  });
});
