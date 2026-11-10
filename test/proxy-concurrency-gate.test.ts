import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetProxyFetchForTests,
  createProxiedFetch,
  ProxyConcurrencyGate,
  PROXY_LEG_TIMEOUT_MS,
  resolveProxyLegTimeoutMs,
  resolveProxyMaxConcurrency,
  sharedProxyConcurrencyGate
} from "../src/lib/proxy-fetch";
import { dataSourceFetch } from "../src/lib/data-source-fetch";
import { __resetProxyUseLogForTests, getProxyUseSnapshot } from "../src/lib/proxy-use-log";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("resolveProxyMaxConcurrency", () => {
  it("defaults to 4 and honors a valid env override", () => {
    expect(resolveProxyMaxConcurrency({})).toBe(4);
    expect(resolveProxyMaxConcurrency({ PROXY_MAX_CONCURRENCY: "2" })).toBe(2);
    expect(resolveProxyMaxConcurrency({ PROXY_MAX_CONCURRENCY: "3.9" })).toBe(3);
  });
  it("falls back to the default on unset, invalid, or sub-1 values", () => {
    expect(resolveProxyMaxConcurrency({ PROXY_MAX_CONCURRENCY: "" })).toBe(4);
    expect(resolveProxyMaxConcurrency({ PROXY_MAX_CONCURRENCY: "abc" })).toBe(4);
    expect(resolveProxyMaxConcurrency({ PROXY_MAX_CONCURRENCY: "0" })).toBe(4);
    expect(resolveProxyMaxConcurrency({ PROXY_MAX_CONCURRENCY: "-2" })).toBe(4);
  });
});

describe("resolveProxyLegTimeoutMs", () => {
  it("defaults to the 15s PROXY_LEG_TIMEOUT_MS constant", () => {
    expect(PROXY_LEG_TIMEOUT_MS).toBe(15_000);
    expect(resolveProxyLegTimeoutMs({})).toBe(15_000);
  });
  it("honors a valid env override, including 0 (cap disabled)", () => {
    expect(resolveProxyLegTimeoutMs({ RESIDENTIAL_PROXY_LEG_TIMEOUT_MS: "9000" })).toBe(9_000);
    expect(resolveProxyLegTimeoutMs({ RESIDENTIAL_PROXY_LEG_TIMEOUT_MS: "0" })).toBe(0);
  });
  it("falls back to the default on invalid values", () => {
    expect(resolveProxyLegTimeoutMs({ RESIDENTIAL_PROXY_LEG_TIMEOUT_MS: "abc" })).toBe(15_000);
    expect(resolveProxyLegTimeoutMs({ RESIDENTIAL_PROXY_LEG_TIMEOUT_MS: "-5" })).toBe(15_000);
  });
});

describe("ProxyConcurrencyGate", () => {
  it("caps in-flight holders and admits waiters in FIFO order", async () => {
    const gate = new ProxyConcurrencyGate(() => 1);
    const order: string[] = [];
    const first = await gate.acquire();
    const p2 = gate.acquire().then((slot) => {
      order.push("second");
      return slot;
    });
    const p3 = gate.acquire().then((slot) => {
      order.push("third");
      return slot;
    });
    expect(gate.inFlight).toBe(1);
    expect(gate.queued).toBe(2);
    first.release();
    const second = await p2;
    expect(order).toEqual(["second"]);
    expect(gate.inFlight).toBe(1);
    second.release();
    const third = await p3;
    expect(order).toEqual(["second", "third"]);
    third.release();
    expect(gate.inFlight).toBe(0);
  });

  it("never exceeds the cap under parallel load", async () => {
    const gate = new ProxyConcurrencyGate(() => 2);
    let maxSeen = 0;
    await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const slot = await gate.acquire();
        maxSeen = Math.max(maxSeen, gate.inFlight);
        await sleep(10 + (i % 3) * 10);
        slot.release();
      })
    );
    expect(maxSeen).toBe(2);
    expect(gate.inFlight).toBe(0);
  });

  it("reports the queue wait on the granted slot", async () => {
    const gate = new ProxyConcurrencyGate(() => 1);
    const held = await gate.acquire();
    // Immediate grant still crosses a Date.now() boundary on loaded CI hosts (1ms is normal).
    expect(held.waitMs).toBeLessThan(5);
    const waiting = gate.acquire();
    await sleep(70);
    held.release();
    const slot = await waiting;
    expect(slot.waitMs).toBeGreaterThanOrEqual(40);
    slot.release();
  });

  it("rejects a waiter whose signal aborts while queued and frees its place", async () => {
    const gate = new ProxyConcurrencyGate(() => 1);
    const held = await gate.acquire();
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    expect(gate.queued).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(gate.queued).toBe(0);
    held.release();
    // The aborted waiter must not consume the freed slot.
    const next = await gate.acquire();
    expect(gate.inFlight).toBe(1);
    next.release();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const gate = new ProxyConcurrencyGate(() => 1);
    const controller = new AbortController();
    controller.abort();
    await expect(gate.acquire(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(gate.inFlight).toBe(0);
    expect(gate.queued).toBe(0);
  });

  it("release is idempotent — a double release admits no extra waiter", async () => {
    const gate = new ProxyConcurrencyGate(() => 1);
    const first = await gate.acquire();
    const p2 = gate.acquire();
    first.release();
    first.release();
    const second = await p2;
    const p3 = gate.acquire();
    await sleep(20);
    expect(gate.inFlight).toBe(1);
    expect(gate.queued).toBe(1);
    second.release();
    const third = await p3;
    third.release();
    expect(gate.inFlight).toBe(0);
  });
});

describe("ProxyConcurrencyGate priority lane (ST-3999 screener starvation)", () => {
  it("grants a priority waiter ahead of queued normal waiters, keeping normal FIFO", async () => {
    const gate = new ProxyConcurrencyGate(() => 1);
    const held = await gate.acquire();
    // Occupy the reserved slot too so the priority waiter genuinely queues.
    const heldPriority = await gate.acquire(undefined, { priority: true });
    const order: string[] = [];
    const pN1 = gate.acquire().then((slot) => {
      order.push("n1");
      return slot;
    });
    const pN2 = gate.acquire().then((slot) => {
      order.push("n2");
      return slot;
    });
    const pP = gate.acquire(undefined, { priority: true }).then((slot) => {
      order.push("p");
      return slot;
    });
    expect(gate.queued).toBe(3);
    held.release();
    const p = await pP;
    expect(order).toEqual(["p"]);
    p.release();
    heldPriority.release();
    const n1 = await pN1;
    expect(order).toEqual(["p", "n1"]);
    n1.release();
    const n2 = await pN2;
    expect(order).toEqual(["p", "n1", "n2"]);
    n2.release();
    expect(gate.inFlight).toBe(0);
    expect(gate.queued).toBe(0);
  });

  it("grants priority the reserved slot above the cap while normal waiters keep waiting", async () => {
    const gate = new ProxyConcurrencyGate(() => 2);
    const a = await gate.acquire();
    const b = await gate.acquire();
    expect(gate.inFlight).toBe(2);

    // Cap is full, but the priority waiter takes the reserved extra slot at once.
    const p = await gate.acquire(undefined, { priority: true });
    expect(gate.inFlight).toBe(3);

    // A normal waiter queued now must NOT take a slot while inFlight >= cap …
    let normalGranted = false;
    const pN = gate.acquire().then((slot) => {
      normalGranted = true;
      return slot;
    });
    await sleep(20);
    expect(normalGranted).toBe(false);
    expect(gate.queued).toBe(1);

    // … and a second priority waiter queues once the reserved slot is taken.
    let p2Granted = false;
    const pP2 = gate.acquire(undefined, { priority: true }).then((slot) => {
      p2Granted = true;
      return slot;
    });
    await sleep(20);
    expect(p2Granted).toBe(false);
    expect(gate.queued).toBe(2);

    // A freed normal slot goes to the queued priority waiter first (2 < 2+1).
    b.release();
    const p2 = await pP2;
    expect(p2Granted).toBe(true);
    expect(gate.inFlight).toBe(3);
    expect(gate.queued).toBe(1);

    // Freeing another normal slot still does not admit the normal waiter:
    // inFlight (2) is at cap, and the reserved slot is priority-only.
    a.release();
    await sleep(20);
    expect(normalGranted).toBe(false);
    expect(gate.queued).toBe(1);
    expect(gate.inFlight).toBe(2);

    // Only when a priority holder releases below cap does the normal proceed.
    p.release();
    const n = await pN;
    expect(normalGranted).toBe(true);
    p2.release();
    n.release();
    expect(gate.inFlight).toBe(0);
    expect(gate.queued).toBe(0);
  });

  it("caps priority holders at cap+1 under parallel load", async () => {
    const gate = new ProxyConcurrencyGate(() => 1);
    let maxSeen = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const slot = await gate.acquire(undefined, { priority: true });
        maxSeen = Math.max(maxSeen, gate.inFlight);
        await sleep(10);
        slot.release();
      })
    );
    expect(maxSeen).toBe(2);
    expect(gate.inFlight).toBe(0);
  });

  it("rejects a priority waiter whose signal aborts while queued", async () => {
    const gate = new ProxyConcurrencyGate(() => 1);
    const held = await gate.acquire();
    // Occupy the reserved slot too so the priority waiter genuinely queues.
    const reserved = await gate.acquire(undefined, { priority: true });
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal, { priority: true });
    expect(gate.queued).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(gate.queued).toBe(0);
    reserved.release();
    held.release();
    const next = await gate.acquire(undefined, { priority: true });
    expect(gate.inFlight).toBe(1);
    next.release();
  });
});

describe("createProxiedFetch concurrency gate", () => {
  const savedCap = process.env.PROXY_MAX_CONCURRENCY;

  beforeEach(() => {
    __resetProxyFetchForTests();
  });

  afterEach(() => {
    if (savedCap === undefined) delete process.env.PROXY_MAX_CONCURRENCY;
    else process.env.PROXY_MAX_CONCURRENCY = savedCap;
    __resetProxyFetchForTests();
  });

  it("queue wait does not count against the proxy-leg timeout", async () => {
    process.env.PROXY_MAX_CONCURRENCY = "1";
    // First request: headers return at once, but its body stays open until
    // the test closes it — the gate slot is held for exactly that long.
    let closeBody!: () => void;
    const bodyA = new ReadableStream<Uint8Array>({
      start(controller) {
        closeBody = () => {
          controller.enqueue(new TextEncoder().encode("a"));
          controller.close();
        };
      }
    });
    const holdingFetch = createProxiedFetch(
      "http://proxy-a.test:8888",
      (async () => new Response(bodyA, { status: 200 })) as typeof fetch,
      { proxyTimeoutMs: 30_000 }
    );
    const waits: number[] = [];
    const queuedFetch = createProxiedFetch(
      "http://proxy-b.test:8888",
      (async () => new Response("b", { status: 200 })) as typeof fetch,
      {
        proxyTimeoutMs: 150,
        onQueueWait: (ms) => {
          waits.push(ms);
        }
      }
    );

    const resA = await holdingFetch("https://example.test/a");
    expect(sharedProxyConcurrencyGate.inFlight).toBe(1);
    const pB = queuedFetch("https://example.test/b");
    // Queued for well past the second request's 150ms leg timeout. If the
    // leg timer started at call time instead of at slot grant, this request
    // would already be aborted.
    await sleep(300);
    expect(sharedProxyConcurrencyGate.queued).toBe(1);
    closeBody();
    await expect(resA.text()).resolves.toBe("a");
    const resB = await pB;
    expect(resB.status).toBe(200);
    await expect(resB.text()).resolves.toBe("b");
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThanOrEqual(200);
    expect(sharedProxyConcurrencyGate.inFlight).toBe(0);
  });

  it("does not report a queue wait when a slot is granted immediately", async () => {
    const waits: number[] = [];
    const proxied = createProxiedFetch(
      "http://proxy-c.test:8888",
      (async () => new Response("ok", { status: 200 })) as typeof fetch,
      {
        proxyTimeoutMs: 5_000,
        onQueueWait: (ms) => {
          waits.push(ms);
        }
      }
    );
    const res = await proxied("https://example.test/x");
    await expect(res.text()).resolves.toBe("ok");
    expect(waits).toEqual([]);
  });
});

/**
 * Minimal forward-proxy stand-in: undici's ProxyAgent sends absolute-form
 * requests for http:// targets, so a plain HTTP server that answers 200
 * after a per-request delay exercises the real egress path end to end.
 */
function startProxyServer(delayFor: (requestNumber: number) => number): Promise<{ server: Server; url: string }> {
  let count = 0;
  const server = createServer((_req, res) => {
    count += 1;
    const delay = delayFor(count);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("proxied");
    }, delay);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("dataSourceFetch proxy pacing (local proxy server)", () => {
  const savedCap = process.env.PROXY_MAX_CONCURRENCY;
  let server: Server | undefined;

  beforeEach(() => {
    __resetProxyFetchForTests();
    __resetProxyUseLogForTests();
  });

  afterEach(async () => {
    if (savedCap === undefined) delete process.env.PROXY_MAX_CONCURRENCY;
    else process.env.PROXY_MAX_CONCURRENCY = savedCap;
    __resetProxyFetchForTests();
    __resetProxyUseLogForTests();
    if (server) {
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    }
  });

  it("serializes bursts through the cap and logs the queue wait on the proxied entry", async () => {
    const started = await startProxyServer((n) => (n === 1 ? 150 : 0));
    server = started.server;
    process.env.PROXY_MAX_CONCURRENCY = "1";
    const deps = {
      env: { RESIDENTIAL_PROXY_URL: started.url },
      resolveUserProxyFn: () => undefined,
      directFetch: (async () => {
        throw new Error("direct egress must not be used in this test");
      }) as typeof fetch
    };
    const read = async (p: Promise<Response>) => {
      const res = await p;
      return res.text();
    };
    const [a, b] = await Promise.all([
      read(dataSourceFetch("http://data.example.test/a", undefined, {}, deps)),
      read(dataSourceFetch("http://data.example.test/b", undefined, {}, deps))
    ]);
    expect(a).toBe("proxied");
    expect(b).toBe("proxied");
    const snapshot = getProxyUseSnapshot();
    expect(snapshot.lastHour.proxied).toBe(2);
    expect(snapshot.lastHour.fallbacks).toBe(0);
    // The second request recorded last: it queued behind the first request's
    // 150ms leg, so its entry carries the queue wait.
    expect(snapshot.latest?.usedProxy).toBe(true);
    expect(snapshot.latest?.queueWaitMs).toBeGreaterThanOrEqual(75);
  });

  it("RESIDENTIAL_PROXY_LEG_TIMEOUT_MS bounds the leg and fail_soft falls back to direct", async () => {
    const started = await startProxyServer(() => 250);
    server = started.server;
    let directCalls = 0;
    const deps = {
      env: {
        RESIDENTIAL_PROXY_URL: started.url,
        RESIDENTIAL_PROXY_LEG_TIMEOUT_MS: "50"
      },
      resolveUserProxyFn: () => undefined,
      directFetch: (async () => {
        directCalls += 1;
        return new Response("direct", { status: 200 });
      }) as typeof fetch
    };
    const res = await dataSourceFetch("http://data.example.test/x", undefined, {}, deps);
    await expect(res.text()).resolves.toBe("direct");
    expect(directCalls).toBe(1);
    expect(getProxyUseSnapshot().lastHour.fallbacks).toBe(1);
  });
});
