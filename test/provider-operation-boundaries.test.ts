import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getInternalSetting, deleteInternalSetting } from "../src/lib/db";
import { runCongressDailyShare } from "../src/lib/congress-share";
import {
  getOperationLeaseBusy,
  OPERATION_LEASE_GROUPS,
  resetOperationLeaseForTest,
  runWithOperationLease,
  type OperationLeaseGroup
} from "../src/lib/operation-lease";
import { refreshCongress } from "../src/lib/web-sources/congress";
import { refreshFilingBodies } from "../src/lib/web-sources/sec-filings";
import { refreshEightK, reindexEightKDataset } from "../src/lib/web-sources/sec8k";

const databaseFile = join(tmpdir(), `agentic-provider-boundaries-${randomUUID()}.db`);

beforeAll(() => {
  process.env.DATABASE_URL = `file:${databaseFile}`;
});

beforeEach(() => {
  resetOperationLeaseForTest();
  deleteInternalSetting("webSource:sec10k:lastAttempt");
  deleteInternalSetting("webSource:congress:lastAttempt");
  deleteInternalSetting("webSource:sec8k:lastAttempt");
  deleteInternalSetting("congress-share:lastDailyRunDate");
  process.env.CONGRESS_TRADE_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONGRESS_TRADE_TOKEN;
  resetOperationLeaseForTest();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function hold(group: OperationLeaseGroup, operation: string) {
  const entered = deferred();
  const release = deferred();
  const holder = runWithOperationLease({ group, operation }, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return { holder, release };
}

describe("provider/dataset operation boundaries", () => {
  it("unifies scheduled filing ingest with both manual RAG reindex paths", async () => {
    const active = await hold(OPERATION_LEASE_GROUPS.RAG_REINDEX, "scheduled-filing-ingest");

    const filing = await refreshFilingBodies(["AAPL"], Date.now(), undefined, { force: true });
    expect(getOperationLeaseBusy(filing)).toMatchObject({ activeOperation: "scheduled-filing-ingest" });
    expect(filing).toMatchObject({ attempted: 0, ingested: 0, errors: [] });
    expect(getInternalSetting("webSource:sec10k:lastAttempt")).toBeUndefined();

    const eightK = await reindexEightKDataset("local");
    expect(getOperationLeaseBusy(eightK)).toMatchObject({ activeOperation: "scheduled-filing-ingest" });
    expect(eightK).toMatchObject({ attempted: 0, indexed: 0, skipped: true });

    active.release.resolve();
    await active.holder;
  });

  it("makes a scheduler-versus-manual Congress share collision a benign skip without marker or network work", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const active = await hold(OPERATION_LEASE_GROUPS.CONGRESS_SHARE, "nightly-congress-share");

    const result = await runCongressDailyShare({ force: true, symbols: ["AAPL"] });
    expect(getOperationLeaseBusy(result)).toMatchObject({ activeOperation: "nightly-congress-share" });
    expect(result).toMatchObject({ ok: true, skipped: true, reason: "operation-in-flight", posts: 0 });
    expect(getInternalSetting("congress-share:lastDailyRunDate")).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();

    active.release.resolve();
    await active.holder;
  });

  it("keeps Congress and SEC 8-K refresh collisions dataset-local and advances no attempt marker", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const congressActive = await hold(OPERATION_LEASE_GROUPS.CONGRESS_WEB_SOURCE, "scheduled-congress-refresh");

    const congress = await refreshCongress(Date.now(), true);
    expect(getOperationLeaseBusy(congress)).toMatchObject({ activeOperation: "scheduled-congress-refresh" });
    expect(congress).toMatchObject({ id: "congress", ok: true, skipped: true });
    expect(getInternalSetting("webSource:congress:lastAttempt")).toBeUndefined();

    // A different dataset group is not blocked by the Congress holder. Hold SEC 8-K separately so
    // its direct caller proves the same benign/no-marker behavior without making a network request.
    const sec8kActive = await hold(OPERATION_LEASE_GROUPS.SEC8K_WEB_SOURCE, "scheduled-sec8k-refresh");
    const sec8k = await refreshEightK(Date.now(), true);
    expect(getOperationLeaseBusy(sec8k)).toMatchObject({ activeOperation: "scheduled-sec8k-refresh" });
    expect(sec8k).toMatchObject({ id: "sec8k", ok: true, skipped: true });
    expect(getInternalSetting("webSource:sec8k:lastAttempt")).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();

    congressActive.release.resolve();
    sec8kActive.release.resolve();
    await Promise.all([congressActive.holder, sec8kActive.holder]);
  });

  it("rechecks cadence after cross-connection lease wait so a just-completed refresh is not repeated", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const now = Date.now();
    const require = createRequire(import.meta.url);
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.betterSqlitePath);
      const db = new Database(workerData.databaseFile);
      // App connections install these deterministic trigger functions in getDb(). This raw worker
      // exists only to hold an independent SQLite writer lock, so register inert equivalents for
      // the unrelated global cadence setting it writes.
      db.function("account_subject_token", (value) => String(value ?? ""));
      db.function("account_setting_matches_subject", (_key, _token) => 0);
      db.pragma("busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      setTimeout(() => {
        const timestamp = new Date(workerData.now).toISOString();
        db.prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).run("webSource:congress:lastAttempt", JSON.stringify(timestamp), timestamp);
        db.exec("COMMIT");
        db.close();
        parentPort.postMessage("done");
      }, 50);
    `, {
      eval: true,
      workerData: {
        betterSqlitePath: require.resolve("better-sqlite3"),
        databaseFile,
        now
      }
    });
    const workerExit = once(worker, "exit");
    await once(worker, "message"); // writer lock acquired; our BEGIN IMMEDIATE must wait

    const result = await refreshCongress(now, false);
    expect(result).toMatchObject({ id: "congress", ok: true, skipped: true });
    expect(getOperationLeaseBusy(result)).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();

    await workerExit;
  });
});
