import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDbForTesting } from "../src/lib/db";
import { resetTriggersForTesting } from "../src/lib/triggers";

const completedStrategyResult = () => ({
  runId: randomUUID(),
  status: "completed" as const,
  summary: "test strategy run completed",
  proposals: []
});
const runStrategyOnceMock = vi.fn().mockResolvedValue(completedStrategyResult());

vi.mock("../src/lib/strategy", () => ({
  runStrategyOnce: (...args: unknown[]) => runStrategyOnceMock(...args)
}));

vi.mock("../src/lib/market-hours", () => ({
  isRunAllowedNow: () => true
}));

beforeAll(() => {
  resetDbForTesting();
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-trigger-durable-${randomUUID()}.db`)}`;
});

const ENV_KEYS = [
  "TRIGGER_ENGINE",
  "TRIGGER_MODE",
  "TRIGGER_MAX_BATCH",
  "TRIGGER_DEBOUNCE_MS",
  "TRIGGER_MAX_DEBOUNCE_MS",
  "TRIGGER_GLOBAL_COOLDOWN_SEC",
  "TRIGGER_QUEUE_MAX"
];

beforeEach(() => {
  runStrategyOnceMock.mockReset().mockResolvedValue(completedStrategyResult());
  process.env.TRIGGER_ENGINE = "on";
  process.env.TRIGGER_MODE = "event";
  process.env.TRIGGER_GLOBAL_COOLDOWN_SEC = "0";
});

afterEach(() => {
  resetDbForTesting();
  resetTriggersForTesting();
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const key of ENV_KEYS) delete process.env[key];
});

async function activateUser(userId: string): Promise<void> {
  const { getPolicy, setPolicy } = await import("../src/lib/db");
  setPolicy({ ...getPolicy(userId), systemState: "active", accountNumber: `ACC-${userId}` }, userId);
}

describe("durable material-trigger inbox", () => {
  it("persists and deduplicates an event before the debounce timer fires", async () => {
    process.env.TRIGGER_MAX_BATCH = "25";
    process.env.TRIGGER_DEBOUNCE_MS = "60000";
    process.env.TRIGGER_MAX_DEBOUNCE_MS = "60000";
    const userId = `trigger-persist-${randomUUID()}`;
    await activateUser(userId);
    const {
      getDurableMaterialTriggerStatus,
      submitMaterialEvent
    } = await import("../src/lib/triggers");
    const event = { type: "sec8k", symbol: "AAPL", sourceId: `acc-${randomUUID()}` };

    submitMaterialEvent(userId, event);
    submitMaterialEvent(userId, event);

    expect(getDurableMaterialTriggerStatus(userId)).toMatchObject({ pending: 1, receiptCount: 0 });
    expect(runStrategyOnceMock).not.toHaveBeenCalled();
  });

  it("recovers persisted work through the drain entrypoint and records a durable receipt", async () => {
    process.env.TRIGGER_MAX_BATCH = "25";
    process.env.TRIGGER_DEBOUNCE_MS = "60000";
    process.env.TRIGGER_MAX_DEBOUNCE_MS = "60000";
    const userId = `trigger-recover-${randomUUID()}`;
    await activateUser(userId);
    const {
      drainMaterialEventQueue,
      getDurableMaterialTriggerStatus,
      submitMaterialEvent
    } = await import("../src/lib/triggers");
    const event = { type: "sec8k", symbol: "MSFT", sourceId: `acc-${randomUUID()}` };
    submitMaterialEvent(userId, event);
    expect(getDurableMaterialTriggerStatus(userId).pending).toBe(1);

    // Simulate restart recovery: the durable row is authoritative; changing the threshold and
    // invoking the drain reschedules it without another producer delivery.
    process.env.TRIGGER_MAX_BATCH = "1";
    drainMaterialEventQueue();
    await vi.waitFor(() => expect(runStrategyOnceMock).toHaveBeenCalledWith(userId));
    await vi.waitFor(() => expect(getDurableMaterialTriggerStatus(userId)).toMatchObject({
      pending: 0,
      receiptCount: 1
    }));

    submitMaterialEvent(userId, event);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(runStrategyOnceMock.mock.calls.filter(([calledUserId]) => calledUserId === userId)).toHaveLength(1);
    expect(getDurableMaterialTriggerStatus(userId).pending).toBe(0);
  });

  it("claims no more than the configured batch and leaves the FIFO tail durable", async () => {
    process.env.TRIGGER_MAX_BATCH = "2";
    process.env.TRIGGER_DEBOUNCE_MS = "60000";
    process.env.TRIGGER_MAX_DEBOUNCE_MS = "60000";
    const userId = `trigger-bounded-${randomUUID()}`;
    await activateUser(userId);
    const {
      drainMaterialEventQueue,
      enqueueMaterialEventsForUsersTx,
      getDurableMaterialTriggerStatus
    } = await import("../src/lib/triggers");
    const { getDb } = await import("../src/lib/db");
    const database = getDb();
    database.transaction(() => {
      enqueueMaterialEventsForUsersTx(database, [userId], [
        { type: "technical", symbol: "AAPL", sourceId: `event-1-${randomUUID()}` },
        { type: "technical", symbol: "MSFT", sourceId: `event-2-${randomUUID()}` },
        { type: "technical", symbol: "NVDA", sourceId: `event-3-${randomUUID()}` }
      ]);
    }).immediate();

    drainMaterialEventQueue();
    await vi.waitFor(() => expect(
      runStrategyOnceMock.mock.calls.filter(([calledUserId]) => calledUserId === userId)
    ).toHaveLength(1));
    await vi.waitFor(() => expect(getDurableMaterialTriggerStatus(userId)).toMatchObject({
      pending: 1,
      receiptCount: 2
    }));

    process.env.TRIGGER_MAX_BATCH = "1";
    drainMaterialEventQueue();
    await vi.waitFor(() => expect(
      runStrategyOnceMock.mock.calls.filter(([calledUserId]) => calledUserId === userId)
    ).toHaveLength(2));
    await vi.waitFor(() => expect(getDurableMaterialTriggerStatus(userId)).toMatchObject({
      pending: 0,
      receiptCount: 3
    }));
  });
});
