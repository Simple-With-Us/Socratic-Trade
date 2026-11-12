import { beforeEach, describe, expect, it } from "vitest";
import {
  dataSourceFetch,
  isInternalFetchTarget,
  resolveDataSourceProxy,
  type DataSourceFetchDeps
} from "../src/lib/data-source-fetch";
import { DEFAULT_RESIDENTIAL_PROXY_URL } from "../src/lib/proxy-fetch";
import {
  __resetProxyUseLogForTests,
  getProxyUseSnapshot
} from "../src/lib/proxy-use-log";

function okResponse(tag: string): Response {
  return new Response(tag, { status: 200 });
}

function makeDeps(overrides: Partial<DataSourceFetchDeps> = {}) {
  const calls: { proxied: number; direct: number; proxiedUrls: string[] } = { proxied: 0, direct: 0, proxiedUrls: [] };
  const deps: DataSourceFetchDeps = {
    env: {},
    resolveUserProxyFn: () => undefined,
    directFetch: (async () => {
      calls.direct++;
      return okResponse("direct");
    }) as typeof fetch,
    proxiedFetchFactory: (proxyUrl: string) => {
      calls.proxiedUrls.push(proxyUrl);
      return (async () => {
        calls.proxied++;
        return okResponse("proxied");
      }) as typeof fetch;
    },
    ...overrides
  };
  return { deps, calls };
}

const PROXY_DOWN = new TypeError("fetch failed", {
  cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
});

describe("resolveDataSourceProxy", () => {
  it("prefers the per-user proxy over env and default", () => {
    const r = resolveDataSourceProxy("u1", {
      env: { RESIDENTIAL_PROXY_URL: "http://env:1" },
      resolveUserProxyFn: () => ({ proxyUrl: "http://user:2", failureMode: "fail_closed" as const })
    });
    expect(r).toEqual({ proxyUrl: "http://user:2", source: "user", failureMode: "fail_closed" });
  });
  it("uses env when the user has none, then the residential default", () => {
    expect(resolveDataSourceProxy(undefined, { env: { RESIDENTIAL_PROXY_URL: "http://env:1" } }).source).toBe("env");
    const d = resolveDataSourceProxy(undefined, { env: {} });
    expect(d.source).toBe("default");
    expect(d.proxyUrl).toBe(DEFAULT_RESIDENTIAL_PROXY_URL);
  });
  it("respects the off sentinel as source=none", () => {
    expect(resolveDataSourceProxy(undefined, { env: { RESIDENTIAL_PROXY_URL: "off" } }).source).toBe("none");
  });
});

describe("dataSourceFetch", () => {
  it("goes direct when proxying is off", async () => {
    const { deps, calls } = makeDeps({ env: { RESIDENTIAL_PROXY_URL: "off" } });
    const res = await dataSourceFetch("https://query1.finance.yahoo.com/x", undefined, {}, deps);
    expect(await res.text()).toBe("direct");
    expect(calls.proxied).toBe(0);
  });

  it("routes through the effective proxy", async () => {
    const { deps, calls } = makeDeps({ env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" } });
    const res = await dataSourceFetch("https://api.polygon.io/x", undefined, {}, deps);
    expect(await res.text()).toBe("proxied");
    expect(calls.proxiedUrls).toEqual(["http://proxy.test:8888"]);
  });

  it("fail_soft falls back to direct on a proxy-leg transport error", async () => {
    const { deps, calls } = makeDeps({
      env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" },
      proxiedFetchFactory: () => (async () => {
        throw PROXY_DOWN;
      }) as typeof fetch
    });
    const res = await dataSourceFetch("https://query1.finance.yahoo.com/x", undefined, {}, deps);
    expect(await res.text()).toBe("direct");
    expect(calls.direct).toBe(1);
  });

  it("fail_soft falls back to direct when the proxied fetch aborts mid-flight", async () => {
    // Regression: previously an AbortError from the proxied fetch had no
    // `.code`, so isProxyLegError classified it as a non-proxy error and
    // rethrew.  fail_soft never engaged.  AbortError is a proxy-leg failure
    // unless the caller's own signal is already aborted.
    const { deps, calls } = makeDeps({
      env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" },
      proxiedFetchFactory: () => (async () => {
        throw new DOMException("aborted", "AbortError");
      }) as typeof fetch
    });
    const res = await dataSourceFetch("https://api.stlouisfed.org/fred/x", undefined, {}, deps);
    expect(await res.text()).toBe("direct");
    expect(calls.direct).toBe(1);
  });

  it("does not fall back to direct when the caller's own signal aborted (caller cancellation)", async () => {
    // An AbortError thrown by the proxied fetch because the caller's signal
    // fired reflects caller intent, not a proxy-leg failure. Honour the
    // cancellation — do NOT silently kick off a direct fallback the caller
    // no longer wants.
    const { deps, calls } = makeDeps({
      env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" },
      proxiedFetchFactory: () => (async (_input, init) => {
        const signal = (init as RequestInit | undefined)?.signal;
        return await new Promise<Response>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        });
      }) as typeof fetch
    });
    const controller = new AbortController();
    controller.abort(); // already aborted at call time
    await expect(
      dataSourceFetch("https://api.stlouisfed.org/fred/x", { signal: controller.signal }, {}, deps)
    ).rejects.toThrow(/aborted/i);
    expect(calls.direct).toBe(0);
  });

  it("fail_closed propagates instead of falling back", async () => {
    const { deps } = makeDeps({
      env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888", RESIDENTIAL_PROXY_FAILURE_MODE: "fail_closed" },
      proxiedFetchFactory: () => (async () => {
        throw PROXY_DOWN;
      }) as typeof fetch
    });
    await expect(dataSourceFetch("https://query1.finance.yahoo.com/x", undefined, {}, deps)).rejects.toThrow(
      /fail_closed/
    );
  });

  it("returns a proxy HTTP 502 as-is (upstream-down is not proxy-down)", async () => {
    const { deps, calls } = makeDeps({
      env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" },
      proxiedFetchFactory: () => (async () => new Response("bad gateway", { status: 502 })) as typeof fetch
    });
    const res = await dataSourceFetch("https://blocked-upstream.example/x", undefined, {}, deps);
    expect(res.status).toBe(502);
    expect(calls.direct).toBe(0);
  });

  it("never proxies internal targets, even with a proxy configured", async () => {
    const { deps, calls } = makeDeps({ env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" } });
    for (const url of ["http://localhost:3000/api/health", "http://qdrant-st:6333/collections", "http://10.0.0.5:6333/"]) {
      await dataSourceFetch(url, undefined, {}, deps);
    }
    expect(calls.direct).toBe(3);
    expect(calls.proxied).toBe(0);
  });

  it("keeps excluded services direct", async () => {
    const { deps, calls } = makeDeps({ env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" } });
    await dataSourceFetch("https://usage.jays.services/api/ingest", undefined, { service: "usage-monitor" }, deps);
    expect(calls.proxied).toBe(0);
    expect(calls.direct).toBe(1);
  });
});

describe("isInternalFetchTarget", () => {
  it("flags loopback, RFC1918, link-local, and .internal", () => {
    for (const u of [
      "http://localhost/x",
      "http://127.0.0.1:8080/x",
      "http://[::1]/x",
      "http://10.1.2.3/x",
      "http://192.168.1.1/x",
      "http://172.16.0.1/x",
      "http://169.254.169.254/latest/meta-data",
      "http://qdrant-st.internal/x",
      "http://qdrant-st:6333/x",
      "http://postgres/x"
    ]) {
      expect(isInternalFetchTarget(u), u).toBe(true);
    }
  });
  it("passes public data-source hosts", () => {
    for (const u of ["https://query1.finance.yahoo.com/x", "https://api.polygon.io/x"]) {
      expect(isInternalFetchTarget(u), u).toBe(false);
    }
  });
});

describe("dataSourceFetch proxy-use outcome logging", () => {
  beforeEach(() => {
    __resetProxyUseLogForTests();
  });

  it("records exactly one proxied entry with destination host and status code on success", async () => {
    const { deps } = makeDeps({ env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" } });
    const res = await dataSourceFetch("https://api.polygon.io/x?token=secret", undefined, { service: "polygon" }, deps);
    expect(res.status).toBe(200);
    const snapshot = getProxyUseSnapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.latest).toMatchObject({
      usedProxy: true,
      source: "env",
      host: "proxy.test:8888",
      fallback: false,
      service: "polygon",
      destination: "api.polygon.io",
      statusCode: 200
    });
    expect(snapshot.latest?.errorClass).toBeUndefined();
  });

  it("records a proxy HTTP 502 as an outcome, not a failure", async () => {
    const { deps } = makeDeps({
      env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" },
      proxiedFetchFactory: () => (async () => new Response("bad gateway", { status: 502 })) as typeof fetch
    });
    const res = await dataSourceFetch("https://blocked-upstream.example/x", undefined, {}, deps);
    expect(res.status).toBe(502);
    const snapshot = getProxyUseSnapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.latest).toMatchObject({ usedProxy: true, statusCode: 502 });
    expect(snapshot.latest?.errorClass).toBeUndefined();
  });

  it("records exactly one proxied entry with the error class on a proxy-leg failure, plus the fallback entry", async () => {
    const { deps } = makeDeps({
      env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" },
      proxiedFetchFactory: () => (async () => {
        throw PROXY_DOWN;
      }) as typeof fetch
    });
    const res = await dataSourceFetch("https://query1.finance.yahoo.com/x", undefined, {}, deps);
    expect(await res.text()).toBe("direct");
    const snapshot = getProxyUseSnapshot();
    // One entry for the failed proxied attempt, one for the direct fallback retry.
    expect(snapshot.total).toBe(2);
    expect(snapshot.lastHour).toMatchObject({ proxied: 1, direct: 1, fallbacks: 1, proxyErrors: 1 });
    const ring = (globalThis as { __socraticProxyUseRing?: { destination?: string; errorClass?: string; usedProxy: boolean; fallback: boolean }[] }).__socraticProxyUseRing ?? [];
    expect(ring).toHaveLength(2);
    expect(ring[0]).toMatchObject({
      usedProxy: true,
      fallback: false,
      destination: "query1.finance.yahoo.com",
      errorClass: "ECONNREFUSED"
    });
    expect(snapshot.latest).toMatchObject({
      usedProxy: false,
      fallback: true,
      destination: "query1.finance.yahoo.com"
    });
  });

  it("records the destination hostname only, never the full URL", async () => {
    const { deps } = makeDeps({ env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" } });
    await dataSourceFetch("https://api.polygon.io/v2/aggs?apiKey=SUPERSECRET&x=1", undefined, {}, deps);
    const latest = getProxyUseSnapshot().latest;
    expect(latest?.destination).toBe("api.polygon.io");
    expect(JSON.stringify(latest)).not.toContain("SUPERSECRET");
  });

  it("records the error class (not the message) when a non-proxy-leg error is thrown", async () => {
    const { deps } = makeDeps({
      env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" },
      proxiedFetchFactory: () => (async () => {
        throw new Error("boom https://internal.example/secret-path");
      }) as typeof fetch
    });
    await expect(dataSourceFetch("https://api.polygon.io/x", undefined, {}, deps)).rejects.toThrow("boom");
    const snapshot = getProxyUseSnapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.latest).toMatchObject({ usedProxy: true, errorClass: "Error" });
    expect(JSON.stringify(snapshot.latest)).not.toContain("secret-path");
  });

  it("records the error class on fail_closed instead of a pre-fetch decision entry", async () => {
    const { deps } = makeDeps({
      env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888", RESIDENTIAL_PROXY_FAILURE_MODE: "fail_closed" },
      proxiedFetchFactory: () => (async () => {
        throw PROXY_DOWN;
      }) as typeof fetch
    });
    await expect(dataSourceFetch("https://query1.finance.yahoo.com/x", undefined, {}, deps)).rejects.toThrow(
      /fail_closed/
    );
    const snapshot = getProxyUseSnapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.latest).toMatchObject({
      usedProxy: true,
      destination: "query1.finance.yahoo.com",
      errorClass: "ECONNREFUSED"
    });
    expect(snapshot.lastHour.proxyErrors).toBe(1);
  });

  it("logs (unparseable) destination instead of throwing for a malformed URL", async () => {
    const { deps } = makeDeps({ env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" } });
    const res = await dataSourceFetch("not a url at all", undefined, {}, deps);
    expect(res.status).toBe(200);
    expect(getProxyUseSnapshot().latest?.destination).toBe("(unparseable)");
  });
});


describe("proxy outcome logging edge cases", () => {
  beforeEach(() => __resetProxyUseLogForTests());

  it.each(["self", "mutual", "deep"])("bounds %s cause chains without changing the thrown error", async (kind) => {
    const error = new Error("private-url-must-not-be-logged");
    if (kind === "self") error.cause = error;
    else if (kind === "mutual") error.cause = new Error("second", { cause: error });
    else {
      let current = error;
      for (let i = 0; i < 100; i++) { const next = new Error("deep"); current.cause = next; current = next; }
      Object.assign(current, { code: "TOO_DEEP" });
    }
    const { deps, calls } = makeDeps({
      env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" },
      proxiedFetchFactory: () => (async () => { throw error; }) as typeof fetch
    });
    await expect(dataSourceFetch("https://api.polygon.io/x", undefined, {}, deps)).rejects.toBe(error);
    expect(getProxyUseSnapshot().latest).toMatchObject({ errorClass: "Error" });
    expect(JSON.stringify(getProxyUseSnapshot())).not.toContain("private-url");
    expect(calls.direct).toBe(0);
  });

  it.each(["AbortError", "TimeoutError", "Error"])("records caller %s cancellation without counting a proxy error or retrying", async (name) => {
    const controller = new AbortController();
    const error = Object.assign(new Error("caller stopped"), { name });
    const { deps, calls } = makeDeps({
      env: { RESIDENTIAL_PROXY_URL: "http://proxy.test:8888" },
      proxiedFetchFactory: () => (async () => { controller.abort(); throw error; }) as typeof fetch
    });
    await expect(dataSourceFetch("https://api.polygon.io/x", { signal: controller.signal }, {}, deps)).rejects.toBe(error);
    const snapshot = getProxyUseSnapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.latest).toMatchObject({ usedProxy: true, cancelled: true, destination: "api.polygon.io" });
    expect(snapshot.latest?.errorClass).toBeUndefined();
    expect(snapshot.lastHour.proxyErrors).toBe(0);
    expect(calls.direct).toBe(0);
  });
});
