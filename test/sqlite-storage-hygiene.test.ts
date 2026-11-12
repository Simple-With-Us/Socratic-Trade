import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";

const dbPath = join(tmpdir(), `agentic-sqlite-hygiene-${randomUUID()}.db`);

beforeAll(() => {
  process.env.DATABASE_URL = `file:${dbPath}`;
  delete process.env.SQLITE_STORAGE_HYGIENE_DRY_RUN;
  delete process.env.SQLITE_STORAGE_HYGIENE_DISABLED;
});

const NOW = new Date("2026-10-14T16:00:00.000Z");

function isoDaysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function dayBefore(days: number): string {
  return isoDaysBefore(days).slice(0, 10);
}

type Db = import("better-sqlite3").Database;

function count(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
  return row.n;
}

function clearHygieneRows(db: Db): void {
  for (const table of [
    "strategy_runs",
    "strategy_run_requests",
    "task_journal",
    "history_cache_eod",
    "symbol_field_latest",
    "embed_stage",
    "api_health_log",
    "enrichment_coverage_fields",
    "enrichment_coverage_runs",
    "fill_events",
    "trade_proposals",
    "order_replacements",
    "portfolio_snapshots",
    "llm_usage",
    "audit_events",
    "sec_ingest_task_attempts",
    "sec_ingest_tasks",
    "sec_ingest_jobs"
  ]) {
    db.prepare(`DELETE FROM "${table}"`).run();
  }
  db.prepare("DELETE FROM settings WHERE key = ? OR key LIKE 'storage-hygiene:%' OR key LIKE 'risk:hwm:%'").run(
    "storage-hygiene:lastReport"
  );
}

describe("storage hygiene decisions", () => {
  it("refuses row deletes from storage hygiene and has no retention targets", async () => {
    const hygiene = await import("../src/lib/sqlite-storage-hygiene");
    expect(hygiene.RETENTION_TARGETS).toEqual([]);
    expect(() => hygiene.assertPruneTableAllowed("fill_events")).toThrow(/money-path/);
    expect(() => hygiene.assertPruneTableAllowed("settings")).toThrow(/money-path/);
    expect(() => hygiene.assertPruneTableAllowed("portfolio_snapshots")).toThrow(/money-path/);
    expect(() => hygiene.assertPruneTableAllowed("history_cache_eod")).toThrow(/market-data history/);
    expect(() => hygiene.assertPruneTableAllowed("enrichment_coverage_runs")).toThrow(/does not delete rows/);
    expect(() => hygiene.assertPruneTableAllowed("strategy_runs")).toThrow(/does not delete rows/);
    expect(() => hygiene.assertPruneTableAllowed("llm_usage")).toThrow(/does not delete rows/);
  });

  it("does not contain age-based DELETE SQL in the hygiene module", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/sqlite-storage-hygiene.ts"), "utf8");
    expect(source).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(source).not.toMatch(/RETENTION_DAYS\s*=/);
    expect(source).not.toMatch(/function isoCutoff/);
    expect(source).not.toMatch(/RETENTION_TARGETS:\s*readonly\s+RetentionTarget/);
  });

  it("bounds ANALYZE work with analysis_limit before optimize", async () => {
    const hygiene = await import("../src/lib/sqlite-storage-hygiene");
    expect(hygiene.STORAGE_HYGIENE_ANALYZE_PAGE_LIMIT).toBeGreaterThan(0);
    const source = readFileSync(join(process.cwd(), "src/lib/sqlite-storage-hygiene.ts"), "utf8");
    expect(source).toMatch(/analysis_limit=\$\{STORAGE_HYGIENE_ANALYZE_PAGE_LIMIT\}/);
    expect(source).toMatch(/db\.exec\("ANALYZE"\)/);
  });

  it("never prunes market-data history tables by age", async () => {
    const hygiene = await import("../src/lib/sqlite-storage-hygiene");
    for (const table of hygiene.MARKET_DATA_HISTORY_TABLES) {
      expect(() => hygiene.assertPruneTableAllowed(table)).toThrow(/market-data history/);
    }
    expect(() => hygiene.assertPruneTableAllowed("document_chunks_fts")).toThrow(/market-data history/);
    expect(() => hygiene.assertPruneTableAllowed("document_chunks_fts_data")).toThrow(/market-data history/);
    expect(hygiene.isMarketDataHistoryTable("history_cache_eod")).toBe(true);
    expect(hygiene.isMarketDataHistoryTable("strategy_runs")).toBe(false);
  });

  it("does not issue a full file rewrite", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/sqlite-storage-hygiene.ts"), "utf8");
    expect(source).not.toMatch(/\bVACUUM\b/);
    expect(source).toContain("incremental_vacuum");
  });

  it("classifies litestream age and truncate safety", async () => {
    const {
      LITESTREAM_MAX_LAG_SECONDS,
      WAL_TRUNCATE_MIN_BYTES,
      classifyLitestreamAge,
      decideWalTruncate
    } = await import("../src/lib/sqlite-storage-hygiene");
    expect(classifyLitestreamAge(null, true)).toBe("uncertain");
    expect(classifyLitestreamAge(null, false)).toBe("absent");
    expect(classifyLitestreamAge(LITESTREAM_MAX_LAG_SECONDS, false)).toBe("fresh");
    expect(classifyLitestreamAge(LITESTREAM_MAX_LAG_SECONDS + 1, false)).toBe("stale");

    const ready = {
      dryRun: false,
      passiveBusy: 0,
      passiveLog: 12,
      passiveCheckpointed: 12,
      walBytes: WAL_TRUNCATE_MIN_BYTES,
      litestream: "fresh" as const
    };
    expect(decideWalTruncate(ready).truncate).toBe(true);
    expect(decideWalTruncate({ ...ready, litestream: "absent" }).truncate).toBe(true);
    expect(decideWalTruncate({ ...ready, dryRun: true }).truncate).toBe(false);
    expect(decideWalTruncate({ ...ready, passiveBusy: 1 }).truncate).toBe(false);
    expect(decideWalTruncate({ ...ready, passiveCheckpointed: 11 }).truncate).toBe(false);
    expect(decideWalTruncate({ ...ready, walBytes: WAL_TRUNCATE_MIN_BYTES - 1 }).truncate).toBe(false);
    expect(decideWalTruncate({ ...ready, litestream: "stale" }).truncate).toBe(false);
    expect(decideWalTruncate({ ...ready, litestream: "uncertain" }).truncate).toBe(false);
  });

  it("caps incremental free-page reclaim and refuses a rewrite", async () => {
    const { INCREMENTAL_VACUUM_PAGE_CAP, decideIncrementalVacuum, incrementalVacuumPragma } = await import(
      "../src/lib/sqlite-storage-hygiene"
    );
    expect(incrementalVacuumPragma(1)).toBe("incremental_vacuum(1)");
    expect(incrementalVacuumPragma(INCREMENTAL_VACUUM_PAGE_CAP)).toBe(
      `incremental_vacuum(${INCREMENTAL_VACUUM_PAGE_CAP})`
    );
    expect(() => incrementalVacuumPragma(0)).toThrow(/1 to 128/);
    expect(() => incrementalVacuumPragma(INCREMENTAL_VACUUM_PAGE_CAP + 1)).toThrow(/1 to 128/);
    expect(() => incrementalVacuumPragma(1.5)).toThrow(/1 to 128/);
    expect(decideIncrementalVacuum({ dryRun: true, autoVacuum: 2, freelistCount: 40 }).run).toBe(false);
    expect(decideIncrementalVacuum({ dryRun: false, autoVacuum: 0, freelistCount: 40 }).run).toBe(false);
    expect(decideIncrementalVacuum({ dryRun: false, autoVacuum: 2, freelistCount: 0 }).run).toBe(false);
    const capped = decideIncrementalVacuum({ dryRun: false, autoVacuum: 2, freelistCount: 500 });
    expect(capped).toEqual({ run: true, pages: INCREMENTAL_VACUUM_PAGE_CAP, reason: expect.stringContaining("128") });
    expect(decideIncrementalVacuum({ dryRun: false, autoVacuum: 2, freelistCount: 9 }).pages).toBe(9);
  });

  it("treats an exhausted litestream walk as uncertain", async () => {
    const { readLitestreamReplicaAge } = await import("../src/lib/sqlite-storage-hygiene");
    const root = join(tmpdir(), `agentic-lss-${randomUUID()}`);
    const dbFile = join(root, "app.db");
    mkdirSync(join(dbFile + "-litestream", "gen"), { recursive: true });
    const replica = join(dbFile + "-litestream", "gen", "00000001.wal");
    writeFileSync(replica, "x");
    const recent = new Date();
    utimesSync(replica, recent, recent);
    const fresh = readLitestreamReplicaAge(dbFile, recent.getTime() + 5_000);
    expect(fresh.uncertain).toBe(false);
    expect(fresh.ageSeconds).toBeLessThanOrEqual(5);

    const huge = join(tmpdir(), `agentic-lss-huge-${randomUUID()}.db`);
    let dir = huge + "-litestream";
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 90; i += 1) {
      dir = join(dir, `d${i}`);
      mkdirSync(dir, { recursive: true });
    }
    const unseen = readLitestreamReplicaAge(huge, Date.now());
    expect(unseen.uncertain).toBe(true);
    expect(unseen.ageSeconds).toBeNull();
    expect(readLitestreamReplicaAge(join(tmpdir(), `missing-${randomUUID()}.db`))).toEqual({
      ageSeconds: null,
      uncertain: false
    });

    const wideRoot = join(tmpdir(), `agentic-lss-wide-${randomUUID()}`);
    const wideDb = join(wideRoot, "app.db");
    const level0 = join(wideDb + "-litestream", "ltx", "0");
    const level1 = join(wideDb + "-litestream", "ltx", "1");
    mkdirSync(level0, { recursive: true });
    mkdirSync(level1, { recursive: true });
    const old = new Date(Date.now() - 86_400_000);
    for (let i = 0; i < 100; i += 1) {
      const file = join(level0, `0000000000000000-${i.toString(16).padStart(16, "0")}.ltx`);
      writeFileSync(file, "x");
      utimesSync(file, old, old);
    }
    const levelRecent = new Date();
    const recentFile = join(level0, `0000000000000000-${(200).toString(16).padStart(16, "0")}.ltx`);
    writeFileSync(recentFile, "x");
    utimesSync(recentFile, levelRecent, levelRecent);
    const newestStamp = new Date(levelRecent.getTime() + 5_000);
    const newestFile = join(level1, "0000000000000000-ffffffffffffffff.ltx");
    writeFileSync(newestFile, "x");
    utimesSync(newestFile, newestStamp, newestStamp);
    const wide = readLitestreamReplicaAge(wideDb, newestStamp.getTime() + 1_000);
    expect(wide.uncertain).toBe(false);
    expect(wide.ageSeconds).toBeLessThanOrEqual(2);
  });
});

describe("storage hygiene against a database", () => {
  async function open() {
    const dbMod = await import("../src/lib/db");
    const hygiene = await import("../src/lib/sqlite-storage-hygiene");
    const db = dbMod.getDb();
    return { db, dbMod, hygiene };
  }

  it("dry-run deletes nothing and the ops snapshot reads the cache", async () => {
    const { db, hygiene } = await open();
    clearHygieneRows(db);
    const old = isoDaysBefore(30);
    db.prepare("INSERT INTO api_health_log (id, service, ts, ok, error_text) VALUES (?, 'yahoo', ?, 0, ?)").run(
      "health-old",
      old,
      "x".repeat(4000)
    );
    db.prepare("INSERT INTO api_health_log (id, service, ts, ok, error_text) VALUES (?, 'yahoo', ?, 1, NULL)").run(
      "health-new",
      isoDaysBefore(1)
    );
    const before = count(db, "api_health_log");
    const report = await hygiene.runStorageHygiene({ now: NOW, dryRun: true, skipSizeWalk: false });
    expect(report.dryRun).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.deletedRows).toBe(0);
    expect(report.expectedReclaimBytes).toBe(0);
    expect(report.expectedFileShrinkBytes).toBe(0);
    expect(report.checkpoint.passive).toBeNull();
    expect(report.checkpoint.truncateRan).toBe(false);
    expect(count(db, "api_health_log")).toBe(before);
    expect(report.estimates).toEqual([]);
    const fills = report.tables.find((row) => row.name === "fill_events");
    expect(fills?.prunable).toBe(false);
    expect(fills?.retainReason).toBe("money-path record");
    expect(fills?.category).toBe("money_path");
    const usage = report.tables.find((row) => row.name === "llm_usage");
    expect(usage?.prunable).toBe(false);
    expect(usage?.retainReason).toContain("lifetime");
    // Explicit CATEGORY_BY_TABLE entries must survive the market-data-history
    // fallback, and genuinely market-data tables must not be labeled as caches.
    const categoryOf = (name: string) => report.tables.find((row) => row.name === name)?.category;
    expect(categoryOf("document_chunks")).toBe("embeddings");
    expect(categoryOf("history_cache_eod")).toBe("quote_bar_cache");
    expect(categoryOf("symbol_field_latest")).toBe("quote_bar_cache");
    expect(categoryOf("sec_filings")).toBe("market_data_history");
    expect(categoryOf("sec_facts")).toBe("market_data_history");
    expect(categoryOf("historical_fundamentals")).toBe("market_data_history");
    const cached = hygiene.readCachedStorageHygieneReport();
    expect(cached?.generatedAt).toBe(report.generatedAt);
    expect(cached?.estimates).toEqual([]);
    db.prepare("INSERT INTO api_health_log (id, service, ts, ok, error_text) VALUES ('health-extra', 'yahoo', ?, 0, 'more')").run(
      old
    );
    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = await buildOpsSnapshot();
    expect(snapshot.storageHygiene?.generatedAt).toBe(report.generatedAt);
    expect(snapshot.storageHygiene?.estimates).toEqual([]);
    expect(count(db, "api_health_log")).toBe(3);
  });

  it("keeps strategy runs, logs, and caches across a live hygiene pass", async () => {
    const { db, hygiene } = await open();
    clearHygieneRows(db);
    const oldIso = isoDaysBefore(200);
    const midIso = isoDaysBefore(40);
    const newIso = isoDaysBefore(2);

    db.prepare(
      "INSERT INTO strategy_runs (id, started_at, finished_at, status, summary, user_id) VALUES (?, ?, ?, ?, ?, 'local')"
    ).run("run-old", oldIso, oldIso, "completed", "stale summary");
    db.prepare(
      "INSERT INTO strategy_runs (id, started_at, finished_at, status, summary, user_id) VALUES (?, ?, ?, 'completed', 'recent', 'local')"
    ).run("run-new", newIso, newIso);
    db.prepare(
      "INSERT INTO strategy_runs (id, started_at, finished_at, status, summary, user_id) VALUES (?, ?, NULL, 'running', 'live', 'local')"
    ).run("run-live", oldIso);
    db.prepare(
      "INSERT INTO strategy_runs (id, started_at, finished_at, status, summary, user_id) VALUES (?, ?, ?, 'completed', 'filled', 'local')"
    ).run("run-fill", oldIso, oldIso);
    db.prepare(
      "INSERT INTO strategy_runs (id, started_at, finished_at, status, summary, user_id) VALUES (?, ?, ?, 'completed', 'proposed', 'local')"
    ).run("run-proposal", oldIso, oldIso);

    db.prepare(
      `INSERT INTO fill_events (id, run_id, account_number, source, symbol, side, quantity, price, notional, status, filled_at, user_id)
       VALUES ('fill-1', 'run-fill', 'PA', 'test', 'AAPL', 'buy', 1, 10, 10, 'filled', ?, 'local')`
    ).run(oldIso);
    db.prepare(
      `INSERT INTO trade_proposals (id, run_id, account_number, created_at, proposal, decision, status, user_id)
       VALUES ('prop-1', 'run-proposal', 'PA', ?, '{}', '{}', 'pending', 'local')`
    ).run(oldIso);
    db.prepare(
      `INSERT INTO order_replacements
         (id, user_id, account_number, original_order_id, replacement_ref_id, status, created_at, updated_at)
       VALUES ('repl-1', 'local', 'PA', 'ord-1', 'ref-1', 'failed', ?, ?)`
    ).run(oldIso, oldIso);
    db.prepare(
      `INSERT INTO portfolio_snapshots
         (id, account_number, source, equity, cash, buying_power, positions_value, positions, created_at, user_id)
       VALUES ('snap-1', 'PA', 'test', 1, 1, 1, 0, '[]', ?, 'local')`
    ).run(oldIso);
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('risk:hwm:acct', '{\"equity\":10}', ?)").run(oldIso);
    db.prepare(
      `INSERT INTO llm_usage (id, user_id, provider, model, context, key_source, total_tokens, created_at)
       VALUES ('llm-1', 'local', 'openai', 'm', 'green', 'user', 10, ?)`
    ).run(isoDaysBefore(400));

    db.prepare(
      `INSERT INTO strategy_run_requests (id, user_id, status, result, created_at, finished_at)
       VALUES ('req-old', 'local', 'completed', 'done', ?, ?)`
    ).run(midIso, midIso);
    db.prepare(
      `INSERT INTO strategy_run_requests (id, user_id, status, result, created_at, finished_at)
       VALUES ('req-new', 'local', 'completed', 'done', ?, ?)`
    ).run(newIso, newIso);
    db.prepare(
      `INSERT INTO strategy_run_requests (id, user_id, status, result, created_at, finished_at)
       VALUES ('req-queued', 'local', 'queued', NULL, ?, NULL)`
    ).run(midIso);

    db.prepare("INSERT INTO task_journal (id, task_name, status, started_at, summary) VALUES ('j-skip', 'lane', 'skipped', ?, 's')").run(
      isoDaysBefore(3)
    );
    db.prepare("INSERT INTO task_journal (id, task_name, status, started_at, summary) VALUES ('j-skip-new', 'lane', 'skipped', ?, 's')").run(
      isoDaysBefore(0)
    );
    db.prepare("INSERT INTO task_journal (id, task_name, status, started_at, summary) VALUES ('j-ok', 'lane', 'ok', ?, 's')").run(midIso);
    db.prepare("INSERT INTO task_journal (id, task_name, status, started_at, summary) VALUES ('j-run', 'lane', 'running', ?, 's')").run(
      midIso
    );

    // Durable EOD price history: permanent upserts, no age deletion.  Rows
    // older than the retired 400-day window — including rows older than five
    // years — must survive every hygiene pass.
    db.prepare(
      "INSERT INTO history_cache_eod (ticker, date, close, source, updated_at) VALUES ('AAPL', ?, 1, 'test', ?)"
    ).run(dayBefore(500), oldIso);
    db.prepare(
      "INSERT INTO history_cache_eod (ticker, date, close, source, updated_at) VALUES ('AAPL', ?, 2, 'test', ?)"
    ).run(dayBefore(3), newIso);
    db.prepare(
      "INSERT INTO history_cache_eod (ticker, date, close, source, updated_at) VALUES ('AAPL', ?, 3, 'test', ?)"
    ).run(dayBefore(2200), oldIso);
    db.prepare(
      `INSERT INTO symbol_field_latest (symbol, field, value_json, source, as_of, fetched_at)
       VALUES ('AAPL', 'pe', '1', 'test', ?, ?)`
    ).run(oldIso, oldIso);
    db.prepare(
      `INSERT INTO symbol_field_latest (symbol, field, value_json, source, as_of, fetched_at)
       VALUES ('MSFT', 'pe', '2', 'test', ?, ?)`
    ).run(newIso, newIso);

    db.prepare(
      `INSERT INTO embed_stage (content_hash, model, revision, dims, vector, created_at)
       VALUES ('old-hash', 'm', 'r', 1, ?, ?)`
    ).run(Buffer.from([1, 2, 3, 4]), isoDaysBefore(50));
    // ST-4540: this row carries a durable delivery receipt (vector is already in the store).
    // The hygiene lane must still not touch it — embed_stage clears ONLY via
    // deleteStagedEmbeddings after delivery, never by calendar retention.
    db.prepare(
      `INSERT INTO embed_stage (content_hash, model, revision, dims, vector, created_at, delivered_at, delivered_store)
       VALUES ('old-delivered', 'm', 'r', 1, ?, ?, ?, 'pinecone')`
    ).run(Buffer.from([1, 2, 3, 4]), isoDaysBefore(50), isoDaysBefore(49));
    db.prepare(
      `INSERT INTO embed_stage (content_hash, model, revision, dims, vector, created_at)
       VALUES ('new-hash', 'm', 'r', 1, ?, ?)`
    ).run(Buffer.from([1, 2, 3, 4]), newIso);

    db.prepare("INSERT INTO api_health_log (id, service, ts, ok, error_text) VALUES ('h-old', 'yahoo', ?, 0, 'stale')").run(
      isoDaysBefore(20)
    );
    db.prepare("INSERT INTO api_health_log (id, service, ts, ok, error_text) VALUES ('h-new', 'yahoo', ?, 1, NULL)").run(newIso);

    db.prepare(
      `INSERT INTO sec_ingest_jobs (id, idempotency_key, corpus_revision, status, created_at, updated_at)
       VALUES ('job-1', 'idem-1', 'rev', 'complete', ?, ?)`
    ).run(oldIso, oldIso);
    db.prepare(
      `INSERT INTO sec_ingest_tasks
         (id, job_id, task_key, accession, checkpoint, status, verification_json, created_at, updated_at)
       VALUES ('task-done', 'job-1', 'k1', 'acc-1', 'complete', 'complete', '{}', ?, ?)`
    ).run(oldIso, oldIso);
    db.prepare(
      `INSERT INTO sec_ingest_tasks
         (id, job_id, task_key, accession, checkpoint, status, created_at, updated_at)
       VALUES ('task-pend', 'job-1', 'k2', 'acc-2', 'discovered', 'pending', ?, ?)`
    ).run(oldIso, oldIso);
    db.prepare(
      `INSERT INTO sec_ingest_task_attempts
         (task_id, attempt_no, checkpoint, lease_owner, lease_token, started_at, heartbeat_at, outcome, receipt_json)
       VALUES ('task-done', 1, 'complete', 'w', 'tok-old', ?, ?, 'advanced', '{"ok":true}')`
    ).run(isoDaysBefore(30), isoDaysBefore(30));
    db.prepare(
      `INSERT INTO sec_ingest_task_attempts
         (task_id, attempt_no, checkpoint, lease_owner, lease_token, started_at, heartbeat_at, outcome)
       VALUES ('task-done', 2, 'complete', 'w', 'tok-new', ?, ?, 'advanced')`
    ).run(newIso, newIso);
    db.prepare(
      `INSERT INTO sec_ingest_task_attempts
         (task_id, attempt_no, checkpoint, lease_owner, lease_token, started_at, heartbeat_at, outcome)
       VALUES ('task-pend', 1, 'discovered', 'w', 'tok-pend', ?, ?, 'claimed')`
    ).run(isoDaysBefore(30), isoDaysBefore(30));

    for (let i = 0; i < 32; i += 1) {
      const created = new Date(NOW.getTime() - (200 - i) * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(
        "INSERT INTO enrichment_coverage_runs (as_of, symbol_count, report_json, created_at) VALUES (?, 1, ?, ?)"
      ).run(`cov-${i}`, `{"i":${i}}`, created);
    }
    db.prepare(
      `INSERT INTO enrichment_coverage_fields
         (as_of, field, filled_count, total_symbols, fill_rate, winning_sources_json, missing_symbols_json)
       VALUES ('cov-0', 'pe', 1, 1, 1, '[]', '[]')`
    ).run();
    db.prepare(
      `INSERT INTO enrichment_coverage_fields
         (as_of, field, filled_count, total_symbols, fill_rate, winning_sources_json, missing_symbols_json)
       VALUES ('cov-31', 'pe', 1, 1, 1, '[]', '[]')`
    ).run();

    const report = await hygiene.runStorageHygiene({
      now: NOW,
      dryRun: false,
      skipSizeWalk: true,
      litestreamAgeSeconds: null,
      checkpoint: () => ({ busy: 0, log: 0, checkpointed: 0 })
    });
    expect(report.errors).toEqual([]);
    expect(report.dryRun).toBe(false);
    expect(report.deletedRows).toBe(0);
    expect(report.expectedReclaimBytes).toBe(0);
    expect(report.checkpoint.truncateRan).toBe(false);

    const runIds = (db.prepare("SELECT id FROM strategy_runs ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
    expect(runIds).toEqual(["run-fill", "run-live", "run-new", "run-old", "run-proposal"]);
    expect(count(db, "fill_events")).toBe(1);
    expect(count(db, "trade_proposals")).toBe(1);
    expect(count(db, "order_replacements")).toBe(1);
    expect(count(db, "portfolio_snapshots")).toBe(1);
    expect(count(db, "llm_usage")).toBe(1);
    const hwm = db.prepare("SELECT value FROM settings WHERE key = 'risk:hwm:acct'").get() as { value: string };
    expect(hwm.value).toContain("equity");

    const requests = (db.prepare("SELECT id FROM strategy_run_requests ORDER BY id").all() as Array<{ id: string }>).map(
      (row) => row.id
    );
    expect(requests).toEqual(["req-new", "req-old", "req-queued"]);
    const journal = (db.prepare("SELECT id FROM task_journal ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
    expect(journal).toEqual(["j-ok", "j-run", "j-skip", "j-skip-new"]);
    expect(
      (db.prepare("SELECT date FROM history_cache_eod ORDER BY date").all() as Array<{ date: string }>).map(
        (row) => row.date
      )
    ).toEqual([dayBefore(2200), dayBefore(500), dayBefore(3)]);
    expect(report.estimates.some((row) => row.table === "history_cache_eod")).toBe(false);
    expect(
      (db.prepare("SELECT symbol FROM symbol_field_latest ORDER BY symbol").all() as Array<{ symbol: string }>).map(
        (row) => row.symbol
      )
    ).toEqual(["AAPL", "MSFT"]);
    expect(
      (db.prepare("SELECT content_hash FROM embed_stage ORDER BY content_hash").all() as Array<{ content_hash: string }>).map(
        (row) => row.content_hash
      )
    ).toEqual(["new-hash", "old-delivered", "old-hash"]);
    expect((db.prepare("SELECT id FROM api_health_log ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id)).toEqual([
      "h-new",
      "h-old"
    ]);
    const attempts = (
      db.prepare("SELECT task_id, attempt_no FROM sec_ingest_task_attempts ORDER BY task_id, attempt_no").all() as Array<{
        task_id: string;
        attempt_no: number;
      }>
    ).map((row) => `${row.task_id}:${row.attempt_no}`);
    expect(attempts).toEqual(["task-done:1", "task-done:2", "task-pend:1"]);
    expect(count(db, "enrichment_coverage_runs")).toBe(32);
    expect(count(db, "enrichment_coverage_fields")).toBe(2);
  });

  it("preserves durable EOD history older than five years across hygiene passes", async () => {
    const { db, hygiene } = await open();
    clearHygieneRows(db);
    // Regression for the #4666/#4661 retention conflict: hygiene once deleted
    // history_cache_eod rows older than 400 days while the deep-history design
    // promises permanent upserts and a ~5y (1825d) lookback.  Every age below —
    // including 6y+ — must survive, and the report must carry no history estimate.
    const ancient = dayBefore(2300);
    const fiveYears = dayBefore(1825);
    const justOld = dayBefore(401);
    const fresh = dayBefore(3);
    const stamp = isoDaysBefore(10);
    for (const [ticker, date, close] of [
      ["AAPL", ancient, 1],
      ["AAPL", fiveYears, 2],
      ["AAPL", justOld, 3],
      ["AAPL", fresh, 4],
      ["MSFT", ancient, 5]
    ] as Array<[string, string, number]>) {
      db.prepare(
        "INSERT INTO history_cache_eod (ticker, date, close, source, updated_at) VALUES (?, ?, ?, 'test', ?)"
      ).run(ticker, date, close, stamp);
    }
    const report = await hygiene.runStorageHygiene({
      now: NOW,
      dryRun: false,
      skipSizeWalk: true,
      litestreamAgeSeconds: null,
      checkpoint: () => ({ busy: 0, log: 0, checkpointed: 0 })
    });
    expect(report.errors).toEqual([]);
    expect(report.estimates.some((row) => row.table === "history_cache_eod")).toBe(false);
    expect(
      (
        db
          .prepare("SELECT ticker, date FROM history_cache_eod ORDER BY ticker, date")
          .all() as Array<{ ticker: string; date: string }>
      ).map((row) => `${row.ticker}:${row.date}`)
    ).toEqual([
      `AAPL:${ancient}`,
      `AAPL:${fiveYears}`,
      `AAPL:${justOld}`,
      `AAPL:${fresh}`,
      `MSFT:${ancient}`
    ]);
    // A second consecutive live pass must not narrow it either.
    const second = await hygiene.runStorageHygiene({
      now: NOW,
      dryRun: false,
      skipSizeWalk: true,
      litestreamAgeSeconds: null,
      checkpoint: () => ({ busy: 0, log: 0, checkpointed: 0 })
    });
    expect(second.errors).toEqual([]);
    expect(count(db, "history_cache_eod")).toBe(5);
  });

  it("yields during the dbstat size walk", async () => {
    const { db, hygiene } = await open();
    clearHygieneRows(db);
    db.prepare("INSERT INTO api_health_log (id, service, ts, ok, error_text) VALUES ('h1', 'yahoo', ?, 0, 'old')").run(
      isoDaysBefore(40)
    );
    let yields = 0;
    const report = await hygiene.runStorageHygiene({
      now: NOW,
      dryRun: false,
      skipSizeWalk: false,
      litestreamAgeSeconds: 10,
      walBytes: 1024,
      checkpoint: () => ({ busy: 0, log: 1, checkpointed: 1 }),
      yieldFn: async () => {
        yields += 1;
      }
    });
    expect(report.errors).toEqual([]);
    expect(count(db, "api_health_log")).toBe(1);
    expect(yields).toBeGreaterThanOrEqual(1);
    expect(report.checkpoint.truncateRan).toBe(false);
    expect(report.checkpoint.truncateReason).toMatch(/below truncate floor/);
  });

  it("truncates the WAL only after a complete passive copy and a safe replica", async () => {
    const { hygiene, db } = await open();
    clearHygieneRows(db);
    const { WAL_TRUNCATE_MIN_BYTES } = hygiene;
    const passiveOk = { busy: 0, log: 8, checkpointed: 8 };

    async function run(partial: {
      passive?: { busy: number; log: number; checkpointed: number };
      walBytes?: number;
      age?: number | null;
      uncertain?: boolean;
      dryRun?: boolean;
    }) {
      const calls: string[] = [];
      const report = await hygiene.runStorageHygiene({
        now: NOW,
        dryRun: partial.dryRun ?? false,
        skipSizeWalk: true,
        walBytes: partial.walBytes ?? WAL_TRUNCATE_MIN_BYTES,
        litestreamAgeSeconds: partial.age === undefined ? 10 : partial.age,
        litestreamUncertain: partial.uncertain,
        checkpoint: (mode) => {
          calls.push(mode);
          if (mode === "PASSIVE") return partial.passive ?? passiveOk;
          return { busy: 0, log: 0, checkpointed: 0 };
        }
      });
      return { calls, report };
    }

    const fresh = await run({});
    expect(fresh.calls).toEqual(["PASSIVE", "TRUNCATE"]);
    expect(fresh.report.checkpoint.truncateRan).toBe(true);

    const absent = await run({ age: null });
    expect(absent.calls).toEqual(["PASSIVE", "TRUNCATE"]);

    const busy = await run({ passive: { busy: 1, log: 8, checkpointed: 0 } });
    expect(busy.calls).toEqual(["PASSIVE"]);
    expect(busy.report.checkpoint.truncateReason).toMatch(/readers/);

    const partialCopy = await run({ passive: { busy: 0, log: 8, checkpointed: 3 } });
    expect(partialCopy.calls).toEqual(["PASSIVE"]);

    const stale = await run({ age: 999 });
    expect(stale.calls).toEqual(["PASSIVE"]);
    expect(stale.report.checkpoint.truncateReason).toMatch(/litestream/);

    const uncertain = await run({ uncertain: true, age: null });
    expect(uncertain.calls).toEqual(["PASSIVE"]);

    const dry = await run({ dryRun: true });
    expect(dry.calls).toEqual([]);
    expect(dry.report.checkpoint.truncateRan).toBe(false);
  });

  it("respects the disabled switch and the 6 hour / 10 minute cadence", async () => {
    const { db, hygiene } = await open();
    clearHygieneRows(db);
    const t0 = NOW.getTime();
    const first = await hygiene.runStorageHygieneIfDue(t0);
    expect(first).not.toBeNull();
    expect(first?.dryRun).toBe(false);
    expect(await hygiene.runStorageHygieneIfDue(t0 + 60_000)).toBeNull();

    process.env.SQLITE_STORAGE_HYGIENE_DISABLED = "1";
    try {
      expect(await hygiene.runStorageHygieneIfDue(t0 + hygiene.HYGIENE_FULL_INTERVAL_MS + 1_000)).toBeNull();
    } finally {
      delete process.env.SQLITE_STORAGE_HYGIENE_DISABLED;
    }

    process.env.SQLITE_STORAGE_HYGIENE_DRY_RUN = "1";
    try {
      const dry = await hygiene.runStorageHygieneIfDue(t0 + hygiene.HYGIENE_FULL_INTERVAL_MS + 1_000);
      expect(dry?.dryRun).toBe(true);
      expect(dry?.deletedRows).toBe(0);
      const checkpoint = db.prepare("SELECT value FROM settings WHERE key = 'storage-hygiene:lastCheckpointAt'").get() as {
        value: string;
      };
      expect(JSON.parse(checkpoint.value)).toBe(new Date(t0).toISOString());
      expect(await hygiene.runStorageHygieneIfDue(t0 + hygiene.HYGIENE_FULL_INTERVAL_MS + 20 * 60_000)).toBeNull();
    } finally {
      delete process.env.SQLITE_STORAGE_HYGIENE_DRY_RUN;
    }
  });

  it("claims the watermark before the pass and skips an overlapping tick", async () => {
    const { db, hygiene } = await open();
    clearHygieneRows(db);
    const t0 = NOW.getTime();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hygiene.storageHygieneTestHooks.beforePass = () => gate;
    try {
      const first = hygiene.runStorageHygieneIfDue(t0);
      await Promise.resolve();
      const overlapped = await hygiene.runStorageHygieneIfDue(t0 + hygiene.HYGIENE_FULL_INTERVAL_MS + 60_000);
      expect(overlapped).toBeNull();
      const claimed = db.prepare("SELECT value FROM settings WHERE key = 'storage-hygiene:lastFullAt'").get() as {
        value: string;
      };
      expect(JSON.parse(claimed.value)).toBe(new Date(t0).toISOString());
      release();
      expect(await first).not.toBeNull();
      const after = db.prepare("SELECT value FROM settings WHERE key = 'storage-hygiene:lastFullAt'").get() as {
        value: string;
      };
      expect(JSON.parse(after.value)).toBe(new Date(t0).toISOString());
    } finally {
      release();
      delete hygiene.storageHygieneTestHooks.beforePass;
    }
  });

  it("keeps the watermark when the pass throws so the next tick does not start another walk", async () => {
    const { db, hygiene } = await open();
    clearHygieneRows(db);
    const t0 = NOW.getTime();
    const nowIso = new Date(t0).toISOString();
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('storage-hygiene:lastCheckpointAt', ?, ?)"
    ).run(JSON.stringify(nowIso), nowIso);
    hygiene.storageHygieneTestHooks.beforePass = async () => {
      throw new Error("hygiene boom");
    };
    try {
      let thrown: unknown;
      try {
        await hygiene.runStorageHygieneIfDue(t0);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/hygiene boom/);
      expect(await hygiene.runStorageHygieneIfDue(t0 + 60_000)).toBeNull();
      const claimed = db.prepare("SELECT value FROM settings WHERE key = 'storage-hygiene:lastFullAt'").get() as {
        value: string;
      };
      expect(JSON.parse(claimed.value)).toBe(new Date(t0).toISOString());
    } finally {
      delete hygiene.storageHygieneTestHooks.beforePass;
    }
  });

  it("audit prune yielding deletes no rows (forever retention)", async () => {
    const { db } = await open();
    clearHygieneRows(db);
    const insert = db.prepare(
      "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, 'local', NULL, ?, ?, '{}')"
    );
    const old = isoDaysBefore(120);
    for (let i = 0; i < 10; i += 1) insert.run(`aud-${i}`, old, "order_placed");
    insert.run("aud-keep", isoDaysBefore(400), "llm_call_latency");
    const { pruneAuditEventsYielding } = await import("../src/lib/audit-prune");
    const result = await pruneAuditEventsYielding(NOW, 50_000, async () => {});
    expect(result.auditDefault).toBe(0);
    expect(result.auditObservability).toBe(0);
    expect(count(db, "audit_events")).toBe(11);
  });
});

describe("auto_vacuum arming", () => {
  it("leaves an existing database alone and arms INCREMENTAL on an empty file", async () => {
    const existingPath = join(tmpdir(), `agentic-hygiene-existing-${randomUUID()}.db`);
    const planted = new Database(existingPath);
    planted.exec("CREATE TABLE planted (id INTEGER PRIMARY KEY, note TEXT)");
    planted.prepare("INSERT INTO planted (note) VALUES ('keep')").run();
    planted.close();

    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${existingPath}`;
    const dbMod = await import("../src/lib/db");
    dbMod.resetDbForTesting();
    const existing = dbMod.getDb();
    expect(Number(existing.pragma("auto_vacuum", { simple: true }))).toBe(0);
    const hygiene = await import("../src/lib/sqlite-storage-hygiene");
    const refused = await hygiene.runStorageHygiene({
      now: NOW,
      dryRun: false,
      skipSizeWalk: true,
      checkpoint: () => ({ busy: 0, log: 0, checkpointed: 0 })
    });
    expect(refused.autoVacuum).toBe("none");
    expect(refused.incrementalVacuum.run).toBe(false);
    expect(refused.incrementalVacuum.reason).toMatch(/not INCREMENTAL/);
    expect(refused.expectedFileShrinkBytes).toBe(0);
    expect((existing.prepare("SELECT note FROM planted").get() as { note: string }).note).toBe("keep");

    const freshPath = join(tmpdir(), `agentic-hygiene-fresh-${randomUUID()}.db`);
    process.env.DATABASE_URL = `file:${freshPath}`;
    dbMod.resetDbForTesting();
    const fresh = dbMod.getDb();
    expect(Number(fresh.pragma("auto_vacuum", { simple: true }))).toBe(2);
    const payload = "p".repeat(20_000);
    const insert = fresh.prepare("INSERT INTO api_health_log (id, service, ts, ok, error_text) VALUES (?, 'yahoo', ?, 0, ?)");
    for (let i = 0; i < 80; i += 1) insert.run(`fat-${i}`, isoDaysBefore(40), payload);
    fresh.prepare("DELETE FROM api_health_log WHERE id LIKE 'fat-%'").run();
    const pagesBefore = Number(fresh.pragma("page_count", { simple: true }));
    const reclaimed = await hygiene.runStorageHygiene({
      now: NOW,
      dryRun: false,
      skipSizeWalk: true,
      litestreamAgeSeconds: 10,
      walBytes: 1024,
      checkpoint: () => ({ busy: 0, log: 1, checkpointed: 1 })
    });
    expect(reclaimed.autoVacuum).toBe("incremental");
    expect(reclaimed.incrementalVacuum.run).toBe(true);
    expect(reclaimed.incrementalVacuum.pages).toBeLessThanOrEqual(hygiene.INCREMENTAL_VACUUM_PAGE_CAP);
    expect(reclaimed.expectedFileShrinkBytes).toBeGreaterThan(0);
    expect(Number(fresh.pragma("page_count", { simple: true }))).toBeLessThan(pagesBefore);
    expect(count(fresh, "api_health_log")).toBe(0);
    expect(statSync(freshPath).size).toBeGreaterThan(0);

    process.env.DATABASE_URL = previous;
    dbMod.resetDbForTesting();
  });
});
