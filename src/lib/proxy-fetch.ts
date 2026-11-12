/**
 * src/lib/proxy-fetch.ts
 *
 * Residential-proxy egress for market-data/provider traffic. This is a
 * Node/undici port of Congress.Trade's app/src/shared/proxyFetch.ts (Deno),
 * mirroring its env contract so both apps are operated the same way:
 *
 *   RESIDENTIAL_PROXY_URL        full proxy URL, e.g. http://10.99.0.2:8888.
 *                                The sentinels "off" / "none" / "direct" disable
 *                                proxying entirely, including the default fallback.
 *   RESIDENTIAL_PROXY_HOST / _PORT / _USERNAME / _PASSWORD / _PROTOCOL
 *                                same thing as parts (CT formatProxyUrl parity).
 *   HTTPS_PROXY / HTTP_PROXY     honored as a last env fallback, same as CT.
 *   RESIDENTIAL_PROXY_FAILURE_MODE
 *                                "fail_soft" (default) | "fail_closed" — see
 *                                data-source-fetch.ts for exact semantics.
 *   PROXY_MAX_CONCURRENCY      cap on proxied requests in flight at once
 *                                across the whole process (default 4) — the
 *                                Mango pacing gate in createProxiedFetch.
 *   RESIDENTIAL_PROXY_LEG_TIMEOUT_MS
 *                                per-leg timeout for proxied requests with no
 *                                caller AbortSignal (default 15000; 0 disables
 *                                the cap, leaving the caller signal as the
 *                                only deadline when there is one).
 *
 * As in CT, when nothing is configured the effective default is the GL.iNet
 * Mango HTTP CONNECT proxy on the WireGuard mesh (http://10.99.0.2:8888), so a
 * missed env var cannot silently run provider traffic from the datacenter IP
 * that upstream anti-bot filters are blocking. Diagnostics pass
 * { allowDefault: false } to tell "operator configured" apart from "defaulted"
 * (with the default in place, a naive "configured" check is unconditionally
 * true and a missed env var becomes undetectable — the trap CT documented).
 *
 * Unlike CT (Deno.createHttpClient), proxied requests here go through undici's
 * ProxyAgent. Proxied calls use undici's own fetch rather than the global
 * (Next-patched) fetch: Next's patched fetch is not guaranteed to forward a
 * per-request `dispatcher`, and these call sites are all server-side,
 * cache:"no-store" provider traffic.
 */

import "server-only";
import { ProxyAgent, fetch as undiciFetch } from "undici";

/** Canonical residential proxy URL — same Mango/WireGuard default CT uses.
 *  Reachable only from the Coolify host's WireGuard interface. */
export const DEFAULT_RESIDENTIAL_PROXY_URL = "http://10.99.0.2:8888";

/** Sentinel values that explicitly disable proxying (env-level kill switch). */
const PROXY_OFF_SENTINELS = new Set(["off", "none", "direct"]);

export type ProxyFailureMode = "fail_soft" | "fail_closed";

export function isProxyOffSentinel(value: string | undefined): boolean {
  return value !== undefined && PROXY_OFF_SENTINELS.has(value.trim().toLowerCase());
}

/**
 * Formats host, port, username, and password into a standard HTTP proxy URL.
 * (Same shape as CT's formatProxyUrl.)
 */
export function formatProxyUrl(opts: {
  host?: string;
  port?: string | number;
  username?: string;
  password?: string;
  protocol?: string;
}): string | undefined {
  if (!opts.host) return undefined;
  const portStr = opts.port ? `:${opts.port}` : "";
  const proto = opts.protocol ? opts.protocol.replace(/:$/, "") : "http";
  const auth =
    opts.username && opts.password
      ? `${encodeURIComponent(opts.username)}:${encodeURIComponent(opts.password)}@`
      : "";
  return `${proto}://${auth}${opts.host.trim()}${portStr}`;
}

export interface ResidentialProxyEnv {
  RESIDENTIAL_PROXY_URL?: string;
  RESIDENTIAL_PROXY_FAILURE_MODE?: string;
  PROXY_MAX_CONCURRENCY?: string;
  RESIDENTIAL_PROXY_LEG_TIMEOUT_MS?: string;
  RESIDENTIAL_PROXY_HOST?: string;
  RESIDENTIAL_PROXY_PORT?: string | number;
  RESIDENTIAL_PROXY_USERNAME?: string;
  RESIDENTIAL_PROXY_PASSWORD?: string;
  RESIDENTIAL_PROXY_PROTOCOL?: string;
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
}

/**
 * The env source these resolvers accept: an explicit literal (tests, DI) or
 * process.env itself. process.env is NodeJS.ProcessEnv, an index-signature
 * type, and TypeScript's weak-type check rejects it against ResidentialProxyEnv
 * (every property optional) because the two share no declared properties — even
 * though every key ResidentialProxyEnv declares is satisfied by ProcessEnv's
 * `string | undefined` values, and RESIDENTIAL_PROXY_PORT stays `string | number`
 * because formatProxyUrl accepts both.
 *
 * Naming both sides in a union states the real contract instead of casting
 * through `unknown`, and keeps the declared keys strictly typed: adding an index
 * signature to ResidentialProxyEnv would have compiled too, but it would also
 * admit a typo'd key (RESIDENTIAL_PROXY_UR:), and a silently missed env var is
 * the exact failure this module's default-fallback design exists to prevent.
 */
export type ProxyEnvSource = ResidentialProxyEnv | NodeJS.ProcessEnv;

function readEnv(env?: ProxyEnvSource): ProxyEnvSource {
  return env ?? process.env;
}

/**
 * Resolve the effective residential proxy URL.
 *
 * Precedence (mirrors CT's resolveResidentialProxyUrl):
 *   1. RESIDENTIAL_PROXY_URL (full URL, or an off-sentinel)
 *   2. RESIDENTIAL_PROXY_HOST (+ _PORT/_USERNAME/_PASSWORD/_PROTOCOL)
 *   3. HTTPS_PROXY / HTTP_PROXY
 *   4. DEFAULT_RESIDENTIAL_PROXY_URL, unless opts.allowDefault === false
 *
 * Returns undefined when proxying is disabled via an off-sentinel, or when
 * nothing is configured and allowDefault === false (the diagnostics shape).
 */
export function resolveResidentialProxyUrl(
  env?: ProxyEnvSource,
  opts?: { allowDefault?: boolean }
): string | undefined {
  const source = readEnv(env);

  const direct = source.RESIDENTIAL_PROXY_URL?.trim();
  if (direct) {
    if (isProxyOffSentinel(direct)) return undefined;
    return direct;
  }

  const host = source.RESIDENTIAL_PROXY_HOST?.trim();
  if (host) {
    return formatProxyUrl({
      host,
      port: source.RESIDENTIAL_PROXY_PORT,
      username: source.RESIDENTIAL_PROXY_USERNAME?.trim() || undefined,
      password: source.RESIDENTIAL_PROXY_PASSWORD || undefined,
      protocol: source.RESIDENTIAL_PROXY_PROTOCOL?.trim() || undefined
    });
  }

  const legacy = source.HTTPS_PROXY?.trim() || source.HTTP_PROXY?.trim();
  if (legacy) {
    if (isProxyOffSentinel(legacy)) return undefined;
    return legacy;
  }

  if (opts?.allowDefault === false) return undefined;
  return DEFAULT_RESIDENTIAL_PROXY_URL;
}

/** Resolve the proxy failure mode from env; default fail_soft (CT parity). */
export function resolveProxyFailureMode(env?: ProxyEnvSource): ProxyFailureMode {
  const raw = (env ?? process.env).RESIDENTIAL_PROXY_FAILURE_MODE?.trim().toLowerCase();
  return raw === "fail_closed" ? "fail_closed" : "fail_soft";
}

/** Default cap on proxied requests in flight at once, process-wide. */
export const DEFAULT_PROXY_MAX_CONCURRENCY = 4;

/**
 * Resolve the proxy-wide in-flight cap: PROXY_MAX_CONCURRENCY wins when it
 * parses to an integer >= 1; anything else falls back to the default.  The
 * cap is deliberately small: every proxied request funnels through the one
 * tinyproxy on the Mango, and the provider cascade dispatches concurrent
 * waves (Promise.all across providers in data-providers.ts) that otherwise
 * arrive at that single-threaded-ish proxy all at once.
 */
export function resolveProxyMaxConcurrency(env?: ProxyEnvSource): number {
  const raw = (env ?? process.env).PROXY_MAX_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PROXY_MAX_CONCURRENCY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_PROXY_MAX_CONCURRENCY;
}

/** A granted concurrency slot.  `release` returns it; extra calls are no-ops. */
export interface ProxySlot {
  /** Milliseconds spent queued before the slot was granted (0 when immediate). */
  waitMs: number;
  release(): void;
}

/**
 * Hard cap on how long a proxied body may hold a gate slot after headers.
 * Callers that never read or cancel (non-ok, 401/403, 429 retry) used to
 * leak the slot for the life of the process.  Four leaks filled the cap.
 */
export const PROXY_SLOT_MAX_HOLD_MS = 20_000;

/**
 * Release a slot when the body has no in-flight read and no new bytes for
 * this long.  An active `pull` (consumer waiting on the upstream) is not
 * idle; the max-hold timer is the cap for that case.
 */
export const PROXY_SLOT_IDLE_MS = 20_000;

export { PROXY_GATE_HOLD_ALERT_MS } from "./proxy-gate-alert";

export interface ProxyGateSnapshot {
  inFlight: number;
  queued: number;
  oldestHoldMs: number;
}

interface ProxyHold {
  grantedAt: number;
}

interface ProxyGateWaiter {
  enqueuedAt: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve(slot: ProxySlot): void;
  reject(err: unknown): void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}

/**
 * FIFO concurrency gate for proxied requests — the proxy-wide counterpart of
 * the per-provider pacers in provider-rate-limit.ts.  Per-provider pacing
 * spaces one provider's dispatches, but nothing capped the TOTAL number of
 * proxied requests in flight when several providers fire at once; this gate
 * is that cap.  A caller whose signal aborts while it is still queued is
 * removed from the queue and rejected with the abort reason, so a cascade
 * lane that already gave up never consumes a slot later.
 *
 * Production code uses the module-level shared instance below; tests
 * construct their own with a fixed cap resolver.
 */
export class ProxyConcurrencyGate {
  private inFlightCount = 0;
  private readonly queue: ProxyGateWaiter[] = [];
  private readonly holds: ProxyHold[] = [];

  constructor(private readonly resolveMaxConcurrency: () => number) {}

  /** Proxied requests currently holding a slot. */
  get inFlight(): number {
    return this.inFlightCount;
  }

  /** Callers currently waiting for a slot. */
  get queued(): number {
    return this.queue.length;
  }

  /** Age of the oldest granted slot, or 0 when nothing is in flight. */
  get oldestHoldMs(): number {
    if (this.holds.length === 0) return 0;
    let oldest = this.holds[0].grantedAt;
    for (const hold of this.holds) {
      if (hold.grantedAt < oldest) oldest = hold.grantedAt;
    }
    return Math.max(0, Date.now() - oldest);
  }

  acquire(signal?: AbortSignal): Promise<ProxySlot> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<ProxySlot>((resolve, reject) => {
      const waiter: ProxyGateWaiter = { enqueuedAt: Date.now(), signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const idx = this.queue.indexOf(waiter);
          if (idx === -1) return; // already granted; the fetch's own signal handling applies
          this.queue.splice(idx, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.pump();
    });
  }

  /** Test hook: reject every queued waiter and forget the in-flight count. */
  reset(): void {
    const waiters = this.queue.splice(0);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(new Error("proxy concurrency gate reset"));
    }
    this.inFlightCount = 0;
    this.holds.length = 0;
  }

  private pump(): void {
    while (this.queue.length > 0 && this.inFlightCount < this.resolveMaxConcurrency()) {
      const waiter = this.queue.shift();
      if (!waiter) break;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.inFlightCount += 1;
      const hold: ProxyHold = { grantedAt: Date.now() };
      this.holds.push(hold);
      const enqueuedAt = waiter.enqueuedAt;
      let released = false;
      waiter.resolve({
        waitMs: Math.max(0, Date.now() - enqueuedAt),
        release: () => {
          if (released) return;
          released = true;
          const idx = this.holds.indexOf(hold);
          if (idx !== -1) this.holds.splice(idx, 1);
          this.inFlightCount = Math.max(0, this.inFlightCount - 1);
          this.pump();
        }
      });
    }
  }
}

type ProxyGateHost = typeof globalThis & {
  __socraticProxyConcurrencyGate?: ProxyConcurrencyGate;
};

const gateHost = globalThis as ProxyGateHost;

/**
 * The shared gate every createProxiedFetch wrapper funnels through.  Pinned
 * on globalThis for the same reason as the proxy-use-log ring: Next.js can
 * bundle this module as separate instances in one process, and per-instance
 * gates would silently multiply the cap.
 */
export const sharedProxyConcurrencyGate: ProxyConcurrencyGate = (gateHost.__socraticProxyConcurrencyGate ??=
  new ProxyConcurrencyGate(() => resolveProxyMaxConcurrency()));

/** Live gate counters for `/api/proxy-use`. Never throws. */
export function proxyGateSnapshot(): ProxyGateSnapshot {
  return {
    inFlight: sharedProxyConcurrencyGate.inFlight,
    queued: sharedProxyConcurrencyGate.queued,
    oldestHoldMs: sharedProxyConcurrencyGate.oldestHoldMs
  };
}

const agentCache = new Map<string, ProxyAgent>();

/** Cached undici ProxyAgent per proxy URL (mirrors CT's cached Deno clients). */
export function getProxyAgent(proxyUrl: string): ProxyAgent {
  const cleanUrl = proxyUrl.trim();
  let agent = agentCache.get(cleanUrl);
  if (!agent) {
    agent = new ProxyAgent({ uri: cleanUrl });
    agentCache.set(cleanUrl, agent);
  }
  return agent;
}

/**
 * Default safety cap (ms) for a proxied leg that has no caller AbortSignal.
 * dataSourceFetch applies it only in that case.  A caller-supplied signal is
 * the deadline.  A fixed 3s cap was aborting lanes that need 4-5s to headers
 * through a slow but working residential proxy, then duplicating the request
 * on direct egress, which anti-bot sources reject — residential latency runs
 * ~10s-class, so the default is now 15s (RESIDENTIAL_PROXY_LEG_TIMEOUT_MS
 * overrides).  FRED does not use this cap.  It is excluded and goes direct.
 * 0 disables the per-leg timeout (caller signal only).
 */
export const PROXY_LEG_TIMEOUT_MS = 15000;

/**
 * Resolve the effective per-leg timeout: RESIDENTIAL_PROXY_LEG_TIMEOUT_MS
 * wins when it parses to a finite number >= 0 (0 = no per-leg cap); anything
 * else falls back to PROXY_LEG_TIMEOUT_MS.
 */
export function resolveProxyLegTimeoutMs(env?: ProxyEnvSource): number {
  const raw = (env ?? process.env).RESIDENTIAL_PROXY_LEG_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return PROXY_LEG_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : PROXY_LEG_TIMEOUT_MS;
}

interface BodyHoldLimits {
  maxHoldMs: number;
  idleMs: number;
}

function holdMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const bodyReleaseRegistry = new FinalizationRegistry<() => void>((release) => {
  try {
    release();
  } catch {
    // The GC backstop must not surface into the process.
  }
});

/**
 * Wrap a response body so `onSettle` fires exactly once when the body
 * finishes, errors, is cancelled by the reader, the settle signal aborts,
 * the body goes idle, or the post-header max hold elapses.  fetch()
 * resolves at headers while the body is still an open stream through the
 * proxy, so anything held for the life of the request (the leg timer, a
 * concurrency slot) must release here, not at headers — releasing at
 * headers left res.json() without cancellation and let a header-then-stall
 * proxy hang past the caller budget, including long-lived cascade reads.
 *
 * `settleSignal` is the signal whose abort settles the body wait even when
 * the upstream never delivers another chunk and never errors: the caller's
 * own signal on the untimed path, and the combined leg-timeout + caller
 * signal on the timed path, so a header-then-stall body cannot hold its
 * slot past the leg timeout just because the caller has budget left.
 *
 * Idle and max-hold do not depend on the caller reading or cancelling.
 * An unread non-ok body used to pin its slot until process restart.
 * FinalizationRegistry releases the slot if the response is collected
 * first. It does not error a stream that still has a reader.
 *
 * A max hold that has already delivered a chunk releases the gate slot
 * and leaves the stream up, so a slow download is not aborted at 20s.
 * That release does not clear the idle timer, and on the timed path it
 * does not clear the proxy-leg timer. Both stay armed until the stream
 * closes, so a later stall is still abandoned. A max hold that has
 * delivered nothing, and an idle body with no read in progress, cancel
 * the upstream and error the stream. That is the unread or stalled leak.
 *
 * `onBodySettled` runs once when the stream finishes, errors, is
 * cancelled, or is collected with no read in progress. It clears the
 * leg timer and releases the slot. `onSlotRelease` runs earlier when a
 * progressing body hits max hold. It releases only the gate slot.
 */
function wrapBodyUntilSettle(
  res: Response,
  settleSignal: AbortSignal | undefined,
  onBodySettled: () => void,
  limits: BodyHoldLimits,
  onSlotRelease: () => void = onBodySettled
): Response {
  if (!res.body) {
    onBodySettled();
    return res;
  }
  let slotReleased = false;
  let streamClosed = false;
  let onBodyAbort: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let pullActive = false;
  let bytesSeen = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const unregisterToken = {};
  const clearHoldTimers = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (maxTimer !== undefined) clearTimeout(maxTimer);
    idleTimer = undefined;
    maxTimer = undefined;
  };
  const detachAbort = () => {
    if (onBodyAbort && settleSignal) settleSignal.removeEventListener("abort", onBodyAbort);
    onBodyAbort = undefined;
  };
  const clearMaxTimer = () => {
    if (maxTimer !== undefined) clearTimeout(maxTimer);
    maxTimer = undefined;
  };
  const releaseGateSlot = () => {
    if (slotReleased || streamClosed) return;
    slotReleased = true;
    clearMaxTimer();
    onSlotRelease();
  };
  const endStream = () => {
    if (streamClosed) return;
    streamClosed = true;
    slotReleased = true;
    detachAbort();
    clearHoldTimers();
    bodyReleaseRegistry.unregister(unregisterToken);
    onBodySettled();
  };
  const upstream = res.body.getReader();
  // Cancelling an already-errored upstream rejects with the stored error
  // (spec behavior for reader.cancel), and teardown here has no one able to
  // act on that rejection — the original error already reaches the consumer
  // through the wrapped stream.  Route every cancel through this helper so
  // it can never surface as an unhandled rejection.
  const cancelUpstream = (reason?: unknown): Promise<void> =>
    upstream.cancel(reason).catch(() => undefined);
  const errorStream = (err: unknown) => {
    try {
      streamController?.error(err);
    } catch {
      // already errored or cancelled
    }
  };
  const abandon = () => {
    if (streamClosed) return;
    endStream();
    errorStream(new DOMException("aborted", "AbortError"));
    void cancelUpstream(new DOMException("aborted", "AbortError"));
  };
  const armTimer = (ms: number, fn: () => void): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(fn, ms);
    if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
    return timer;
  };
  const armIdle = () => {
    if (streamClosed) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = armTimer(limits.idleMs, () => {
      idleTimer = undefined;
      if (streamClosed || pullActive) return;
      abandon();
    });
  };
  const wrappedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (settleSignal?.aborted) {
        endStream();
        controller.error(new DOMException("aborted", "AbortError"));
        void cancelUpstream();
        return;
      }
      if (settleSignal) {
        onBodyAbort = () => {
          if (streamClosed) return;
          endStream();
          errorStream(new DOMException("aborted", "AbortError"));
          void cancelUpstream();
        };
        settleSignal.addEventListener("abort", onBodyAbort, { once: true });
      }
    },
    async pull(controller) {
      pullActive = true;
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      if (settleSignal?.aborted || streamClosed) {
        pullActive = false;
        endStream();
        errorStream(new DOMException("aborted", "AbortError"));
        await cancelUpstream();
        return;
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await upstream.read();
      } catch (err) {
        // A rejected read (mid-body socket reset, the leg timer disturbing
        // the body) errors the wrapped stream for the consumer, but nothing
        // else settles the body: without endStream() here, onBodySettled never
        // fires and whatever the body holds — the gate slot, the leg timer —
        // leaks for the life of the process.
        pullActive = false;
        endStream();
        errorStream(err);
        return;
      }
      if (chunk.done) {
        pullActive = false;
        endStream();
        controller.close();
        return;
      }
      pullActive = false;
      bytesSeen = true;
      if (!streamClosed) armIdle();
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      pullActive = false;
      endStream();
      await cancelUpstream(reason);
    }
  }, { highWaterMark: 0 });
  const wrapped = new Response(wrappedBody, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers
  });
  if (!streamClosed) {
    maxTimer = armTimer(limits.maxHoldMs, () => {
      maxTimer = undefined;
      if (slotReleased || streamClosed) return;
      if (bytesSeen) {
        releaseGateSlot();
        armIdle();
        return;
      }
      abandon();
    });
    armIdle();
    bodyReleaseRegistry.register(wrapped, () => {
      const reading = pullActive;
      if (!reading && !streamClosed) {
        endStream();
        void cancelUpstream(new DOMException("aborted", "AbortError"));
        return;
      }
      releaseGateSlot();
    }, unregisterToken);
  }
  return wrapped;
}

/**
 * Wrap a fetch function so requests egress through the given HTTP(S) proxy.
 * Returns baseFetch unchanged when no proxy URL is given (CT parity).
 *
 * Every call first takes a slot from the shared proxy concurrency gate
 * (PROXY_MAX_CONCURRENCY, default 4).  The slot is acquired BEFORE the
 * proxy-leg timer below is created, so time spent queued for a slot never
 * counts against the leg timeout.  The slot is held until the response body
 * settles, the body goes idle, or the post-header max hold elapses, and it
 * is released on error.  A caller abort while queued rejects before anything
 * is dispatched.
 *
 * When `options.proxyTimeoutMs` is a positive number, the returned fetch
 * chains a fresh AbortController (the proxy-leg timeout) with the caller's
 * own signal.  Either side aborting cancels the in-flight proxied request.
 * The timer and the caller listener stay armed until the body settles.
 * fetch() resolves at headers, and releasing them there left res.json()
 * without cancellation.
 *
 * `options.onQueueWait` is called once with the milliseconds spent queued
 * for a slot, when that wait was measurable (> 0), so callers can tell queue
 * wait apart from leg time in their logs.
 */
export function createProxiedFetch(
  proxyUrl: string | undefined,
  baseFetch: typeof fetch = undiciFetch as unknown as typeof fetch,
  options?: {
    proxyTimeoutMs?: number;
    onQueueWait?: (waitMs: number) => void;
    /** Test override. Production uses PROXY_SLOT_MAX_HOLD_MS. */
    slotMaxHoldMs?: number;
    /** Test override. Production uses PROXY_SLOT_IDLE_MS. */
    slotIdleMs?: number;
  }
): typeof fetch {
  if (!proxyUrl || !proxyUrl.trim()) return baseFetch;
  const agent = getProxyAgent(proxyUrl);
  const proxyTimeoutMs = options?.proxyTimeoutMs;
  const holdLimits: BodyHoldLimits = {
    maxHoldMs: holdMs(options?.slotMaxHoldMs, PROXY_SLOT_MAX_HOLD_MS),
    idleMs: holdMs(options?.slotIdleMs, PROXY_SLOT_IDLE_MS)
  };
  return (async function proxiedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const callerSignal = init?.signal ?? undefined;
    // Gate first: the leg timer is only created after a slot is granted, so
    // queue wait never counts against the leg timeout.
    const slot = await sharedProxyConcurrencyGate.acquire(callerSignal);
    try {
      if (slot.waitMs > 0) options?.onQueueWait?.(slot.waitMs);
    } catch (err) {
      // A throwing queue-wait observer must not wedge the gate: the slot was
      // already granted, so release it before the error propagates.
      slot.release();
      throw err;
    }
    const withDispatcher = { ...(init ?? {}), dispatcher: agent } as RequestInit;
    if (!proxyTimeoutMs || proxyTimeoutMs <= 0) {
      try {
        const res = await baseFetch(input, withDispatcher);
        return wrapBodyUntilSettle(res, callerSignal, () => slot.release(), holdLimits, () => slot.release());
      } catch (err) {
        slot.release();
        throw err;
      }
    }
    const proxyController = new AbortController();
    const timeoutHandle = setTimeout(() => proxyController.abort(), proxyTimeoutMs);
    let onCallerAbort: (() => void) | undefined;
    if (callerSignal) {
      if (callerSignal.aborted) {
        proxyController.abort();
      } else {
        onCallerAbort = () => proxyController.abort();
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (onCallerAbort && callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
      slot.release();
    };
    try {
      const effectiveSignal =
        callerSignal && typeof AbortSignal !== "undefined" && "any" in AbortSignal
          ? AbortSignal.any([proxyController.signal, callerSignal])
          : proxyController.signal;
      const res = await baseFetch(input, { ...withDispatcher, signal: effectiveSignal });
      // The leg timer stays armed until the body settles. A max hold that
      // has already delivered a chunk releases only the gate slot, via the
      // last argument, and leaves this cleanup for stream close. The body
      // wait settles on the EFFECTIVE signal, not just the caller's: a
      // header-then-stall body that never errors on its own is still
      // released when the leg timeout fires, instead of holding its slot
      // until the (possibly much larger) caller budget runs out.
      return wrapBodyUntilSettle(res, effectiveSignal, cleanup, holdLimits, () => slot.release());
    } catch (err) {
      cleanup();
      throw err;
    }
  }) as typeof fetch;
}

export interface FetchCancelingErrorBodyOptions {
  /**
   * Keep a status >= 400 body for the caller to read. The default cancels
   * that body. This helper uses `fetchImpl` as given. It does not open the
   * residential proxy or take a gate slot by itself. `dataSourceFetch` does
   * not call it. An unread 5xx on that path is bounded by the gate.
   */
  readErrorBody?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch through `fetchImpl` (default global fetch) and cancel an unread
 * error body. Pass `readErrorBody` when the caller will consume a
 * status >= 400 payload. A 2xx/3xx body is left untouched.
 */
export async function fetchCancelingErrorBody(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: FetchCancelingErrorBodyOptions
): Promise<Response> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(input, init);
  if (response.status >= 400 && options?.readErrorBody !== true) {
    await response.body?.cancel().catch(() => undefined);
  }
  return response;
}

/**
 * Error codes that mean the PROXY LEG of a proxied request failed (the proxy
 * itself was unreachable or reset us). When tinyproxy is up but the upstream
 * is down/blocked, tinyproxy answers with an HTTP 502/503 response — that is a
 * response, not a throw, and is deliberately NOT treated as proxy-down (no
 * direct fallback would change the upstream's answer anyway, and falling back
 * would re-expose the datacenter IP for no benefit).
 */
export const PROXY_LEG_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ECONNRESET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET"
]);

/**
 * Error names that mean the PROXY LEG was aborted mid-flight — the proxy (or
 * an upstream hop through it) was slow enough that our own per-proxy-leg
 * timeout fired, OR the proxy connection was reset without a typed Node
 * `code` on the resulting DOMException. Without classifying these, the
 * `fail_soft` fallback in `dataSourceFetch` never engages and the caller
 * silently sees undefined for every series fetch (the regression that hit FRED
 * in production when the residential proxy stalled at ~10s while the FRED
 * call-site budget is 5s — see `fetchFredSeries`).
 *
 * A bare `Error("aborted")` has `name === "Error"` (NOT `"AbortError"`) and
 * is intentionally NOT matched here; only DOMException/TimeoutError-style
 * aborts (which carry the abort name as `.name`) qualify.
 */
const PROXY_LEG_ABORT_NAMES: ReadonlySet<string> = new Set([
  "AbortError"
]);

function errorChainValues<T>(
  err: unknown,
  pick: (e: unknown) => T | undefined,
  depth = 0
): T[] {
  if (depth > 4 || !(err instanceof Error)) return [];
  const values: T[] = [];
  const v = pick(err);
  if (v !== undefined) values.push(v);
  const cause = (err as { cause?: unknown }).cause;
  if (cause) values.push(...errorChainValues(cause, pick, depth + 1));
  return values;
}

function pickErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function pickErrorName(err: unknown): string | undefined {
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/** True when the thrown error indicates the proxy leg itself failed. */
export function isProxyLegError(err: unknown): boolean {
  const codes = errorChainValues(err, pickErrorCode);
  if (codes.some((code) => PROXY_LEG_ERROR_CODES.has(code))) return true;
  const names = errorChainValues(err, pickErrorName);
  return names.some((name) => PROXY_LEG_ABORT_NAMES.has(name));
}

// Rate-limited warn logging so a dead proxy does not spam one line per request.
const lastProxyWarnAt = new Map<string, number>();
const PROXY_WARN_INTERVAL_MS = 60_000;

export function warnProxyFallback(proxyUrl: string, err: unknown, now: number = Date.now()): void {
  const last = lastProxyWarnAt.get(proxyUrl) ?? 0;
  if (now - last < PROXY_WARN_INTERVAL_MS) return;
  lastProxyWarnAt.set(proxyUrl, now);
  const host = safeProxyHostForLog(proxyUrl);
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[data-source-proxy] residential proxy ${host} unreachable (${message}); ` +
      `fail_soft: falling back to direct egress for this request. ` +
      `Set RESIDENTIAL_PROXY_FAILURE_MODE=fail_closed to make this an error instead.`
  );
}

/** Host[:port] only — never log credentials embedded in a proxy URL. */
export function safeProxyHostForLog(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    return u.host;
  } catch {
    return "(unparseable proxy URL)";
  }
}

/**
 * TCP port for a proxy reachability probe.
 *
 * `URL.port` is empty when the URL omits a port and when the port is the
 * scheme default (`:443` on https, `:80` on http). Defaulting every empty
 * port to 80 makes an https proxy look unreachable.
 */
export function proxyProbePort(url: URL): number {
  if (url.port) {
    const parsed = Number(url.port);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return url.protocol === "https:" ? 443 : 80;
}

/** Test hook: drop cached agents + warn timestamps + gate state. */
export function __resetProxyFetchForTests(): void {
  agentCache.clear();
  lastProxyWarnAt.clear();
  sharedProxyConcurrencyGate.reset();
}
