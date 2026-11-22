import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMemoryDecayWeighting,
  blendedScore,
  docImportance,
  memoryDecayMultiplier,
  MEMORY_DECAY_NUDGE,
  recencyScore,
  shouldSoftArchive
} from "../src/lib/memory-decay";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recencyScore", () => {
  it("is 1 at age 0 and ~0.5 at the half-life", () => {
    expect(recencyScore(0, 45)).toBe(1);
    expect(recencyScore(45, 45)).toBeCloseTo(0.5, 5);
  });
});

describe("docImportance", () => {
  it("is neutral 50 with no history", () => {
    expect(docImportance(undefined)).toBe(50);
    expect(docImportance({ samples: 0, wins: 0, losses: 0 })).toBe(50);
  });

  it("is 100 after only wins", () => {
    expect(docImportance({ samples: 4, wins: 4, losses: 0 })).toBe(100);
  });
});

describe("blendedScore", () => {
  it("cannot invert a large similarity gap via importance", () => {
    const highSimLowImp = blendedScore(0.9, 0.1, 0);
    const lowSimHighImp = blendedScore(0.2, 1, 100);
    expect(highSimLowImp).toBeGreaterThan(lowSimHighImp);
  });
});

describe("shouldSoftArchive", () => {
  it("never archives lessons or young docs", () => {
    expect(shouldSoftArchive({ recency: 0.01, blended: 0.01, ageDays: 400, docType: "lesson" })).toBe(false);
    expect(shouldSoftArchive({ recency: 0.01, blended: 0.01, ageDays: 10, docType: "experience" })).toBe(false);
  });

  it("archives old low-score experience docs", () => {
    expect(shouldSoftArchive({ recency: 0.05, blended: 0.1, ageDays: 200, docType: "experience" })).toBe(true);
  });
});

describe("memoryDecayMultiplier (ST-4652)", () => {
  const NOW = Date.parse("2026-11-22T00:00:00.000Z");
  const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

  it("is +nudge for a just-written doc, neutral at one half-life, floor for very old docs", () => {
    expect(memoryDecayMultiplier({ doc_type: "socratic-decision", as_of: daysAgo(0) }, NOW)).toBeCloseTo(
      1 + MEMORY_DECAY_NUDGE,
      10
    );
    // socratic-decision half-life is 45 days: recency 0.5 -> multiplier exactly 1.
    expect(memoryDecayMultiplier({ doc_type: "socratic-decision", as_of: daysAgo(45) }, NOW)).toBeCloseTo(1, 10);
    expect(memoryDecayMultiplier({ doc_type: "socratic-decision", as_of: daysAgo(3650) }, NOW)).toBeCloseTo(
      1 - MEMORY_DECAY_NUDGE,
      3
    );
  });

  it("is neutral for undated or unparseable chunks (missing lifecycle row / legacy vector)", () => {
    expect(memoryDecayMultiplier({ doc_type: "lesson" }, NOW)).toBe(1);
    expect(memoryDecayMultiplier({ doc_type: "lesson", as_of: "not-a-date" }, NOW)).toBe(1);
    expect(memoryDecayMultiplier({ doc_type: "lesson", metadata: {} }, NOW)).toBe(1);
  });

  it("is neutral for future-dated chunks (typo/skew must not earn the maximum boost)", () => {
    expect(memoryDecayMultiplier({ doc_type: "socratic-decision", as_of: daysAgo(-30) }, NOW)).toBe(1);
    expect(memoryDecayMultiplier({ doc_type: "lesson", metadata: { timestamp: daysAgo(-1) } }, NOW)).toBe(1);
  });

  it("reads metadata timestamps when as_of is absent", () => {
    expect(
      memoryDecayMultiplier({ doc_type: "lesson", metadata: { timestamp: daysAgo(0) } }, NOW)
    ).toBeCloseTo(1 + MEMORY_DECAY_NUDGE, 10);
  });
});

describe("applyMemoryDecayWeighting (ST-4652)", () => {
  const NOW = Date.parse("2026-11-22T00:00:00.000Z");
  const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
  const chunk = (id: string, ageDaysValue?: number) => ({
    id,
    doc_type: "socratic-decision",
    ...(ageDaysValue === undefined ? {} : { as_of: daysAgo(ageDaysValue) })
  });

  it("is OFF by default: incoming order preserved exactly (pre-ST-4652 behavior)", () => {
    const input = [chunk("old-first", 365), chunk("fresh-second", 0)];
    const result = applyMemoryDecayWeighting(input, NOW);
    expect(result.map((c) => c.id)).toEqual(["old-first", "fresh-second"]);
  });

  it("stays off for RAG_MEMORY_DECAY_WEIGHTING=off and for garbage values", () => {
    const input = [chunk("old-first", 365), chunk("fresh-second", 0)];
    vi.stubEnv("RAG_MEMORY_DECAY_WEIGHTING", "off");
    expect(applyMemoryDecayWeighting(input, NOW).map((c) => c.id)).toEqual(["old-first", "fresh-second"]);
    vi.stubEnv("RAG_MEMORY_DECAY_WEIGHTING", "banana");
    expect(applyMemoryDecayWeighting(input, NOW).map((c) => c.id)).toEqual(["old-first", "fresh-second"]);
  });

  it("when enabled, an adjacent fresh doc overtakes an adjacent very old doc", () => {
    vi.stubEnv("RAG_MEMORY_DECAY_WEIGHTING", "on");
    const result = applyMemoryDecayWeighting([chunk("old-first", 365), chunk("fresh-second", 0)], NOW);
    expect(result.map((c) => c.id)).toEqual(["fresh-second", "old-first"]);
  });

  it("when enabled, displacement is bounded: a fresh doc 25 ranks back cannot take rank 0", () => {
    vi.stubEnv("RAG_MEMORY_DECAY_WEIGHTING", "on");
    const input = [
      ...Array.from({ length: 25 }, (_, i) => chunk(`old-${i}`, 3650)),
      chunk("fresh-last", 0)
    ];
    const result = applyMemoryDecayWeighting(input, NOW);
    // The +15% fresh doc passes only the old docs whose positional base it beats
    // (1.15/85 vs 0.85/(60+i) -> i >= 3); the top old docs keep their slots.
    expect(result[0]!.id).toBe("old-0");
    expect(result.findIndex((c) => c.id === "fresh-last")).toBe(3);
  });

  it("when enabled, equal dates and undated chunks keep byte-identical order", () => {
    vi.stubEnv("RAG_MEMORY_DECAY_WEIGHTING", "on");
    const sameAge = [chunk("a", 90), chunk("b", 90), chunk("c", 90)];
    expect(applyMemoryDecayWeighting(sameAge, NOW).map((c) => c.id)).toEqual(["a", "b", "c"]);
    const undated = [chunk("a"), chunk("b"), chunk("c")];
    expect(applyMemoryDecayWeighting(undated, NOW).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});
