import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "headline-first-seen-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;

import {
  getOrRecordHeadlineFirstSeen,
  headlineFingerprint,
  pruneHeadlineFirstSeen,
  recordHeadlineFirstSeenBatch
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

describe("recordHeadlineFirstSeenBatch (ST-4643 / audit F4)", () => {
  it("records a whole batch in one read and one transaction", () => {
    const t0 = new Date("2026-08-04T10:00:00.000Z");
    const first = recordHeadlineFirstSeenBatch({
      userId: "u-batch",
      items: [
        { symbol: "AAPL", text: "Batch headline one" },
        { symbol: "MSFT", text: "Batch headline two" },
        { symbol: "NVDA", text: "Batch headline three" }
      ],
      now: t0
    });
    expect(first).toEqual([t0.toISOString(), t0.toISOString(), t0.toISOString()]);
    const rows = getDb()
      .prepare("SELECT count(*) c FROM headline_first_seen WHERE user_id = 'u-batch'")
      .get() as { c: number };
    expect(rows.c).toBe(3);
  });

  it("reuses the original first-seen for a headline it already knows", () => {
    const t0 = new Date("2026-08-04T10:00:00.000Z");
    recordHeadlineFirstSeenBatch({
      userId: "u-batch2",
      items: [{ symbol: "AAPL", text: "Known headline" }],
      now: t0
    });
    const later = new Date("2026-08-04T18:00:00.000Z");
    const first = recordHeadlineFirstSeenBatch({
      userId: "u-batch2",
      items: [
        { symbol: "AAPL", text: "Known headline" },
        { symbol: "MSFT", text: "Brand new headline" }
      ],
      now: later
    });
    expect(first[0]).toBe(t0.toISOString());
    expect(first[1]).toBe(later.toISOString());
    const rows = getDb()
      .prepare("SELECT count(*) c FROM headline_first_seen WHERE user_id = 'u-batch2'")
      .get() as { c: number };
    expect(rows.c).toBe(2);
  });

  it("tolerates the same headline twice inside one batch", () => {
    const t0 = new Date("2026-08-04T10:00:00.000Z");
    const first = recordHeadlineFirstSeenBatch({
      userId: "u-batch3",
      items: [
        { symbol: "AAPL", text: "Repeated headline" },
        { symbol: "AAPL", text: "Repeated headline" }
      ],
      now: t0
    });
    expect(first).toEqual([t0.toISOString(), t0.toISOString()]);
    const rows = getDb()
      .prepare("SELECT count(*) c FROM headline_first_seen WHERE user_id = 'u-batch3'")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it("returns undefined for a headline with no usable fingerprint", () => {
    const first = recordHeadlineFirstSeenBatch({
      userId: "u-batch4",
      items: [
        { symbol: "AAPL", text: "   " },
        { symbol: "MSFT", text: "Real headline" }
      ],
      now: new Date("2026-08-04T10:00:00.000Z")
    });
    expect(first[0]).toBeUndefined();
    expect(first[1]).toBe("2026-08-04T10:00:00.000Z");
  });
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
