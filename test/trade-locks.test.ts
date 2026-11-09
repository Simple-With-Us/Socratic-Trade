import { describe, expect, it } from "vitest";
import {
  evaluateSymbolCooldown,
  evaluateSymbolLosingStreak,
  lockCoversQuery,
  newestCloseAt
} from "../src/lib/trade-locks";

describe("evaluateSymbolLosingStreak", () => {
  it("fires at the limit on newest-first losses", () => {
    const result = evaluateSymbolLosingStreak({
      outcomes: [{ returnPct: -2 }, { returnPct: -1 }, { returnPct: 4 }],
      streakLimit: 2
    });
    expect(result.firing).toBe(true);
    expect(result.consecutiveLossStreak).toBe(2);
  });

  it("a win breaks the streak", () => {
    expect(
      evaluateSymbolLosingStreak({
        outcomes: [{ returnPct: 1 }, { returnPct: -3 }, { returnPct: -3 }],
        streakLimit: 2
      }).firing
    ).toBe(false);
  });

  it("is off when the limit is unset", () => {
    expect(evaluateSymbolLosingStreak({ outcomes: [{ returnPct: -1 }, { returnPct: -1 }] }).firing).toBe(false);
  });
});

describe("evaluateSymbolCooldown", () => {
  it("fires while inside the window", () => {
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    const result = evaluateSymbolCooldown({
      lastClosedAt: "2026-08-14T11:30:00.000Z",
      cooldownMinutes: 60,
      now
    });
    expect(result.firing).toBe(true);
    expect(result.remainingMs).toBe(30 * 60_000);
  });

  it("clears after the window", () => {
    const now = Date.parse("2026-08-14T13:00:00.000Z");
    expect(
      evaluateSymbolCooldown({
        lastClosedAt: "2026-08-14T11:30:00.000Z",
        cooldownMinutes: 60,
        now
      }).firing
    ).toBe(false);
  });
});

describe("lockCoversQuery", () => {
  it("account lock covers any symbol", () => {
    expect(lockCoversQuery({ scope: "account", side: "*" }, { symbol: "AAPL", side: "long" })).toBe(true);
  });

  it("symbol lock is case-insensitive and side-specific", () => {
    expect(lockCoversQuery({ scope: "symbol", symbol: "aapl", side: "long" }, { symbol: "AAPL", side: "long" })).toBe(true);
    expect(lockCoversQuery({ scope: "symbol", symbol: "AAPL", side: "long" }, { symbol: "AAPL", side: "short" })).toBe(false);
    expect(lockCoversQuery({ scope: "symbol", symbol: "AAPL", side: "*" }, { symbol: "AAPL", side: "short" })).toBe(true);
  });
});

describe("newestCloseAt", () => {
  it("returns the latest exit", () => {
    expect(
      newestCloseAt([
        { exitAt: "2026-08-01T00:00:00.000Z" },
        { exitAt: "2026-08-10T00:00:00.000Z" },
        { exitAt: "not-a-date" }
      ])
    ).toBe("2026-08-10T00:00:00.000Z");
  });
});
