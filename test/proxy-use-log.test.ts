import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetProxyUseLogForTests,
  getProxyUseSnapshot,
  recordProxyUse,
  type ProxyUseEntry
} from "../src/lib/proxy-use-log";

function entry(overrides: Partial<ProxyUseEntry> & { ts?: number } = {}) {
  return {
    usedProxy: true,
    source: "default" as const,
    host: "10.99.0.2:8888",
    fallback: false,
    ...overrides
  };
}

describe("proxy-use-log", () => {
  beforeEach(() => {
    __resetProxyUseLogForTests();
  });

  it("returns an empty snapshot before anything is recorded", () => {
    expect(getProxyUseSnapshot(1_000_000)).toEqual({
      latest: null,
      lastHour: { proxied: 0, direct: 0, fallbacks: 0, proxyErrors: 0 },
      total: 0
    });
  });

  it("records the latest entry with its fields intact", () => {
    recordProxyUse(entry({ ts: 1_000_000, service: "polygon" }));
    recordProxyUse(entry({ ts: 1_000_001, usedProxy: false, source: "none", host: null }));
    const snapshot = getProxyUseSnapshot(2_000_000);
    expect(snapshot.latest).toMatchObject({
      ts: 1_000_001,
      usedProxy: false,
      source: "none",
      host: null,
      fallback: false
    });
    expect(snapshot.total).toBe(2);
    expect(snapshot.lastHour).toEqual({ proxied: 1, direct: 1, fallbacks: 0, proxyErrors: 0 });
  });

  it("counts fallbacks in the last-hour window", () => {
    const now = 5_000_000;
    recordProxyUse(entry({ ts: now - 1000, usedProxy: false, source: "env", host: "10.99.0.2:8888", fallback: true }));
    recordProxyUse(entry({ ts: now - 500, usedProxy: true }));
    const snapshot = getProxyUseSnapshot(now);
    expect(snapshot.lastHour).toEqual({ proxied: 1, direct: 1, fallbacks: 1, proxyErrors: 0 });
  });

  it("excludes entries older than one hour from lastHour but keeps them in total", () => {
    const now = 10_000_000;
    recordProxyUse(entry({ ts: now - 3_700_000, usedProxy: true }));
    recordProxyUse(entry({ ts: now - 1_000, usedProxy: false, source: "none", host: null }));
    const snapshot = getProxyUseSnapshot(now);
    expect(snapshot.lastHour).toEqual({ proxied: 0, direct: 1, fallbacks: 0, proxyErrors: 0 });
    expect(snapshot.total).toBe(2);
  });

  it("keeps only the last 100 entries (ring buffer)", () => {
    const now = 20_000_000;
    for (let i = 0; i < 150; i += 1) {
      recordProxyUse(entry({ ts: now - 149 + i }));
    }
    const snapshot = getProxyUseSnapshot(now);
    expect(snapshot.total).toBe(100);
    // The 100 newest: ts values now-49 .. now
    expect(snapshot.latest?.ts).toBe(now);
    expect(snapshot.lastHour.proxied).toBe(100);
  });

  it("never throws when called with a partial entry", () => {
    expect(() => recordProxyUse({ usedProxy: false, source: "none", host: null, fallback: false })).not.toThrow();
    expect(getProxyUseSnapshot().total).toBe(1);
  });

  it("pins the ring on globalThis so bundled copies share one buffer", () => {
    const host = globalThis as { __socraticProxyUseRing?: ProxyUseEntry[] };
    recordProxyUse(entry({ ts: 42_000, service: "polygon" }));
    expect(host.__socraticProxyUseRing?.some((row) => row.ts === 42_000 && row.service === "polygon")).toBe(true);
    expect(getProxyUseSnapshot(43_000).total).toBe(host.__socraticProxyUseRing?.length);
  });

  it("records per-request outcome fields (destination, statusCode, errorClass) intact", () => {
    recordProxyUse(
      entry({ ts: 60_000, destination: "api.polygon.io", statusCode: 200, service: "polygon" })
    );
    recordProxyUse(
      entry({ ts: 60_001, destination: "query1.finance.yahoo.com", errorClass: "ECONNREFUSED" })
    );
    const snapshot = getProxyUseSnapshot(61_000);
    expect(snapshot.latest).toMatchObject({
      destination: "query1.finance.yahoo.com",
      errorClass: "ECONNREFUSED"
    });
    expect(snapshot.latest?.statusCode).toBeUndefined();
    expect(snapshot.total).toBe(2);
  });

  it("counts proxied entries with an errorClass as proxyErrors in the last-hour window", () => {
    const now = 70_000_000;
    recordProxyUse(entry({ ts: now - 2000, destination: "a.example", statusCode: 200 }));
    recordProxyUse(entry({ ts: now - 1000, destination: "b.example", errorClass: "ECONNREFUSED" }));
    recordProxyUse(entry({ ts: now - 500, usedProxy: false, source: "none", host: null }));
    // Old error outside the hour window does not count.
    recordProxyUse(entry({ ts: now - 3_700_000, destination: "c.example", errorClass: "ETIMEDOUT" }));
    const snapshot = getProxyUseSnapshot(now);
    expect(snapshot.lastHour).toEqual({ proxied: 2, direct: 1, fallbacks: 0, proxyErrors: 1 });
  });
});
