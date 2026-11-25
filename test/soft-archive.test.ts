// OD-7 weekly soft-archive: pure classification of lifecycle rows and the capped blend the
// sweep feeds shouldSoftArchive. No DB access in this file; the writer (archiveVectorDocs)
// and the watermark pass are covered by the module's own audit path in CI elsewhere.
import { describe, expect, it } from "vitest";
import {
  decideSoftArchiveRow,
  SOFT_ARCHIVE_MIN_SAMPLES,
  softArchiveComposite
} from "../src/lib/soft-archive";

const NOW = Date.parse("2026-11-22T00:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

describe("decideSoftArchiveRow", () => {
  it("never archives lessons or coach notes, however old and bad", () => {
    const losing = { samples: 20, wins: 0, losses: 20 };
    expect(
      decideSoftArchiveRow({
        vectorId: "a", docType: "coach-note", firstSeenAt: daysAgo(400), nowMs: NOW, stat: losing
      }).decision
    ).toBe("keep");
    expect(
      decideSoftArchiveRow({
        vectorId: "a", docType: "lesson", firstSeenAt: daysAgo(400), nowMs: NOW, stat: losing
      }).keepReason
    ).toBe("type-exempt");
  });

  it("never archives young docs", () => {
    expect(
      decideSoftArchiveRow({
        vectorId: "a", docType: "experience", firstSeenAt: daysAgo(10), nowMs: NOW,
        stat: { samples: 10, wins: 0, losses: 10 }
      }).keepReason
    ).toBe("young");
  });

  it("never archives docs without credited evidence (neutral importance 50)", () => {
    const decided = decideSoftArchiveRow({
      vectorId: "a", docType: "experience", firstSeenAt: daysAgo(300), nowMs: NOW
    });
    expect(decided.keepReason).toBe("no-credited-evidence");
    expect(decided.importance).toBe(50);
  });

  it("keeps losing docs that are under the credited-sample floor", () => {
    const decided = decideSoftArchiveRow({
      vectorId: "a", docType: "experience", firstSeenAt: daysAgo(300), nowMs: NOW,
      stat: { samples: SOFT_ARCHIVE_MIN_SAMPLES - 1, wins: 0, losses: SOFT_ARCHIVE_MIN_SAMPLES - 1 }
    });
    expect(decided.keepReason).toBe("no-credited-evidence");
  });

  it("never archives outcome winners", () => {
    const decided = decideSoftArchiveRow({
      vectorId: "a", docType: "experience", firstSeenAt: daysAgo(300), nowMs: NOW,
      stat: { samples: 10, wins: 10, losses: 0 }
    });
    expect(decided.keepReason).toBe("positive-evidence");
  });

  it("archives an aged credited loser past the recency floor", () => {
    const decided = decideSoftArchiveRow({
      vectorId: "a", docType: "experience", firstSeenAt: daysAgo(300), nowMs: NOW,
      stat: { samples: 10, wins: 0, losses: 10 }
    });
    expect(decided.decision).toBe("archive");
    expect(decided.recency).toBeLessThan(0.15);
    expect(decided.blended).toBeLessThan(0.25);
  });

  it("keeps an aged credited loser whose recency is still above the floor (too fresh relative to its half-life)", () => {
    // 100 days of a 45-day half-life: recency ~0.21, above the 0.15 floor.
    const decided = decideSoftArchiveRow({
      vectorId: "a", docType: "experience", firstSeenAt: daysAgo(100), nowMs: NOW,
      stat: { samples: 10, wins: 0, losses: 10 }
    });
    expect(decided.decision).toBe("keep");
    expect(decided.recency).toBeGreaterThanOrEqual(0.15);
  });

  it("treats mildly losing importance above the 25 gate as positive evidence", () => {
    const decided = decideSoftArchiveRow({
      vectorId: "a", docType: "experience", firstSeenAt: daysAgo(300), nowMs: NOW,
      stat: { samples: 10, wins: 3, losses: 7 } // importance 30
    });
    expect(decided.decision).toBe("keep");
  });
});

describe("softArchiveComposite", () => {
  it("keeps the blend under the archive floor only for known losers", () => {
    expect(softArchiveComposite(0, 0.05)).toBeLessThan(0.25);
    expect(softArchiveComposite(100, 0.05)).toBeGreaterThan(0.25);
    expect(softArchiveComposite(50, 0.05)).toBeGreaterThan(0.25);
  });
});