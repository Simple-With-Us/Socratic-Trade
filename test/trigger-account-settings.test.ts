/**
 * Per-account trigger settings (policy.triggerSettings, 2026-07-28).
 *
 * Covers:
 *  (a) cadenceLaneDecision — the scheduler's per-account cadence-lane resolution: event mode with
 *      fallbackIntervalMinutes set runs the lane on the FALLBACK interval; without it, the lane is
 *      dropped (pre-existing behavior); engine off / interval|both mode = pure interval, unchanged.
 *  (b) per-account enabled === false suppresses event-fired runs for that account (admission +
 *      broadcast fanout) while another account still fires.
 *  (c) eventRunMode "close_only" fires the strategy with a RUN-SCOPED close_only override and the
 *      STORED policy is byte-identical after the run (the clone can never persist).
 */
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
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-trigger-acct-${randomUUID()}.db`)}`;
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

async function activateUser(userId: string, triggerSettings?: Record<string, unknown>): Promise<void> {
  const { getPolicy, setPolicy } = await import("../src/lib/db");
  setPolicy(
    { ...getPolicy(userId), systemState: "active", accountNumber: `ACC-${userId}`, ...(triggerSettings ? { triggerSettings } : {}) },
    userId
  );
}

describe("cadenceLaneDecision — per-account cadence lane (fallback interval)", () => {
  it("engine off for the account = pure interval, current default behavior", async () => {
    delete process.env.TRIGGER_ENGINE;
    const { cadenceLaneDecision } = await import("../src/lib/triggers");
    expect(cadenceLaneDecision({ runCadenceMinutes: 45 })).toEqual({ run: true, cadenceMinutes: 45 });
    // An explicit per-account mode is inert while the engine is off for the account.
    expect(cadenceLaneDecision({ runCadenceMinutes: 45, triggerSettings: { mode: "event" } })).toEqual({ run: true, cadenceMinutes: 45 });
  });

  it("event mode WITHOUT a fallback drops the cadence lane (pre-existing behavior)", async () => {
    const { cadenceLaneDecision } = await import("../src/lib/triggers");
    expect(cadenceLaneDecision({ runCadenceMinutes: 60 }).run).toBe(false);
    expect(cadenceLaneDecision({ runCadenceMinutes: 60, triggerSettings: { enabled: true, mode: "event" } }).run).toBe(false);
  });

  it("event mode WITH fallbackIntervalMinutes runs the lane on the FALLBACK interval, not runCadenceMinutes", async () => {
    const { cadenceLaneDecision } = await import("../src/lib/triggers");
    expect(cadenceLaneDecision({ runCadenceMinutes: 60, triggerSettings: { mode: "event", fallbackIntervalMinutes: 240 } }))
      .toEqual({ run: true, cadenceMinutes: 240 });
  });

  it("mode interval/both keeps the normal cadence", async () => {
    const { cadenceLaneDecision } = await import("../src/lib/triggers");
    process.env.TRIGGER_MODE = "both";
    expect(cadenceLaneDecision({ runCadenceMinutes: 30 })).toEqual({ run: true, cadenceMinutes: 30 });
    expect(cadenceLaneDecision({ runCadenceMinutes: 30, triggerSettings: { mode: "interval" } })).toEqual({ run: true, cadenceMinutes: 30 });
  });

  it("ignores a non-positive fallback (treated as unset)", async () => {
    const { cadenceLaneDecision } = await import("../src/lib/triggers");
    expect(cadenceLaneDecision({ runCadenceMinutes: 60, triggerSettings: { mode: "event", fallbackIntervalMinutes: 0 } }).run).toBe(false);
  });
});

describe("per-account enabled = false suppresses event runs for that account only", () => {
  it("admitRun rejects the opted-out account and admits the default one", async () => {
    const optedOut = `trigger-off-${randomUUID()}`;
    const optedIn = `trigger-on-${randomUUID()}`;
    await activateUser(optedOut, { enabled: false });
    await activateUser(optedIn);
    const { admitRun } = await import("../src/lib/triggers");
    const batch = [{ type: "regime", sourceId: `flip-${randomUUID()}` }];
    expect(admitRun(optedOut, batch)).toEqual({ ok: false, reason: "account_triggers_disabled" });
    expect(admitRun(optedIn, batch)).toEqual({ ok: true });
  });

  it("broadcast fanout skips the opted-out account; the other account's event still fires a run", async () => {
    process.env.TRIGGER_MAX_BATCH = "1";
    const optedOut = `trigger-off-${randomUUID()}`;
    const optedIn = `trigger-on-${randomUUID()}`;
    await activateUser(optedOut, { enabled: false });
    await activateUser(optedIn);
    const { broadcastMaterialEvent, getDurableMaterialTriggerStatus, eligibleMaterialTriggerUserIds } = await import("../src/lib/triggers");

    expect(eligibleMaterialTriggerUserIds()).toContain(optedIn);
    expect(eligibleMaterialTriggerUserIds()).not.toContain(optedOut);

    broadcastMaterialEvent({ type: "regime", sourceId: `flip-${randomUUID()}` });
    expect(getDurableMaterialTriggerStatus(optedOut).pending).toBe(0);
    expect(getDurableMaterialTriggerStatus(optedIn).pending).toBe(1);

    await vi.waitFor(() => expect(
      runStrategyOnceMock.mock.calls.filter(([calledUserId]) => calledUserId === optedIn)
    ).toHaveLength(1));
    expect(runStrategyOnceMock.mock.calls.filter(([calledUserId]) => calledUserId === optedOut)).toHaveLength(0);
  });
});

describe("eventRunMode close_only — run-scoped override, stored policy unchanged", () => {
  it("fires with runStateOverride close_only and never persists it", async () => {
    process.env.TRIGGER_MAX_BATCH = "1";
    const closeOnlyUser = `trigger-co-${randomUUID()}`;
    const fullUser = `trigger-full-${randomUUID()}`;
    await activateUser(closeOnlyUser, { enabled: true, eventRunMode: "close_only" });
    await activateUser(fullUser);
    const { submitMaterialEvent, getDurableMaterialTriggerStatus } = await import("../src/lib/triggers");
    const { getPolicy } = await import("../src/lib/db");

    const before = getPolicy(closeOnlyUser);
    expect(before.systemState).toBe("active");
    expect(before.triggerSettings?.eventRunMode).toBe("close_only");

    submitMaterialEvent(closeOnlyUser, { type: "regime", sourceId: `flip-${randomUUID()}` });
    submitMaterialEvent(fullUser, { type: "regime", sourceId: `flip-${randomUUID()}` });

    await vi.waitFor(() => expect(
      runStrategyOnceMock.mock.calls.filter(([calledUserId]) => calledUserId === closeOnlyUser)
    ).toHaveLength(1));
    await vi.waitFor(() => expect(
      runStrategyOnceMock.mock.calls.filter(([calledUserId]) => calledUserId === fullUser)
    ).toHaveLength(1));

    // close_only account: run-scoped override threaded in.
    expect(runStrategyOnceMock).toHaveBeenCalledWith(closeOnlyUser, { runStateOverride: "close_only" });
    // default account: byte-identical invocation (no options argument at all).
    expect(runStrategyOnceMock).toHaveBeenCalledWith(fullUser);

    // Stored policy is untouched by the run — systemState still active, settings intact.
    await vi.waitFor(() => expect(getDurableMaterialTriggerStatus(closeOnlyUser).pending).toBe(0));
    const after = getPolicy(closeOnlyUser);
    expect(after.systemState).toBe("active");
    expect(after.triggerSettings).toEqual({ enabled: true, eventRunMode: "close_only" });
  });
});
