import { describe, expect, it } from "vitest";
import {
  DEFAULT_COPY_FOLLOW_POLICY,
  normalizeCopyUsername,
  scoreCopyInvestor,
  shouldAllowFollow,
  shouldObserve,
  summarizeLiveBook,
  type CopyRankRow
} from "../src/lib/copy-intel";

function row(over: Partial<CopyRankRow> = {}): CopyRankRow {
  return {
    username: "AlphaPilot",
    gain: 0.18,
    annualizedReturn: 0.14,
    riskScore: 4,
    copiers: 200,
    winRatio: 62,
    peakToValley: 0.12,
    profitableMonthsPct: 70,
    trades: 80,
    copyInvestmentPct: 5,
    highLeveragePct: 4,
    activeWeeks: 80,
    ...over
  };
}

describe("copy-intel scoring", () => {
  it("scores a healthy Popular Investor as eligible", () => {
    const scored = scoreCopyInvestor(row());
    expect(scored.username).toBe("alphapilot");
    expect(scored.eligibleToFollow).toBe(true);
    expect(scored.score).toBeGreaterThan(50);
    expect(scored.flags.some((f) => f.severity === "block")).toBe(false);
  });

  it("blocks high risk, copy-of-copies, short history, and leverage", () => {
    expect(scoreCopyInvestor(row({ riskScore: 9 })).eligibleToFollow).toBe(false);
    expect(scoreCopyInvestor(row({ copyInvestmentPct: 80 })).eligibleToFollow).toBe(false);
    expect(scoreCopyInvestor(row({ activeWeeks: 4 })).eligibleToFollow).toBe(false);
    expect(scoreCopyInvestor(row({ highLeveragePct: 90 })).eligibleToFollow).toBe(false);
    expect(scoreCopyInvestor(row({ winRatio: 20 })).eligibleToFollow).toBe(false);
  });

  it("never allows follow in observe mode even when the score is clean", () => {
    const scored = scoreCopyInvestor(row());
    expect(shouldObserve(DEFAULT_COPY_FOLLOW_POLICY)).toBe(true);
    expect(
      shouldAllowFollow({
        policy: DEFAULT_COPY_FOLLOW_POLICY,
        score: scored,
        currentFollowCount: 0
      })
    ).toBe(false);
  });

  it("allows follow only for an allowlisted username under caps", () => {
    const scored = scoreCopyInvestor(row());
    const policy = {
      ...DEFAULT_COPY_FOLLOW_POLICY,
      mode: "allowlist-follow" as const,
      allowlist: ["@AlphaPilot"]
    };
    expect(shouldAllowFollow({ policy, score: scored, currentFollowCount: 0 })).toBe(true);
    expect(shouldAllowFollow({ policy, score: scored, currentFollowCount: policy.maxFollows })).toBe(false);
    expect(
      shouldAllowFollow({
        policy: { ...policy, allowlist: ["someone-else"] },
        score: scored,
        currentFollowCount: 0
      })
    ).toBe(false);
  });

  it("summarizes a live book without fabricating symbols", () => {
    const book = summarizeLiveBook([
      { instrumentId: 1001, isBuy: true, leverage: 1, investmentPct: 40 },
      { instrumentId: 1002, isBuy: true, leverage: 5, investmentPct: 10 },
      { instrumentId: 1003, isBuy: false, leverage: 1, investmentPct: 50 }
    ]);
    expect(book.positionCount).toBe(3);
    expect(book.longPct).toBe(50);
    expect(book.leveragedPct).toBe(10);
    expect(book.topInstrumentIds[0]).toBe(1003);
  });

  it("normalizes @User names", () => {
    expect(normalizeCopyUsername("@FooBar")).toBe("foobar");
  });
});
