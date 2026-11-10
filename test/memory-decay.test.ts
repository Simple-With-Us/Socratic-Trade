import { describe, expect, it } from "vitest";
import { blendedScore, docImportance, recencyScore, shouldSoftArchive } from "../src/lib/memory-decay";

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
