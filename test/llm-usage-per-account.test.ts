import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

// Isolated temp SQLite — exercises the real migration path (migration 14 must ALTER in
// connected_account_id, else recordLlmUsage's INSERT would fail and no rows would come back).
const tmpDir = path.join(os.tmpdir(), `trading-test-llm-usage-acct-${Date.now()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
process.env.DATABASE_URL = `file:${tmpDbPath}`;

const { getDb } = await import("../src/lib/db");
const { recordLlmUsage, getLlmUsageSummary } = await import("../src/lib/llm-usage");

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${tmpDbPath}${suffix}`);
    } catch {
      /* best-effort */
    }
  }
});

function seedAccount(id: string, broker: string, environment: string, label: string) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO connected_accounts (id, user_id, broker, environment, label, is_active, created_at, updated_at)
       VALUES (?, 'local', ?, ?, ?, 1, ?, ?)`
    )
    .run(id, broker, environment, label, now, now);
}

describe("per-account/broker LLM usage attribution", () => {
  beforeAll(() => {
    seedAccount("acct-alpaca", "alpaca", "paper", "Alpaca Paper");
    seedAccount("acct-rh", "robinhood", "live", "Robinhood Live");
    // Two calls attributed to the alpaca account, one to robinhood, one account-less (e.g. chat).
    recordLlmUsage({ userId: "local", provider: "openai", model: "openai/gpt-4o-mini", context: "strategy-tuning", keySource: "user", connectedAccountId: "acct-alpaca", promptTokens: 100, completionTokens: 50 });
    recordLlmUsage({ userId: "local", provider: "openai", model: "openai/gpt-4o-mini", context: "outcome-postmortem", keySource: "user", connectedAccountId: "acct-alpaca", promptTokens: 200, completionTokens: 20 });
    recordLlmUsage({ userId: "local", provider: "anthropic", model: "claude-haiku-4-5", context: "strategy", keySource: "user", connectedAccountId: "acct-rh", promptTokens: 300, completionTokens: 60 });
    recordLlmUsage({ userId: "local", provider: "openai", model: "openai/gpt-4o-mini", context: "chat", keySource: "user", promptTokens: 10, completionTokens: 5 });
    recordLlmUsage({ userId: "local", provider: "openrouter", model: "openai/gpt-4o-mini", context: "openrouter-route-preserved", keySource: "user", promptTokens: 10, completionTokens: 5 });
  });

  it("tags usage rows with the connected account + derives broker/environment/label via join", () => {
    const alpaca = getLlmUsageSummary().filter((r) => r.connectedAccountId === "acct-alpaca");
    expect(alpaca.length).toBeGreaterThan(0);
    for (const r of alpaca) {
      expect(r.broker).toBe("alpaca");
      expect(r.environment).toBe("paper");
      expect(r.accountLabel).toBe("Alpaca Paper");
    }
  });

  it("leaves account-less calls unattributed (null), not mislabeled", () => {
    const chat = getLlmUsageSummary().find((r) => r.context === "chat");
    expect(chat).toBeDefined();
    expect(chat?.connectedAccountId).toBeNull();
    expect(chat?.broker).toBeNull();
    expect(chat?.accountLabel).toBeNull();
  });

  it("preserves the OpenRouter route while pricing the routed vendor model", () => {
    const row = getLlmUsageSummary().find((r) => r.context === "openrouter-route-preserved");
    expect(row).toMatchObject({ provider: "openrouter", model: "openai/gpt-4o-mini" });
    expect(row?.costUsd).toBeGreaterThan(0);
  });

  it("filters by connectedAccountId", () => {
    const rows = getLlmUsageSummary({ connectedAccountId: "acct-alpaca" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.connectedAccountId === "acct-alpaca")).toBe(true);
    // The robinhood + unattributed rows must be excluded.
    expect(rows.some((r) => r.connectedAccountId === "acct-rh")).toBe(false);
  });

  it("filters by broker via the connected_accounts join", () => {
    const rows = getLlmUsageSummary({ broker: "robinhood" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.broker === "robinhood" && r.connectedAccountId === "acct-rh")).toBe(true);
  });
});
