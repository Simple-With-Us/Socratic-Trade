import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/lib/data-providers";
import {
  __resetProxyFetchForTests,
  createProxiedFetch,
  PROXY_GATE_HOLD_ALERT_MS,
  PROXY_SLOT_IDLE_MS,
  PROXY_SLOT_MAX_HOLD_MS,
  ProxyConcurrencyGate,
  fetchCancelingErrorBody,
  sharedProxyConcurrencyGate
} from "../src/lib/proxy-fetch";
import { __resetYahooSessionCredsForTests } from "../src/lib/yahoo-session";
import {
  __resetYahooV7AuthCooldownForTests,
  fetchYahooFinanceQuote,
  fetchYahooFinanceQuotesBatch
} from "../src/lib/yahoo-finance";
import { GET } from "../app/api/proxy-use/route";

const undiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    fetch: (...args: unknown[]) => undiciFetch(...args)
  };
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hangingBody(status: number, cancel?: () => void): Response {
  let release: (() => void) | undefined;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      cancel() {
        release?.();
        cancel?.();
      }
    }),
    { status }
  );
}

describe("proxy gate slot leak", () => {
  const savedProxy = process.env.RESIDENTIAL_PROXY_URL;
  const savedCap = process.env.PROXY_MAX_CONCURRENCY;

  beforeEach(() => {
    __resetProxyFetchForTests();
    __resetYahooV7AuthCooldownForTests();
    __resetYahooSessionCredsForTests();
    undiciFetch.mockReset();
  });

  afterEach(() => {
    if (savedProxy === undefined) delete process.env.RESIDENTIAL_PROXY_URL;
    else process.env.RESIDENTIAL_PROXY_URL = savedProxy;
    if (savedCap === undefined) delete process.env.PROXY_MAX_CONCURRENCY;
    else process.env.PROXY_MAX_CONCURRENCY = savedCap;
    __resetProxyFetchForTests();
    __resetYahooV7AuthCooldownForTests();
    __resetYahooSessionCredsForTests();
    undiciFetch.mockReset();
  });

  it("bounds an unread body with a 20s max hold and a 60s alert", () => {
    expect(PROXY_SLOT_MAX_HOLD_MS).toBe(20_000);
    expect(PROXY_SLOT_IDLE_MS).toBe(20_000);
    expect(PROXY_GATE_HOLD_ALERT_MS).toBe(60_000);
  });

  it("reports oldestHoldMs for the oldest granted slot", async () => {
    const gate = new ProxyConcurrencyGate(() => 2);
    expect(gate.oldestHoldMs).toBe(0);
    const first = await gate.acquire();
    await sleep(30);
    const second = await gate.acquire();
    expect(gate.oldestHoldMs).toBeGreaterThanOrEqual(20);
    second.release();
    expect(gate.oldestHoldMs).toBeGreaterThanOrEqual(20);
    first.release();
    expect(gate.oldestHoldMs).toBe(0);
    expect(gate.inFlight).toBe(0);
  });

  it("lets a fifth acquire succeed within the max hold after four unread non-ok bodies", async () => {
    process.env.PROXY_MAX_CONCURRENCY = "4";
    const proxied = createProxiedFetch(
      "http://proxy.test:8888",
      (async () => hangingBody(404)) as typeof fetch,
      { slotIdleMs: 40, slotMaxHoldMs: 200 }
    );
    const held = await Promise.all(
      [1, 2, 3, 4].map((n) => proxied(`https://example.test/${n}`))
    );
    expect(held.map((res) => res.status)).toEqual([404, 404, 404, 404]);
    expect(sharedProxyConcurrencyGate.inFlight).toBe(4);
    const fifth = proxied("https://example.test/5");
    const res = await Promise.race([
      fifth,
      sleep(500).then(() => {
        throw new Error("fifth acquire did not finish within the max hold");
      })
    ]);
    expect(res.status).toBe(404);
    await sleep(200);
    expect(sharedProxyConcurrencyGate.inFlight).toBe(0);
    expect(sharedProxyConcurrencyGate.queued).toBe(0);
  });

  it("releases the slot at max hold without aborting a body that already delivered a chunk", async () => {
    process.env.PROXY_MAX_CONCURRENCY = "1";
    let pulls = 0;
    let releaseSecond: (() => void) | undefined;
    const proxied = createProxiedFetch(
      "http://proxy.test:8888",
      (async () => new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new Uint8Array([1]));
              return;
            }
            return new Promise<void>((resolve) => {
              releaseSecond = resolve;
            });
          },
          cancel() {
            releaseSecond?.();
          }
        }),
        { status: 200 }
      )) as typeof fetch,
      { slotIdleMs: 30_000, slotMaxHoldMs: 80 }
    );
    const res = await proxied("https://example.test/slow");
    expect(sharedProxyConcurrencyGate.inFlight).toBe(1);
    const reader = res.body!.getReader();
    try {
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value?.[0]).toBe(1);
      await sleep(150);
      expect(sharedProxyConcurrencyGate.inFlight).toBe(0);
      let second = "aborted";
      try {
        second = await Promise.race([
          reader.read().then(() => "chunk"),
          sleep(40).then(() => "pending")
        ]);
      } catch {
        second = "aborted";
      }
      expect(second).toBe("pending");
    } finally {
      await reader.cancel();
    }
  });

  it("abandons a stalled body after max hold has released the slot", async () => {
    process.env.PROXY_MAX_CONCURRENCY = "1";
    let cancelled = false;
    let pulls = 0;
    const proxied = createProxiedFetch(
      "http://proxy.test:8888",
      (async () => new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new Uint8Array([1]));
              return;
            }
            return new Promise<void>(() => undefined);
          },
          cancel() {
            cancelled = true;
          }
        }),
        { status: 200 }
      )) as typeof fetch,
      { slotIdleMs: 90, slotMaxHoldMs: 40, proxyTimeoutMs: 5_000 }
    );
    const res = await proxied("https://example.test/stall");
    expect(sharedProxyConcurrencyGate.inFlight).toBe(1);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await sleep(70);
    expect(sharedProxyConcurrencyGate.inFlight).toBe(0);
    expect(cancelled).toBe(false);
    await sleep(160);
    expect(cancelled).toBe(true);
    await expect(reader.read()).rejects.toThrow(/aborted/i);
  });

  it("keeps the proxy-leg timer armed after max hold releases the slot", async () => {
    process.env.PROXY_MAX_CONCURRENCY = "1";
    let cancelled = false;
    let pulls = 0;
    const proxied = createProxiedFetch(
      "http://proxy.test:8888",
      (async () => new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new Uint8Array([1]));
              return;
            }
            return new Promise<void>(() => undefined);
          },
          cancel() {
            cancelled = true;
          }
        }),
        { status: 200 }
      )) as typeof fetch,
      { slotIdleMs: 30_000, slotMaxHoldMs: 40, proxyTimeoutMs: 180 }
    );
    const res = await proxied("https://example.test/leg");
    expect(sharedProxyConcurrencyGate.inFlight).toBe(1);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await sleep(80);
    expect(sharedProxyConcurrencyGate.inFlight).toBe(0);
    expect(cancelled).toBe(false);
    const second = reader.read();
    await expect(Promise.race([
      second,
      sleep(400).then(() => {
        throw new Error("leg timer did not abort after slot release");
      })
    ])).rejects.toThrow(/aborted/i);
    expect(cancelled).toBe(true);
  });

  it("cancels a status >= 400 body unless the caller opts in", async () => {
    const calls: string[] = [];
    const fetchImpl = (async () => {
      calls.push("fetch");
      return hangingBody(503, () => {
        calls.push("cancel");
      });
    }) as typeof fetch;
    const res = await fetchCancelingErrorBody("https://example.test/err", undefined, { fetchImpl });
    expect(res.status).toBe(503);
    expect(calls).toEqual(["fetch", "cancel"]);

    const kept: string[] = [];
    const keepImpl = (async () => hangingBody(503, () => {
      kept.push("cancel");
    })) as typeof fetch;
    const keptRes = await fetchCancelingErrorBody("https://example.test/keep", undefined, {
      fetchImpl: keepImpl,
      readErrorBody: true
    });
    expect(keptRes.status).toBe(503);
    expect(kept).toEqual([]);
    await keptRes.body?.cancel();

    const okCalls: string[] = [];
    const okImpl = (async () => hangingBody(200, () => {
      okCalls.push("cancel");
    })) as typeof fetch;
    const ok = await fetchCancelingErrorBody("https://example.test/ok", undefined, { fetchImpl: okImpl });
    expect(ok.status).toBe(200);
    expect(okCalls).toEqual([]);
    await ok.body?.cancel();
  });

  it("cancels a yahoo chart 404 body and returns the gate to zero", async () => {
    process.env.RESIDENTIAL_PROXY_URL = "http://127.0.0.1:9";
    let cancels = 0;
    undiciFetch.mockImplementation(async () => hangingBody(404, () => {
      cancels += 1;
    }));
    await expect(fetchYahooFinanceQuote("BRK.B")).resolves.toBeUndefined();
    expect(cancels).toBe(1);
    expect(sharedProxyConcurrencyGate.inFlight).toBe(0);
  });

  it("cancels a yahoo v7 401 body and returns the gate to zero", async () => {
    process.env.RESIDENTIAL_PROXY_URL = "http://127.0.0.1:9";
    let cancels = 0;
    undiciFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("fc.yahoo.com")) {
        return new Response(null, { status: 200, headers: { "set-cookie": "A3=d=sess; Path=/" } });
      }
      if (url.includes("/v1/test/getcrumb")) {
        return new Response("testcrumb", { status: 200 });
      }
      return hangingBody(401, () => {
        cancels += 1;
      });
    });
    const quotes = await fetchYahooFinanceQuotesBatch(["AAPL"]);
    expect(quotes.size).toBe(0);
    expect(cancels).toBe(1);
    expect(sharedProxyConcurrencyGate.inFlight).toBe(0);
  });

  it("cancels a fetchWithRetry 429 body before the retry and returns the gate to zero", async () => {
    process.env.RESIDENTIAL_PROXY_URL = "http://127.0.0.1:9";
    let calls = 0;
    let cancels = 0;
    undiciFetch.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return hangingBody(429, () => {
          cancels += 1;
        });
      }
      return new Response("ok", { status: 200 });
    });
    const res = await fetchWithRetry(
      "https://data.example.test/quote",
      { method: "GET", cache: "no-store" },
      { retries: 1, backoffMs: 1 }
    );
    expect(cancels).toBe(1);
    expect(calls).toBe(2);
    await expect(res.text()).resolves.toBe("ok");
    expect(sharedProxyConcurrencyGate.inFlight).toBe(0);
  });

  it("exposes gate inFlight, queued, and oldestHoldMs on /api/proxy-use", async () => {
    process.env.RESIDENTIAL_PROXY_URL = "off";
    const res = await GET();
    const body = await res.json() as {
      ok: boolean;
      gate: { inFlight: number; queued: number; oldestHoldMs: number };
    };
    expect(body.ok).toBe(true);
    expect(body.gate).toEqual({ inFlight: 0, queued: 0, oldestHoldMs: 0 });
  });
});
