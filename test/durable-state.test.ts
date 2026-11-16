// Tests for durable-state.ts (createDurableMap) — the shared write-behind SQLite-backed persistence
// primitive introduced so in-memory rate-limiter/circuit-breaker/cooldown state survives a process
// restart (the app now auto-deploys on every merge to main, replacing the running container
// mid-session). See individual call sites (provider-rate-limit.ts's RequestQuota, order-replacement
// .ts's recentlyRemediatedExits, usage-budget.ts's alertSentAt, congress-share.ts's refSentAt,
// triggers.ts's UserTriggerState durable fields) for restart-survival tests specific to their wiring.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDurableMap, flushDurableStateNow, resetDurableStateCacheForTests } from "../src/lib/durable-state";
import { getDurableStateValue, listDurableStateNamespace } from "../src/lib/db-durable-state";
import { getDb } from "../src/lib/db";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-durable-state-${randomUUID()}.db`)}`;
  getDb(); // forces migrate() to run (creates the durable_state table) before any test touches it
});

afterEach(() => {
  resetDurableStateCacheForTests();
  vi.useRealTimers();
});

describe("createDurableMap — Map-shaped API", () => {
  it("behaves like a Map: get/set/has/delete/size/keys/entries", () => {
    const ns = `test-basic-${randomUUID()}`;
    const m = createDurableMap<number>(ns);
    expect(m.get("a")).toBeUndefined();
    expect(m.has("a")).toBe(false);
    m.set("a", 1);
    m.set("b", 2);
    expect(m.get("a")).toBe(1);
    expect(m.has("b")).toBe(true);
    expect(m.size).toBe(2);
    expect([...m.keys()].sort()).toEqual(["a", "b"]);
    expect(new Map(m.entries())).toEqual(new Map([["a", 1], ["b", 2]]));
    m.delete("a");
    expect(m.get("a")).toBeUndefined();
    expect(m.size).toBe(1);
  });

  it("deleting a key that was never set is a harmless no-op (no phantom tombstone write)", () => {
    const ns = `test-delete-missing-${randomUUID()}`;
    const m = createDurableMap<number>(ns, { flush: "immediate" });
    expect(() => m.delete("never-set")).not.toThrow();
    expect(m.size).toBe(0);
  });
});

describe("createDurableMap — survives a simulated process restart", () => {
  it("a value set before 'restart' is readable after resetDurableStateCacheForTests + a fresh createDurableMap", () => {
    const ns = `test-restart-${randomUUID()}`;
    const before = createDurableMap<number>(ns, { flush: "immediate" });
    before.set("k", 42);

    // Simulate a process restart: forget all in-memory hydration/cache state (but leave the
    // persisted SQLite rows alone — a real restart doesn't touch disk).
    resetDurableStateCacheForTests();

    const after = createDurableMap<number>(ns, { flush: "immediate" });
    expect(after.get("k")).toBe(42); // rehydrated from SQLite, not reset to empty
  });

  it("a deleted key stays deleted across a simulated restart", () => {
    const ns = `test-restart-delete-${randomUUID()}`;
    const before = createDurableMap<number>(ns, { flush: "immediate" });
    before.set("k", 1);
    before.delete("k");
    resetDurableStateCacheForTests();
    const after = createDurableMap<number>(ns, { flush: "immediate" });
    expect(after.get("k")).toBeUndefined();
    expect(after.has("k")).toBe(false);
  });

  it("a debounced write still survives a restart once flushed (the SIGTERM/beforeExit path)", () => {
    const ns = `test-restart-debounced-${randomUUID()}`;
    const before = createDurableMap<number>(ns); // debounced (default)
    before.set("k", 7);
    flushDurableStateNow(); // what the process's shutdown hook does on a graceful SIGTERM
    resetDurableStateCacheForTests();
    const after = createDurableMap<number>(ns);
    expect(after.get("k")).toBe(7);
  });

  it("an UNFLUSHED debounced write is lost on an ungraceful restart — the documented tradeoff of write-behind", () => {
    const ns = `test-restart-unflushed-${randomUUID()}`;
    const before = createDurableMap<number>(ns); // debounced, never flushed
    before.set("k", 99);
    resetDurableStateCacheForTests(); // simulates a hard kill: no shutdown hook ran
    const after = createDurableMap<number>(ns);
    expect(after.get("k")).toBeUndefined(); // acceptable loss window for debounced mode; use "immediate" when it isn't
  });
});

describe("createDurableMap — flush modes", () => {
  it("'immediate' mode writes through to SQLite synchronously, visible to a raw read with no flush call", () => {
    const ns = `test-immediate-${randomUUID()}`;
    const m = createDurableMap<number>(ns, { flush: "immediate" });
    m.set("k", 5);
    expect(getDurableStateValue<number>(ns, "k")).toBe(5);
  });

  it("'debounced' mode (default) batches writes and does not hit SQLite until the debounce window elapses", () => {
    vi.useFakeTimers();
    const ns = `test-debounced-${randomUUID()}`;
    const m = createDurableMap<number>(ns);
    m.set("k", 9);
    expect(getDurableStateValue<number>(ns, "k")).toBeUndefined(); // not yet flushed
    vi.advanceTimersByTime(20_000); // past the ~15s debounce window
    expect(getDurableStateValue<number>(ns, "k")).toBe(9);
  });

  it("flushDurableStateNow() flushes pending debounced writes immediately, without waiting for the timer", () => {
    vi.useFakeTimers();
    const ns = `test-manual-flush-${randomUUID()}`;
    const m = createDurableMap<number>(ns);
    m.set("k", 3);
    expect(getDurableStateValue<number>(ns, "k")).toBeUndefined();
    flushDurableStateNow();
    expect(getDurableStateValue<number>(ns, "k")).toBe(3);
  });

  it("coalesces multiple debounced writes to the same key into a single flushed value", () => {
    vi.useFakeTimers();
    const ns = `test-coalesce-${randomUUID()}`;
    const m = createDurableMap<number>(ns);
    m.set("k", 1);
    m.set("k", 2);
    m.set("k", 3);
    flushDurableStateNow();
    expect(getDurableStateValue<number>(ns, "k")).toBe(3);
  });

  it("flushDurableStateNow() is a harmless no-op when nothing is pending", () => {
    expect(() => flushDurableStateNow()).not.toThrow();
    expect(() => flushDurableStateNow()).not.toThrow();
  });
});

describe("createDurableMap — clear()", () => {
  it("clear() removes both the in-memory cache AND the persisted rows for the namespace", () => {
    const ns = `test-clear-${randomUUID()}`;
    const m = createDurableMap<number>(ns, { flush: "immediate" });
    m.set("a", 1);
    m.set("b", 2);
    m.clear();
    expect(m.size).toBe(0);
    expect(listDurableStateNamespace(ns)).toEqual([]);
    // Even across a simulated restart, the cleared namespace stays empty (clear() actually deleted
    // the rows — it didn't just forget them in memory while leaving stale rows in SQLite).
    resetDurableStateCacheForTests();
    const after = createDurableMap<number>(ns, { flush: "immediate" });
    expect(after.size).toBe(0);
  });
});

describe("createDurableMap — namespace isolation", () => {
  it("two different namespaces never see each other's keys, even when the key string is identical", () => {
    const nsA = `test-isolation-a-${randomUUID()}`;
    const nsB = `test-isolation-b-${randomUUID()}`;
    const a = createDurableMap<number>(nsA, { flush: "immediate" });
    const b = createDurableMap<number>(nsB, { flush: "immediate" });
    a.set("same-key", 1);
    b.set("same-key", 2);
    expect(a.get("same-key")).toBe(1);
    expect(b.get("same-key")).toBe(2);
    expect(a.size).toBe(1);
    expect(b.size).toBe(1);
  });
});

describe("db-durable-state — corrupt row handling", () => {
  it("a corrupt (non-JSON) row is skipped rather than throwing, for a direct get, a namespace listing, and hydration", () => {
    const ns = `test-corrupt-${randomUUID()}`;
    // Write a malformed row directly (bypassing setDurableStateValue's JSON.stringify) — simulates a
    // hand-edited row, a future schema change, or on-disk corruption.
    getDb()
      .prepare("INSERT INTO durable_state (namespace, key, value, updated_at) VALUES (?, ?, ?, ?)")
      .run(ns, "bad", "{not valid json", new Date().toISOString());

    expect(getDurableStateValue(ns, "bad")).toBeUndefined();
    expect(listDurableStateNamespace(ns)).toEqual([]);

    // A fresh createDurableMap hydrating this namespace must not throw, and must simply omit the row.
    resetDurableStateCacheForTests();
    const m = createDurableMap<number>(ns);
    expect(() => m.get("bad")).not.toThrow();
    expect(m.get("bad")).toBeUndefined();
  });
});
