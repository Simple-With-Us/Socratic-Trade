import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY, DEFAULT_SCORING_WEIGHTS, DEFAULT_STRATEGY_PROMPT } from "../src/lib/defaults";
import type { TradingPolicy } from "../src/lib/types";

const MIGRATION_KEY = "migration:sp500_default_universe:2026-06-19";

afterEach(() => {
  vi.resetModules();
});

describe("policy default universe", () => {
  it("migrates an untouched empty default profile to the S&P 500 once", async () => {
    const dbPath = seedLegacyPolicy({
      ...DEFAULT_POLICY,
      includedIndices: [],
      additionalSymbols: [],
      blocklist: []
    });
    process.env.DATABASE_URL = `file:${dbPath}`;

    const { getInternalSetting, getPolicy, getStrategyProfile, setPolicy } = await import("../src/lib/db");

    expect(getPolicy().includedIndices).toEqual(["sp500"]);
    expect(getStrategyProfile("default")?.policy.includedIndices).toEqual(["sp500"]);
    expect(getInternalSetting<{ appliedAt: string }>(MIGRATION_KEY)?.appliedAt).toBeTruthy();

    setPolicy({ ...getPolicy(), includedIndices: [], additionalSymbols: [], blocklist: [] });
    vi.resetModules();

    const { getPolicy: getPolicyAfterRestart } = await import("../src/lib/db");
    expect(getPolicyAfterRestart().includedIndices).toEqual([]);
  });

  it("does not add S&P 500 to a custom watchlist-only policy", async () => {
    const dbPath = seedLegacyPolicy({
      ...DEFAULT_POLICY,
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      blocklist: []
    });
    process.env.DATABASE_URL = `file:${dbPath}`;

    const { getPolicy } = await import("../src/lib/db");

    expect(getPolicy().includedIndices).toEqual([]);
    expect(getPolicy().additionalSymbols).toEqual(["AAPL"]);
  });
});

function seedLegacyPolicy(policy: TradingPolicy): string {
  const dbPath = join(tmpdir(), `agentic-default-universe-${randomUUID()}.db`);
  const database = new Database(dbPath);
  const now = new Date().toISOString();

  database.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE strategy_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      policy TEXT NOT NULL,
      prompt TEXT NOT NULL,
      scoring_weights TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  database
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run("policy", JSON.stringify(policy), now);
  database
    .prepare(
      "INSERT INTO strategy_profiles (id, name, policy, prompt, scoring_weights, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run("default", "Default Strategy", JSON.stringify(policy), DEFAULT_STRATEGY_PROMPT, JSON.stringify(DEFAULT_SCORING_WEIGHTS), 1, now, now);
  database.close();

  return dbPath;
}
