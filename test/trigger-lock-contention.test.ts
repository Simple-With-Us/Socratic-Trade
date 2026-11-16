import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/market-hours", () => ({
  isRunAllowedNow: () => true
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-trigger-lock-${randomUUID()}.db`)}`;
});

const ENV_KEYS = [
  "TRIGGER_ENGINE",
  "TRIGGER_MODE",
  "TRIGGER_MAX_BATCH",
  "TRIGGER_DEBOUNCE_MS",
  "TRIGGER_MAX_DEBOUNCE_MS",
  "TRIGGER_GLOBAL_COOLDOWN_SEC",
  "TRIGGER_RETRY_DELAY_MS"
];

beforeEach(() => {
  process.env.TRIGGER_ENGINE = "on";
  process.env.TRIGGER_MODE = "event";
  process.env.TRIGGER_MAX_BATCH = "1";
  process.env.TRIGGER_DEBOUNCE_MS = "0";
  process.env.TRIGGER_MAX_DEBOUNCE_MS = "0";
  process.env.TRIGGER_GLOBAL_COOLDOWN_SEC = "0";
  process.env.TRIGGER_RETRY_DELAY_MS = "60000";
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("material-trigger strategy lock contention", () => {
  it("returns the claimed event to the durable queue instead of acknowledging it", async () => {
    const db = await import("../src/lib/db");
    const triggers = await import("../src/lib/triggers");
    const userId = `trigger-lock-${randomUUID()}`;
    const lockOwner = `existing-run-${randomUUID()}`;
    db.setPolicy({
      ...db.getPolicy(userId),
      systemState: "active",
      accountNumber: `ACC-${userId}`
    }, userId);
    expect(db.acquireStrategyLock(lockOwner, userId)).toBe(true);

    try {
      triggers.submitMaterialEvent(userId, {
        type: "sec8k",
        symbol: "AAPL",
        sourceId: `accession-${randomUUID()}`
      });

      await vi.waitFor(() => {
        const row = db.getDb().prepare(`
          SELECT value FROM user_settings
          WHERE user_id = ? AND key = 'material_trigger_state_v1'
        `).get(userId) as { value: string };
        const state = JSON.parse(row.value) as {
          pending: Array<{ claimOwner?: string; retryAfterMs?: number }>;
          receipts: Record<string, number>;
        };
        expect(state.pending).toHaveLength(1);
        expect(state.pending[0]?.claimOwner).toBeUndefined();
        expect(state.pending[0]?.retryAfterMs).toBeGreaterThan(Date.now());
        expect(Object.keys(state.receipts)).toHaveLength(0);
      }, { timeout: 10_000 });

      expect(triggers.getDurableMaterialTriggerStatus(userId)).toMatchObject({
        pending: 1,
        claimed: 0,
        receiptCount: 0
      });
      expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM strategy_runs WHERE user_id = ?")
        .get(userId)).toEqual({ count: 0 });
    } finally {
      db.releaseStrategyLock(lockOwner, userId);
    }
  });
});
