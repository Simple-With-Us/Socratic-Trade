/**
 * Unit tests for evidence_age_anomaly first-sight dedupe helpers (activity-audit P3 item 8).
 * Pure Map helpers only — no strategy run / DB.
 */
import { describe, expect, it } from "vitest";
import {
  evidenceAgeAnomalyDedupKey,
  rememberEvidenceAgeAnomalyDedupKey
} from "../src/lib/strategy";

describe("evidenceAgeAnomalyDedupKey", () => {
  it("includes user, account, id, and assertedAt", () => {
    expect(evidenceAgeAnomalyDedupKey("u1", "acct-a", "fact-1", "2026-08-05T12:00:00.000Z")).toBe(
      "u1:acct-a:fact-1:2026-08-05T12:00:00.000Z"
    );
  });

  it("uses 'global' when connectedAccountId is nullish", () => {
    expect(evidenceAgeAnomalyDedupKey("u1", undefined, "fact-1", "t1")).toBe("u1:global:fact-1:t1");
    expect(evidenceAgeAnomalyDedupKey("u1", null, "fact-1", "t1")).toBe("u1:global:fact-1:t1");
  });

  it("treats missing assertedAt as empty string so key still differentiates from other ids", () => {
    expect(evidenceAgeAnomalyDedupKey("u1", "a", "fact-1", undefined)).toBe("u1:a:fact-1:");
  });

  it("differs when assertedAt changes (re-assertion is a new first-sight)", () => {
    const a = evidenceAgeAnomalyDedupKey("u1", "a", "fact-1", "2026-08-01T00:00:00.000Z");
    const b = evidenceAgeAnomalyDedupKey("u1", "a", "fact-1", "2026-08-05T00:00:00.000Z");
    expect(a).not.toBe(b);
  });
});

describe("rememberEvidenceAgeAnomalyDedupKey", () => {
  it("returns true on first sight and false on subsequent sights (no TTL re-fire)", () => {
    const cache = new Map<string, true>();
    const key = evidenceAgeAnomalyDedupKey("u1", "a", "fact-1", "t1");
    expect(rememberEvidenceAgeAnomalyDedupKey(cache, key)).toBe(true);
    expect(rememberEvidenceAgeAnomalyDedupKey(cache, key)).toBe(false);
    expect(rememberEvidenceAgeAnomalyDedupKey(cache, key)).toBe(false);
    expect(cache.size).toBe(1);
  });

  it("allows a re-asserted fact (same id, new assertedAt) as a new first-sight", () => {
    const cache = new Map<string, true>();
    const k1 = evidenceAgeAnomalyDedupKey("u1", "a", "fact-1", "t1");
    const k2 = evidenceAgeAnomalyDedupKey("u1", "a", "fact-1", "t2");
    expect(rememberEvidenceAgeAnomalyDedupKey(cache, k1)).toBe(true);
    expect(rememberEvidenceAgeAnomalyDedupKey(cache, k2)).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("evicts oldest insertion-order keys when maxSize is exceeded (no bulk clear)", () => {
    const cache = new Map<string, true>();
    const maxSize = 3;
    for (let i = 0; i < 3; i++) {
      expect(rememberEvidenceAgeAnomalyDedupKey(cache, `k${i}`, maxSize)).toBe(true);
    }
    expect([...cache.keys()]).toEqual(["k0", "k1", "k2"]);

    // Inserting k3 should drop k0 only, not wipe the whole cache.
    expect(rememberEvidenceAgeAnomalyDedupKey(cache, "k3", maxSize)).toBe(true);
    expect([...cache.keys()]).toEqual(["k1", "k2", "k3"]);
    expect(cache.has("k0")).toBe(false);

    // After eviction, k0 is first-sight again.
    expect(rememberEvidenceAgeAnomalyDedupKey(cache, "k0", maxSize)).toBe(true);
    expect([...cache.keys()]).toEqual(["k2", "k3", "k0"]);
  });

  it("does not grow past maxSize under burst inserts", () => {
    const cache = new Map<string, true>();
    const maxSize = 5;
    for (let i = 0; i < 50; i++) {
      rememberEvidenceAgeAnomalyDedupKey(cache, `burst-${i}`, maxSize);
    }
    expect(cache.size).toBe(maxSize);
    expect(cache.has("burst-45")).toBe(true);
    expect(cache.has("burst-49")).toBe(true);
    expect(cache.has("burst-0")).toBe(false);
  });
});
