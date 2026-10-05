import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dataDir = join(tmpdir(), `agentic-stall-data-${randomUUID()}`);

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-stall-${randomUUID()}.db`)}`;
  process.env.DATA_DIR = dataDir;
});

function elapsed(fn: () => void): number {
  const started = Date.now();
  fn();
  return Date.now() - started;
}

describe("serving-thread sqlite stalls mapped from 2026-10-05 profiles", () => {
  it("ops snapshot does not synchronously walk the ROIC artifact tree", async () => {
    const root = join(dataDir, "corpus", "roic");
    let dirs = 0;
    const addDirs = (count: number) => {
      for (let i = 0; i < count; i += 1) {
        const dir = join(root, `S${dirs}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "2024Q1.json"), "{}");
        dirs += 1;
      }
    };
    const { countRoicTranscriptArtifactFiles, refreshRoicArtifactFileCount, resetRoicArtifactFileCountCacheForTests } =
      await import("../src/lib/roic-archive-artifacts");
    resetRoicArtifactFileCountCacheForTests();
    let syncMs = 0;
    let batch = 400;
    while (syncMs < 100 && dirs < 20_000) {
      addDirs(batch);
      syncMs = elapsed(() => {
        countRoicTranscriptArtifactFiles(dataDir);
      });
      batch = Math.min(batch * 2, 4_000);
    }
    expect(syncMs).toBeGreaterThanOrEqual(100);
    const { getDb } = await import("../src/lib/db");
    getDb();
    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 1 });
    resetRoicArtifactFileCountCacheForTests();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    const snapMs = elapsed(() => {
      const snapshot = buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 1 });
      expect(snapshot.roicArchive?.artifactFiles).toBe(0);
    });
    const counted = await refreshRoicArtifactFileCount(dataDir);
    clearInterval(timer);
    expect(snapMs).toBeLessThan(100);
    expect(counted).toBe(dirs);
    expect(ticks).toBeGreaterThan(0);
  });

  it("pruneTaskJournal stays under 100ms when a full scan of the same rows does not", async () => {
    const { getDb, pruneTaskJournal } = await import("../src/lib/db");
    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO task_journal (id, task_name, status, started_at) VALUES (?, 'stall-probe', 'skipped', ?)"
    );
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    let n = 0;
    const add = (count: number, startedAt: string) => {
      db.transaction(() => {
        for (let i = 0; i < count; i += 1) {
          insert.run(`stall-${n}`, startedAt);
          n += 1;
        }
      })();
    };
    add(3, old);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const scan = db.prepare(
      "SELECT COUNT(*) AS c FROM task_journal NOT INDEXED WHERE status = 'skipped' AND started_at < ?"
    );
    let scanMs = 0;
    let batch = 50_000;
    // Hosted CI can report 99ms on the last growth step; keep adding until the
    // unindexed scan clearly crosses the 100ms stall threshold or we hit a row cap.
    while (scanMs < 100 && n < 4_000_000) {
      add(batch, recent);
      scanMs = elapsed(() => {
        scan.get(cutoff);
      });
      batch = Math.min(batch * 2, 400_000);
    }
    if (scanMs < 100 && n < 4_000_000) {
      add(200_000, recent);
      scanMs = elapsed(() => {
        scan.get(cutoff);
      });
    }
    expect(scanMs).toBeGreaterThanOrEqual(100);
    const pruned = { n: 0 };
    const pruneMs = elapsed(() => {
      pruned.n = pruneTaskJournal();
    });
    expect(pruned.n).toBe(3);
    expect(pruneMs).toBeLessThan(100);
    expect(pruneMs * 4).toBeLessThan(scanMs);
  });

  it("transcript coverage does not read every content blob", async () => {
    const { getDb, summarizeEarningsCallsTranscriptCoverage } = await import("../src/lib/db");
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO earningscalls_transcripts
         (symbol, fiscal_year, fiscal_quarter, content, fetched_at)
       VALUES (?, 2024, 1, ?, '2024-01-01T00:00:00.000Z')`
    );
    const blob = "x".repeat(1_000_000);
    let rows = 0;
    const add = (count: number) => {
      db.transaction(() => {
        for (let i = 0; i < count; i += 1) {
          insert.run(`STALL${rows}`, blob);
          rows += 1;
        }
      })();
    };
    const lengthQuery = db.prepare(
      `SELECT symbol, COUNT(*) AS count FROM earningscalls_transcripts
       WHERE content IS NOT NULL AND length(content) >= 200
       GROUP BY symbol`
    );
    let slowMs = 0;
    let batch = 8;
    while (slowMs < 100 && rows < 512) {
      add(batch);
      slowMs = elapsed(() => {
        lengthQuery.all();
      });
      batch = Math.min(batch * 2, 64);
    }
    if (slowMs < 100 && rows < 512) {
      add(32);
      slowMs = elapsed(() => {
        lengthQuery.all();
      });
    }
    expect(slowMs).toBeGreaterThanOrEqual(100);
    const fastMs = elapsed(() => {
      const coverage = summarizeEarningsCallsTranscriptCoverage(20);
      expect(coverage.transcriptsWithContent).toBe(rows);
    });
    expect(fastMs).toBeLessThan(100);
    expect(fastMs * 4).toBeLessThan(slowMs);
  });

});
