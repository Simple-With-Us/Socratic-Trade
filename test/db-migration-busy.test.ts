// Regression: boot migrations must survive write-lock contention from another live connection.
// Prod failure 2026-08-12 (deployment pyqxv16i): during a rolling deploy the outgoing container
// commits continuously; the incoming container's DEFERRED migration transaction died with an
// instant SQLITE_BUSY on the WAL snapshot upgrade (busy_timeout does not cover that path) and
// crash-looped the boot.  runMigrations now takes the write lock up front (BEGIN IMMEDIATE), so
// the busy_timeout applies while the other connection's writes drain.
import Database from "better-sqlite3";
import { spawn } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { runMigrations, type Migration } from "../src/lib/db";

const HOLD_LOCK_MS = 1200;

/** Spawns a separate process that opens the DB, takes the write lock, holds it, commits, exits. */
function spawnLockHolder(dbPath: string): Promise<void> {
  const script = `
    const Database = require("better-sqlite3");
    const db = new Database(${JSON.stringify(dbPath)});
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS contention (id INTEGER PRIMARY KEY, v TEXT)");
    db.exec("BEGIN IMMEDIATE");
    db.exec("INSERT INTO contention (v) VALUES ('held')");
    console.log("LOCKED");
    setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${HOLD_LOCK_MS});
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("LOCKED")) resolve();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`lock holder exited ${code}`));
    });
  });
}

describe("runMigrations under write-lock contention", () => {
  it("waits out another connection's write lock instead of failing the boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentic-migration-busy-"));
    const dbPath = join(dir, "app.db");

    // Seed the file + WAL mode from a primary connection, as getDb() does.
    const seed = new Database(dbPath);
    seed.pragma("journal_mode = WAL");
    seed.close();

    await spawnLockHolder(dbPath);

    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 10000"); // must exceed HOLD_LOCK_MS for the wait to succeed
    const migrations: Migration[] = [
      {
        version: 1,
        name: "contention-probe",
        up: (d: Database.Database) => {
          d.exec("CREATE TABLE migrated_ok (id INTEGER PRIMARY KEY)");
        }
      }
    ];

    // With BEGIN IMMEDIATE this blocks until the holder commits, then applies cleanly.
    const version = runMigrations(db, migrations, 0);
    expect(version).toBe(1);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'migrated_ok'").get();
    expect(row).toBeTruthy();
    db.close();
  }, 20_000);
});
