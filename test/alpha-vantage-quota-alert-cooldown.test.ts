// End-to-end plumbing test: AlphaVantageEnrichmentProvider's key-pool exhaustion path ->
// logApiHealth's `quotaResetAt` -> alertConnectionFailure's `opts.cooldownUntil` -> the stored
// cooldown setting. Confirms the whole chain wires together (not just the unit-level cooldown
// arithmetic, covered separately in test/connection-health-routing.test.ts's "quota-exhaustion vs
// generic" describe block, and the DST-safe reset computation itself, covered in
// test/alpha-vantage-key-pool.test.ts).
//
// Isolated in its OWN temp DB/file (rather than appended to alpha-vantage-key-pool.test.ts's
// shared-DB describe blocks) so this test's fake-timed alert doesn't collide with the cooldown
// key another test in that file may have already set at real wall-clock time.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let sendNotificationSpy: any;

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-av-quota-alert-cooldown-${randomUUID()}.db`)}`;
});

// logApiHealth fires alertConnectionFailure with `void` (fire-and-forget) — it does not block
// enrich()'s returned promise. Flush the real (unfaked) event loop briefly so the background
// alert's own chain of `await import(...)` + setInternalSetting has a chance to land before the
// test asserts on it.
async function flushBackgroundAlert(): Promise<void> {
  // A fixed 50ms nap raced the fire-and-forget alert chain when the FULL suite saturates every
  // core (observed 2026-07-18 in two consecutive land.sh gates, while solo/pairwise runs always
  // passed): the sendNotification spy had fired but the cooldown SETTING write behind it had not
  // landed yet, so the "7h later" enrich saw no stored cooldown and double-alerted. Keep the
  // 50ms real-event-loop yield as the floor, then poll (bounded ~5s of REAL time — counted in
  // iterations because Date is faked) until the stored cooldown key exists. Second/subsequent
  // calls see the key immediately and exit after the original single yield, preserving the old
  // timing for the no-new-alert assertions.
  const { getDb } = await import("../src/lib/db");
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = getDb()
      .prepare("SELECT 1 FROM settings WHERE key LIKE 'healthAlertSent:%' LIMIT 1")
      .get();
    if (row) return;
  }
}

describe("Alpha Vantage quota exhaustion -> alertConnectionFailure cooldown plumbing", () => {

  beforeEach(async () => {
    // Isolate from real-world pacing/circuit-breaker behavior — mirrors
    // test/alpha-vantage-key-pool.test.ts's "AlphaVantageEnrichmentProvider multi-key integration".
    process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
    process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
    // Both tests in this file alert on the SAME (service, keySource) cooldown key
    // ("healthAlertSent:alpha-vantage:env") — clear it (and the health log it's derived from)
    // so one test's stored cooldown can't suppress the next test's first alert.
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'healthAlertSent:%'").run();
    getDb().prepare("DELETE FROM api_health_log").run();
  });

  afterEach(() => {
    delete process.env.PROVIDER_RATE_LIMIT_DISABLED;
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stores a cooldown pinned to the AV daily reset instant, not the generic 6h window", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    const { AlphaVantageKeyPool } = await import("../src/lib/alpha-vantage-key-pool");
    const { getInternalSetting } = await import("../src/lib/db");
    clearEnrichmentCache();

    // 1:31 AM ET — the real prod incident's first alert time.
    const start = Date.parse("2026-07-15T05:31:00Z");
    // Fake ONLY Date (not setTimeout et al.) so the fire-and-forget alert chain still gets to
    // flush on the real event loop via flushBackgroundAlert() below.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);

    const pool = new AlphaVantageKeyPool();
    pool.configure(["dead-key"]);
    pool.markExhausted("dead-key", start);

    const provider = new AlphaVantageEnrichmentProvider(["dead-key"], "env", undefined, pool);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await provider.enrich(["AAPL"]);
    expect(fetchSpy).not.toHaveBeenCalled(); // all-exhausted fast-fail, no network dispatch
    await flushBackgroundAlert();

    const cooldownIso = getInternalSetting<string>("healthAlertSent:alpha-vantage:env");
    expect(cooldownIso).toBeDefined();
    const cooldownMs = Date.parse(cooldownIso!);

    // Next America/New_York midnight after 2026-07-15T05:31:00Z (01:31 EDT) is
    // 2026-07-16T04:00:00Z (midnight EDT, UTC-4) — ~22.5h away.
    const expectedReset = Date.parse("2026-07-16T04:00:00Z");
    expect(cooldownMs).toBe(expectedReset);

    // Disambiguates from the generic 6h fallback — if quotaResetAt were silently dropped
    // somewhere in the chain, the stored cooldown would land here instead.
    expect(cooldownMs).not.toBe(start + 6 * 60 * 60_000);
  });

  it("a second exhausted enrich() call 7h later (same cap-day) does not extend or reset the cooldown", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    const { AlphaVantageKeyPool } = await import("../src/lib/alpha-vantage-key-pool");
    const { getInternalSetting } = await import("../src/lib/db");
    clearEnrichmentCache();

    const start = Date.parse("2026-07-15T05:31:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    vi.stubGlobal("fetch", vi.fn());

    const notificationsMod = await import("../src/lib/notifications");
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    const pool = new AlphaVantageKeyPool();
    pool.configure(["dead-key-2"]);
    pool.markExhausted("dead-key-2", start);
    const provider = new AlphaVantageEnrichmentProvider(["dead-key-2"], "env", undefined, pool);

    await provider.enrich(["MSFT"]);
    await flushBackgroundAlert();
    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);

    const firstCooldown = getInternalSetting<string>("healthAlertSent:alpha-vantage:env");

    // 7h later — the 8:02 AM repeat from the real incident — still same cap-day, well before reset.
    vi.setSystemTime(start + 7 * 60 * 60_000);
    await provider.enrich(["MSFT"]);
    await flushBackgroundAlert();
    expect(sendNotificationSpy).toHaveBeenCalledTimes(1); // suppressed — no second alert

    const secondCooldown = getInternalSetting<string>("healthAlertSent:alpha-vantage:env");
    expect(secondCooldown).toBe(firstCooldown); // untouched — the cooldown-check short-circuits before any re-write
  });
});
