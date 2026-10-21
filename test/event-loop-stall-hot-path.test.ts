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
    await buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 1 });
    resetRoicArtifactFileCountCacheForTests();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    const snapStart = Date.now();
    const snapshot = await buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 1 });
    expect(snapshot.roicArchive?.artifactFiles).toBe(0);
    const snapMs = Date.now() - snapStart;
    const counted = await refreshRoicArtifactFileCount(dataDir);
    clearInterval(timer);
    expect(snapMs).toBeLessThan(100);
    expect(counted).toBe(dirs);
    expect(ticks).toBeGreaterThan(0);
  });

  it("pruneTaskJournal is a retention no-op that never deletes an aged row", async () => {
    // Jay's policy (2026-10-15) keeps task journal rows forever, so
    // pruneTaskJournal() returns 0 without issuing a DELETE.  This test used
    // to insert 2,000,000 rows and assert that the no-op stayed under 100ms
    // while a full unindexed scan of the same rows did not.
    //
    // That shape could not fail: a function that returns a constant reads
    // nothing, so the wall-clock half of the assertion was decided by the
    // machine and not by the code.  It cost about 60 seconds of inserts to
    // say so, and the 60s vitest timeout fired on PR #4720 and on PR #4701 —
    // neither of which has this file in its diff — and again on unrelated
    // branches whenever the host was loaded.  A required gate reddening on an
    // unrelated pull request is the failure mode this file has been causing.
    //
    // The serving-thread stall of 2026-10-05 that this file was written for
    // came from the DELETE that the retention policy removed, so the
    // wall-clock half of the guard has no subject left.  The invariant that
    // still holds, and can still fail, is that the hook never deletes — not
    // even a row that the old 24h skipped-row policy would have aged out.
    // That is what is asserted here, on a thousand aged rows, in
    // milliseconds.
    //
    // The rest of the guard lives where it belongs: the source-level
    // no-DELETE check is in test/forever-retention-no-age-delete.test.ts,
    // the keep-all-rows contract is in test/task-journal.test.ts, and the
    // scheduler still calling the hook is in
    // test/scheduler-tick-reentrancy.test.ts.
    const { getDb, pruneTaskJournal } = await import("../src/lib/db");
    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO task_journal (id, task_name, status, started_at) VALUES (?, 'stall-probe', 'skipped', ?)"
    );
    const aged = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    let n = 0;
    db.transaction(() => {
      for (let i = 0; i < 1_000; i += 1) {
        insert.run(`stall-${n}`, aged);
        n += 1;
      }
    })();
    const before = db.prepare("SELECT COUNT(*) AS c FROM task_journal").get() as { c: number };
    expect(pruneTaskJournal()).toBe(0);
    const after = db.prepare("SELECT COUNT(*) AS c FROM task_journal").get() as { c: number };
    expect(after.c).toBe(before.c);
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
