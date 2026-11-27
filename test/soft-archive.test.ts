// OD-7 weekly soft-archive: pure classification of lifecycle rows and the capped blend the
// sweep feeds shouldSoftArchive, plus one real-temp-DB pass pinning the per-document
// evidence source (Kody 4702694243) and the archived receipt bucket (Kody 4702694573).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decideSoftArchiveRow,
  planSoftArchiveForUser,
  SOFT_ARCHIVE_MIN_SAMPLES,
  softArchiveComposite
} from "../src/lib/soft-archive";

beforeAll(() => {
  const runId = randomUUID();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-soft-archive-${runId}.db`)}`;
  process.env.DATA_DIR = join(tmpdir(), `agentic-soft-archive-data-${runId}`);
});

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
describe("planSoftArchiveForUser (temp SQLite; Kody 4702694243 + 4702694573)", () => {
  it("grades each doc on its OWN credited rows and counts archived rows in their own bucket", async () => {
    const { getDb } = await import("../src/lib/db");
    const { planSoftArchiveForUser } = await import("../src/lib/soft-archive");

    const db = getDb();
    const userId = "local";
    const nowIso = new Date(NOW).toISOString();
    const insertLifecycle = db.prepare(`
      INSERT INTO vector_doc_lifecycle
        (user_id, vector_id, doc_type, first_seen_at, last_retrieved_at, retrieval_count, archived_at, updated_at)
      VALUES (?, ?, 'experience', ?, NULL, 0, NULL, ?)
    `);
    insertLifecycle.run(userId, "loser-doc", daysAgo(300), nowIso);
    insertLifecycle.run(userId, "winner-doc", daysAgo(300), nowIso);
    insertLifecycle.run(userId, "young-doc", daysAgo(10), nowIso);

    const insertStat = db.prepare(`
      INSERT INTO retrieval_usefulness_stats
        (user_id, doc_type, memory_kind, doc_id, horizon, samples, wins, losses, return_pct_sum, updated_at)
      VALUES (?, 'experience', 'context', ?, 'headline', ?, ?, ?, 0, ?)
    `);
    // Per-document evidence: the loser's OWN rows are all losses, the winner's OWN rows are
    // all wins. The KIND-LEVEL row (doc_id '') is a loser on purpose: if kind aggregates
    // leaked into per-document decisions, winner-doc would be archived too (Kody 4702694243).
    insertStat.run(userId, "loser-doc", 10, 0, 10, nowIso);
    insertStat.run(userId, "winner-doc", 10, 10, 0, nowIso);
    insertStat.run(userId, "", 10, 0, 10, nowIso);

    const plan = planSoftArchiveForUser(userId, NOW);
    expect(plan.archiveIds).toEqual(["loser-doc"]);
    expect(plan.counts.archived).toBe(1);
    expect(plan.counts["positive-evidence"]).toBe(1);
    expect(plan.counts.young).toBe(1);
    expect(plan.counts["no-credited-evidence"]).toBe(0);
    expect(plan.scanned).toBe(3);
  });
});
