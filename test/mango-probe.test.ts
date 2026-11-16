import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetMangoProbeForTests,
  getMangoProbe,
  mangoProbeDeps,
  MANGO_PROBE_ATTEMPT_TIMEOUT_MS,
  MANGO_PROBE_FAILURE_CACHE_MS,
  MANGO_PROBE_MAX_ATTEMPTS,
  MANGO_PROBE_SUCCESS_CACHE_MS,
  type MangoConnectOutcome
} from "../src/lib/mango-probe";

/**
 * The probe behind GET /api/proxy-use's `mango` field.  The connect call is
 * scripted through mangoProbeDeps so no real socket is opened: the Nov 14,
 * 2026 incident shape was a healthy proxy whose connects intermittently
 * spent a full SYN retransmit step and crossed the old single-attempt 3s
 * timeout (healthy latencyMs samples that day: 140–2,008 ms).
 */

const realConnectTcp = mangoProbeDeps.connectTcp;
const realSleep = mangoProbeDeps.sleep;
const realProxyUrl = process.env.RESIDENTIAL_PROXY_URL;

let scripted: MangoConnectOutcome[] = [];
let connectCalls: Array<{ host: string; port: number; timeoutMs: number }> = [];

function scriptConnect(outcomes: MangoConnectOutcome[]): void {
  scripted = [...outcomes];
  mangoProbeDeps.connectTcp = (host: string, port: number, timeoutMs: number) => {
    connectCalls.push({ host, port, timeoutMs });
    const next = scripted.shift();
    if (!next) return Promise.resolve({ ok: false, failureKind: "error" } as MangoConnectOutcome);
    return Promise.resolve(next);
  };
}

const timeout = (): MangoConnectOutcome => ({ ok: false, failureKind: "timeout" });
const refused = (): MangoConnectOutcome => ({ ok: false, failureKind: "refused" });
const ok = (latencyMs: number): MangoConnectOutcome => ({ ok: true, latencyMs });

describe("mango-probe", () => {
  beforeEach(() => {
    __resetMangoProbeForTests();
    connectCalls = [];
    mangoProbeDeps.sleep = () => Promise.resolve();
    process.env.RESIDENTIAL_PROXY_URL = "http://10.99.0.2:8888";
  });

  afterEach(() => {
    mangoProbeDeps.connectTcp = realConnectTcp;
    mangoProbeDeps.sleep = realSleep;
    if (realProxyUrl === undefined) {
      delete process.env.RESIDENTIAL_PROXY_URL;
    } else {
      process.env.RESIDENTIAL_PROXY_URL = realProxyUrl;
    }
    __resetMangoProbeForTests();
  });

  it("reports reachable on the first attempt when the connect succeeds", async () => {
    scriptConnect([ok(140)]);
    const probe = await getMangoProbe(1_000_000);
    expect(probe).toMatchObject({
      host: "10.99.0.2:8888",
      reachable: true,
      latencyMs: 140,
      attempts: 1,
      failureKind: null
    });
    expect(connectCalls).toEqual([{ host: "10.99.0.2", port: 8888, timeoutMs: MANGO_PROBE_ATTEMPT_TIMEOUT_MS }]);
  });

  it("does not condemn the check when the first attempt times out but a retry connects (Nov 14 incident shape)", async () => {
    scriptConnect([timeout(), ok(140)]);
    const probe = await getMangoProbe(1_000_000);
    expect(probe.reachable).toBe(true);
    expect(probe.latencyMs).toBe(140);
    expect(probe.attempts).toBe(2);
    expect(probe.failureKind).toBeNull();
    expect(connectCalls).toHaveLength(2);
  });

  it("still reports unreachable when every attempt is refused (a genuinely dead proxy)", async () => {
    scriptConnect([refused(), refused(), refused()]);
    const probe = await getMangoProbe(1_000_000);
    expect(probe.reachable).toBe(false);
    expect(probe.latencyMs).toBeNull();
    expect(probe.attempts).toBe(MANGO_PROBE_MAX_ATTEMPTS);
    expect(probe.failureKind).toBe("refused");
  });

  it("still reports unreachable when every attempt times out (a black-holed path)", async () => {
    scriptConnect([timeout(), timeout(), timeout()]);
    const probe = await getMangoProbe(1_000_000);
    expect(probe.reachable).toBe(false);
    expect(probe.attempts).toBe(MANGO_PROBE_MAX_ATTEMPTS);
    expect(probe.failureKind).toBe("timeout");
  });

  it("serves a successful verdict from cache for the success TTL without re-probing", async () => {
    scriptConnect([ok(140), ok(150)]);
    const t0 = 1_000_000;
    const first = await getMangoProbe(t0);
    const cached = await getMangoProbe(t0 + MANGO_PROBE_SUCCESS_CACHE_MS - 1);
    expect(cached).toEqual(first);
    expect(connectCalls).toHaveLength(1);
    const refreshed = await getMangoProbe(t0 + MANGO_PROBE_SUCCESS_CACHE_MS + 1);
    expect(refreshed.latencyMs).toBe(150);
    expect(connectCalls).toHaveLength(2);
  });

  it("re-probes a failed verdict within the watchdog's 10s confirmation window instead of serving the failed sample twice", async () => {
    scriptConnect([timeout(), timeout(), timeout(), ok(140)]);
    const t0 = 1_000_000;
    const failed = await getMangoProbe(t0);
    expect(failed.reachable).toBe(false);
    expect(connectCalls).toHaveLength(MANGO_PROBE_MAX_ATTEMPTS);

    // Inside the short failure TTL the cached verdict is still served.
    const stillCached = await getMangoProbe(t0 + MANGO_PROBE_FAILURE_CACHE_MS - 1);
    expect(stillCached).toEqual(failed);
    expect(connectCalls).toHaveLength(MANGO_PROBE_MAX_ATTEMPTS);

    // At +10s — when the watchdog re-reads to confirm — the failure cache has
    // expired, so the read runs a fresh check and sees the healthy proxy.
    const reread = await getMangoProbe(t0 + 10_000);
    expect(reread.reachable).toBe(true);
    expect(reread.attempts).toBe(1);
    expect(connectCalls).toHaveLength(MANGO_PROBE_MAX_ATTEMPTS + 1);
  });

  it("shares one running check across concurrent callers, then probes fresh after it settles", async () => {
    scriptConnect([ok(140), ok(150)]);
    const t0 = 1_000_000;
    const [first, second] = await Promise.all([getMangoProbe(t0), getMangoProbe(t0)]);
    expect(first).toEqual(second);
    expect(first.latencyMs).toBe(140);
    expect(connectCalls).toHaveLength(1);

    // After settlement and cache expiry, a later call runs a fresh check
    // instead of joining the settled one.
    const later = await getMangoProbe(t0 + MANGO_PROBE_SUCCESS_CACHE_MS + 1);
    expect(later.latencyMs).toBe(150);
    expect(connectCalls).toHaveLength(2);
  });

  it("reports failureKind error with zero attempts when the proxy URL cannot be resolved, and never throws", async () => {
    process.env.RESIDENTIAL_PROXY_URL = "off";
    scriptConnect([ok(140)]);
    const probe = await getMangoProbe(1_000_000);
    expect(probe.reachable).toBe(false);
    expect(probe.attempts).toBe(0);
    expect(probe.failureKind).toBe("error");
    expect(connectCalls).toHaveLength(0);
  });
});
