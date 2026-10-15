import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "headline-first-seen-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;

import {
  getOrRecordHeadlineFirstSeen,
  headlineFingerprint,
  pruneHeadlineFirstSeen
} from "../src/lib/headline-first-seen";
import { collectEvidenceAgeAnomalies } from "../src/lib/prompt-safety";
import { getDb } from "../src/lib/db";

describe("headlineFingerprint", () => {
  it("normalizes case and punctuation", () => {
    expect(headlineFingerprint("Apple Beats Estimates!")).toBe(headlineFingerprint("apple  beats   estimates"));
  });
  it("returns empty for blank input", () => {
    expect(headlineFingerprint("   ")).toBe("");
    expect(headlineFingerprint("!!!")).toBe("");
  });
});

describe("getOrRecordHeadlineFirstSeen", () => {
  beforeAll(() => {
    getDb(); // ensure migrate incl. v66
  });

  it("records first seen once and reuses it", () => {
    const t0 = new Date("2026-08-04T10:00:00.000Z");
    const first = getOrRecordHeadlineFirstSeen({
      userId: "u1",
      symbol: "AAPL",
      text: "Apple reports strong iPhone sales",
      now: t0
    });
    expect(first).toBe(t0.toISOString());

    const later = getOrRecordHeadlineFirstSeen({
      userId: "u1",
      symbol: "AAPL",
      text: "Apple reports strong iPhone sales",
      now: new Date("2026-08-04T18:00:00.000Z")
    });
    expect(later).toBe(t0.toISOString());
  });

  it("scopes fingerprints per user", () => {
    const a = getOrRecordHeadlineFirstSeen({
      userId: "alice",
      symbol: "MSFT",
      text: "Microsoft cloud growth accelerates",
      now: new Date("2026-08-04T11:00:00.000Z")
    });
    const b = getOrRecordHeadlineFirstSeen({
      userId: "bob",
      symbol: "MSFT",
      text: "Microsoft cloud growth accelerates",
      now: new Date("2026-08-04T12:00:00.000Z")
    });
    expect(a).toBe("2026-08-04T11:00:00.000Z");
    expect(b).toBe("2026-08-04T12:00:00.000Z");
  });

  it("feeds evidence-age anomalies when first-seen is same-day", () => {
    const now = new Date("2026-08-04T16:00:00.000Z");
    const firstSeen = getOrRecordHeadlineFirstSeen({
      userId: "u-age",
      symbol: "NVDA",
      text: "Nvidia guidance raised on AI demand",
      now: new Date("2026-08-04T08:00:00.000Z")
    })!;
    const anomalies = collectEvidenceAgeAnomalies(
      [
        {
          kind: "headline",
          id: "headline:NVDA:x",
          label: "NVDA news: Nvidia guidance raised",
          timestamp: firstSeen
        }
      ],
      now
    );
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.kind).toBe("headline");
    expect(anomalies[0]!.ageHours).toBeGreaterThan(0);
  });

  it("does not prune stale last_seen rows (forever retention)", () => {
    getOrRecordHeadlineFirstSeen({
      userId: "u-prune",
      symbol: "OLD",
      text: "Ancient headline for prune test xyz",
      now: new Date("2020-01-01T00:00:00.000Z")
    });
    getDb()
      .prepare(`UPDATE headline_first_seen SET last_seen = ? WHERE user_id = ?`)
      .run("2020-01-02T00:00:00.000Z", "u-prune");
    expect(pruneHeadlineFirstSeen(7 * 24 * 60 * 60 * 1000, Date.parse("2026-08-04T00:00:00.000Z"))).toBe(0);
    expect(
      (getDb().prepare("SELECT count(*) c FROM headline_first_seen WHERE user_id = ?").get("u-prune") as { c: number }).c
    ).toBe(1);
  });
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
