import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderRateLimiter,
  RequestQuota,
  admitProviderRequests,
  appendErrorCause,
  redactApiKeyParams,
  redactSecretValue,
  refundProviderRequests,
  resetProviderQuotaState,
  resolveProviderLimiterConfig,
  resolveProviderLimiterConfigForCall,
  resolveProviderLimiterKey,
  resolveProviderQuota,
  scrubProviderErrorText,
  simulateProviderQuotaRestartForTests,
  type ProviderLimiterClock,
} from "../src/lib/provider-rate-limit";
import { flushDurableStateNow } from "../src/lib/durable-state";
import { getUsageMonitorKnobsCached, resetUsageMonitorKnobsCacheForTests } from "../src/lib/usage-monitor-knobs";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-provider-rate-limit-${randomUUID()}.db`)}`;
});

/** Drain every currently-queued microtask (including ones scheduled BY other microtasks
 *  along the way) before returning. A macrotask boundary (real setTimeout) always runs
 *  after the microtask queue is fully empty, so this is robust regardless of how many
 *  promise-chain hops a given continuation needs — unlike counting `await Promise.resolve()`
 *  calls, which is fragile and engine-dependent. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A clock whose `sleep` never resolves on its own — the test advances virtual time and
 *  manually resolves any sleeps whose deadline has passed. Keeps pacing tests instant and
 *  deterministic instead of waiting on real timers. */
class FakeClock implements ProviderLimiterClock {
  private currentTime = 0;
  private pending: Array<{ resolveAt: number; resolve: () => void }> = [];

  now(): number {
    return this.currentTime;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.pending.push({ resolveAt: this.currentTime + ms, resolve });
    });
  }

  /** Advance virtual time, resolve any sleeps whose deadline has now passed, and let the
   *  resulting continuation chain (pump() re-entrancy, etc.) fully settle. */
  async advance(ms: number): Promise<void> {
    this.currentTime += ms;
    const ready = this.pending.filter((p) => p.resolveAt <= this.currentTime);
    this.pending = this.pending.filter((p) => p.resolveAt > this.currentTime);
    for (const p of ready) p.resolve();
    await flushMicrotasks();
  }
}

const ENV_KEYS = [
  "PROVIDER_RATE_LIMIT_TESTPROV_PER_MIN",
  "PROVIDER_RATE_LIMIT_TESTPROV_MIN_INTERVAL_MS",
  "PROVIDER_RATE_LIMIT_TESTPROV_CONCURRENCY",
  "PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN",
  "PROVIDER_RATE_LIMIT_FINNHUB_MIN_INTERVAL_MS",
  "PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_MIN_INTERVAL_MS",
  "PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_CONCURRENCY",
];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("resolveProviderLimiterKey", () => {
  it("maps RapidAPI hostnames to per-host limiter buckets", () => {
    expect(
      resolveProviderLimiterKey("mboum-finance", "https://mboum-finance.p.rapidapi.com/v1/market/quotes")
    ).toBe("rapidapi-host:mboum-finance.p.rapidapi.com");
    expect(resolveProviderLimiterKey("finnhub", "https://finnhub.io/api/v1/quote")).toBe("finnhub");
  });

  it("applies rapidapi-host pacing defaults to derived host keys", () => {
    const config = resolveProviderLimiterConfig("rapidapi-host:example.p.rapidapi.com");
    expect(config).toEqual({ minIntervalMs: 1100, concurrency: 1 });
  });

  it("keeps alpha-vantage-rapidapi's 5/min cap on a RapidAPI host bucket", () => {
    const limiterKey = resolveProviderLimiterKey(
      "alpha-vantage-rapidapi",
      "https://alpha-vantage.p.rapidapi.com/query"
    );
    expect(limiterKey).toBe("rapidapi-host:alpha-vantage.p.rapidapi.com");
    expect(resolveProviderLimiterConfigForCall("alpha-vantage-rapidapi", limiterKey)).toEqual({
      minIntervalMs: Math.ceil(60_000 / 5),
      concurrency: 1
    });
  });

  it("uses the rapidapi-host default only when the service has no own cap", () => {
    expect(
      resolveProviderLimiterConfigForCall("unknown-rapidapi", "rapidapi-host:example.p.rapidapi.com")
    ).toEqual({ minIntervalMs: 1100, concurrency: 1 });
  });
});

describe("resolveProviderLimiterConfig", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("returns undefined (unlimited) for a provider with no hard default and no env override", () => {
    expect(resolveProviderLimiterConfig("some-random-provider")).toBeUndefined();
  });

  it("derives finnhub's hard default of 50/min into a ~1200ms interval with unbounded concurrency", () => {
    const config = resolveProviderLimiterConfig("finnhub");
    expect(config).toBeDefined();
    expect(config?.minIntervalMs).toBe(Math.ceil(60_000 / 50));
    expect(config?.concurrency).toBe(Infinity);
  });

  it("uses alpha-vantage's hard default of >=1100ms spacing and concurrency 1", () => {
    const config = resolveProviderLimiterConfig("alpha-vantage");
    expect(config).toEqual({ minIntervalMs: 1100, concurrency: 1 });
  });

  it("uses yahoo-finance's hard default of ~400ms spacing and concurrency 2", () => {
    const config = resolveProviderLimiterConfig("yahoo-finance");
    expect(config).toEqual({ minIntervalMs: 400, concurrency: 2 });
  });

  // twelvedata: a batch call costs 1 credit PER SYMBOL and the free tier is 8 credits/min. The real
  // budget control is in the provider (symbol cap + one-call-per-minute window gate that SKIPS
  // rather than queues); this pacer entry is only a light serialization backstop (concurrency 1,
  // short 2s spacing — NOT 60s, which would re-introduce the scan stall the gate avoids).
  it("uses twelvedata's hard default of a light serial backstop (concurrency 1, short spacing)", () => {
    const config = resolveProviderLimiterConfig("twelvedata");
    expect(config).toEqual({ minIntervalMs: 2_000, concurrency: 1 });
  });

  it("lets an env PER_MIN override win over a provider with no hard default", () => {
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_PER_MIN = "30";
    const config = resolveProviderLimiterConfig("testprov");
    expect(config?.minIntervalMs).toBe(2000); // 60000 / 30
    expect(config?.concurrency).toBe(Infinity);
  });

  it("lets an env PER_MIN override replace finnhub's hard default", () => {
    process.env.PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN = "30";
    const config = resolveProviderLimiterConfig("finnhub");
    expect(config?.minIntervalMs).toBe(2000);
  });

  it("prefers MIN_INTERVAL_MS over PER_MIN when both env vars are set", () => {
    process.env.PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN = "30";
    process.env.PROVIDER_RATE_LIMIT_FINNHUB_MIN_INTERVAL_MS = "777";
    const config = resolveProviderLimiterConfig("finnhub");
    expect(config?.minIntervalMs).toBe(777);
  });

  it("lets an env CONCURRENCY override replace a hard default's concurrency", () => {
    process.env.PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_CONCURRENCY = "3";
    const config = resolveProviderLimiterConfig("alpha-vantage");
    expect(config?.concurrency).toBe(3);
    expect(config?.minIntervalMs).toBe(1100); // untouched hard default
  });

  it("uppercases and normalizes non-alphanumeric characters into the env var name", () => {
    process.env.PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_MIN_INTERVAL_MS = "2500";
    expect(resolveProviderLimiterConfig("alpha-vantage")?.minIntervalMs).toBe(2500);
  });

  it("uses roic burst pacer (200ms, concurrency 1); free budget is RATE_QUOTAS 5/min", () => {
    // Free 5/min is enforced by quota windows, not a 12s minInterval (that would throttle paid).
    expect(resolveProviderLimiterConfig("roic")).toEqual({ minIntervalMs: 200, concurrency: 1 });
    expect(resolveProviderLimiterConfig("filingapi")).toEqual({ minIntervalMs: 400, concurrency: 1 });
  });
});

describe("ProviderRateLimiter pacing (fake clock)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("passes an unconfigured provider straight through with no delay", async () => {
    const clock = new FakeClock();
    const limiter = new ProviderRateLimiter(clock);
    let called = false;
    const result = await limiter.withLimit("unlimited-provider", async () => {
      called = true;
      return 42;
    });
    expect(called).toBe(true);
    expect(result).toBe(42);
  });

  it("spaces successive dispatches by at least minIntervalMs", async () => {
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_MIN_INTERVAL_MS = "100";
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_CONCURRENCY = "10"; // isolate pacing from concurrency
    const clock = new FakeClock();
    const limiter = new ProviderRateLimiter(clock);
    const dispatchTimes: number[] = [];

    const task = (n: number) =>
      limiter.withLimit("testprov", async () => {
        dispatchTimes.push(clock.now());
        return n;
      });

    const p1 = task(1);
    const p2 = task(2);
    const p3 = task(3);

    // First dispatch is immediate (no prior dispatch to space against).
    await flushMicrotasks();
    expect(dispatchTimes).toEqual([0]);

    // Advancing less than the interval must not admit the next waiter yet.
    await clock.advance(50);
    expect(dispatchTimes).toEqual([0]);

    // Crossing the interval boundary admits exactly the next one.
    await clock.advance(50);
    expect(dispatchTimes).toEqual([0, 100]);

    await clock.advance(100);
    expect(dispatchTimes).toEqual([0, 100, 200]);

    await Promise.all([p1, p2, p3]);
  });

  it("never runs more than `concurrency` tasks at once even with zero spacing", async () => {
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_MIN_INTERVAL_MS = "0";
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_CONCURRENCY = "2";
    const clock = new FakeClock();
    const limiter = new ProviderRateLimiter(clock);

    let inFlight = 0;
    let maxInFlight = 0;
    const releasers: Array<() => void> = [];

    const task = () =>
      limiter.withLimit("testprov", () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<void>((resolve) => {
          releasers.push(() => {
            inFlight--;
            resolve();
          });
        });
      });

    const results = [task(), task(), task(), task()];
    await flushMicrotasks();

    expect(maxInFlight).toBe(2); // never exceeds the configured concurrency cap
    expect(releasers.length).toBe(2); // only 2 admitted; the rest are queued

    // Release the first two — the queued pair should now be admitted.
    releasers[0]();
    releasers[1]();
    await flushMicrotasks();
    expect(releasers.length).toBe(4);

    releasers[2]();
    releasers[3]();
    await Promise.all(results);
    expect(maxInFlight).toBe(2);
  });

  it("reset() clears bookkeeping so a fresh call is treated as the first dispatch", async () => {
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_MIN_INTERVAL_MS = "1000";
    const clock = new FakeClock();
    const limiter = new ProviderRateLimiter(clock);

    await limiter.withLimit("testprov", async () => "first");
    limiter.reset("testprov");

    let called = false;
    // No advance() at all — if state weren't reset, this would hang waiting on the interval.
    const p = limiter.withLimit("testprov", async () => {
      called = true;
    });
    await flushMicrotasks();
    expect(called).toBe(true);
    await p;
  });
});

// Regression coverage for a real bug: every withProviderLimit call site in
// data-providers.ts used to create its AbortController and arm its HTTP-timeout
// setTimeout BEFORE calling withProviderLimit, i.e. before the request even joined the
// pacer's queue. That means queue wait counted against the HTTP timeout — with enough
// near-simultaneous callers paced well apart (e.g. Finnhub's ~1200ms spacing), every
// request dispatched after ~timeoutMs was already aborted the instant it ran (an
// AbortError storm), even though nothing was actually slow. The fix (applied to the
// finnhub/alpha-vantage/yahoo-finance call sites in src/lib/data-providers.ts) arms the
// controller/timeout INSIDE the function passed to withProviderLimit, so the clock only
// starts ticking once the pacer actually dispatches the call.
//
// These tests model both shapes against a simulated fetch (checks `signal.aborted`
// up front, exactly like the real Fetch API does for an already-aborted signal) to prove
// the fix's shape survives a queue wait longer than the request timeout, and that the
// buggy shape it replaced would NOT have survived it.
describe("queue wait must not consume the caller's request timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearEnv();
    delete process.env.PROVIDER_RATE_LIMIT_TESTPROVBUGGY_CONCURRENCY;
    delete process.env.PROVIDER_RATE_LIMIT_TESTPROVBUGGY_MIN_INTERVAL_MS;
  });

  /** Mimics a `fetch(url, { signal })` call: rejects immediately if the signal is ALREADY
   *  aborted (matching real Fetch API semantics for a pre-aborted signal), otherwise
   *  resolves after `delayMs` unless aborted first. */
  function simulatedFetch(signal: AbortSignal, delayMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      const done = setTimeout(() => resolve("ok"), delayMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(done);
          reject(new DOMException("The operation was aborted", "AbortError"));
        },
        { once: true }
      );
    });
  }

  it("FIXED shape: arming the abort timer INSIDE the limiter callback survives a queue wait longer than the timeout", async () => {
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_CONCURRENCY = "1";
    // Force the 2nd call to queue for 8s -- longer than its own 6s request timeout below.
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_MIN_INTERVAL_MS = "8000";
    // The pacer's own clock uses the SAME (faked) global timers as the abort timeout, so
    // vi.advanceTimersByTimeAsync moves both in lockstep, exactly like production where a
    // real setTimeout backs both the pacer's spacing and the caller's abort timer.
    const limiter = new ProviderRateLimiter({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });

    const correctRequest = (label: string) =>
      limiter.withLimit("testprov", async () => {
        // Controller + timeout created INSIDE the pacer callback -- armed at dispatch time.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        try {
          return await simulatedFetch(controller.signal, 100).then((v) => `${label}-${v}`);
        } finally {
          clearTimeout(timeout);
        }
      });

    const first = correctRequest("first");
    const second = correctRequest("second");

    // First dispatches immediately; its simulated 100ms fetch completes well inside its
    // own 6s timeout.
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toBe("first-ok");

    // Second was queued the whole time and only gets admitted once the 8s pacing interval
    // elapses -- LONGER than the 6s timeout it will arm once dispatched. Advancing past
    // that point must still resolve it successfully, because its timer didn't even exist
    // (let alone start counting) until this moment.
    await vi.advanceTimersByTimeAsync(8000);
    await expect(second).resolves.toBe("second-ok");
  });

  it("BUGGY shape (regression guard): arming the abort timer BEFORE enqueueing aborts once queue wait exceeds the timeout", async () => {
    process.env.PROVIDER_RATE_LIMIT_TESTPROVBUGGY_CONCURRENCY = "1";
    process.env.PROVIDER_RATE_LIMIT_TESTPROVBUGGY_MIN_INTERVAL_MS = "8000";
    const limiter = new ProviderRateLimiter({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });

    const buggyRequest = (label: string) => {
      // Controller + timeout created BEFORE calling withLimit -- the exact anti-pattern
      // this suite guards against. The clock starts ticking at ENQUEUE time.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      return limiter.withLimit("testprovbuggy", async () => {
        try {
          return await simulatedFetch(controller.signal, 100).then((v) => `${label}-${v}`);
        } finally {
          clearTimeout(timeout);
        }
      });
    };

    const first = buggyRequest("first");
    const second = buggyRequest("second");
    // Attach a rejection handler SYNCHRONOUSLY (same tick as creation) so this promise is
    // never observed as "unhandled" between the moment it rejects (deep inside the fake
    // timer/microtask machinery below) and the moment the assertion below awaits it --
    // that gap would otherwise trip Node's unhandledRejection detector as test noise.
    const secondSettled = second.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    );

    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toBe("first-ok");

    // By the time the pacer admits "second" (~8s in), its pre-armed 6s timer already fired
    // at ~6s, aborting a request that was still sitting in the queue and hadn't even been
    // dispatched yet -- reproducing the "instant AbortError storm" bug.
    await vi.advanceTimersByTimeAsync(8000);
    const result = await secondSettled;
    expect(result.ok).toBe(false);
    expect(result.ok === false && String(result.error)).toMatch(/aborted/i);
  });
});

describe("secret scrubbing", () => {
  it("redacts apikey=<value> query params regardless of casing", () => {
    const text = "GET https://example.com/query?function=X&apikey=SUPERSECRET123 failed"; // gitleaks:allow
    expect(redactApiKeyParams(text)).toBe("GET https://example.com/query?function=X&apikey=*** failed");
    expect(redactApiKeyParams("...&ApiKey=abc123&other=1")).toContain("ApiKey=***"); // gitleaks:allow
    expect(redactApiKeyParams("...&token=xyz")).toContain("token=***"); // gitleaks:allow
    expect(redactApiKeyParams("...&access_key=xyz")).toContain("access_key=***"); // gitleaks:allow
  });

  it("leaves text with no key-shaped query param untouched", () => {
    const text = "Alpha Vantage rate limit reached, please try again later";
    expect(redactApiKeyParams(text)).toBe(text);
  });

  it("redacts every literal occurrence of a known secret value", () => {
    // Deliberately NOT key-shaped: redactSecretValue matches the literal value, so any
    // string exercises it, and a realistic-looking fixture trips gitleaks' generic-api-key
    // rule (it flagged the previous "sk_live_"-prefixed value on PR #1087).
    const secret = "fixture-secret-value-123";
    const text = `Thank you for using our API! Your key ${secret} has exceeded the daily limit. Key: ${secret}`;
    const scrubbed = redactSecretValue(text, secret);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed.match(/\*\*\*/g)?.length).toBe(2);
  });

  it("redactSecretValue is a no-op when secret is undefined/empty", () => {
    expect(redactSecretValue("hello", undefined)).toBe("hello");
    expect(redactSecretValue("hello", "")).toBe("hello");
    expect(redactSecretValue("hello", null)).toBe("hello");
  });

  it("scrubProviderErrorText combines both: a literal key AND a query-param pattern", () => {
    const apiKey = "MYRAWKEY";
    const text = `Alpha Vantage API warning/error: please visit https://www.alphavantage.co/premium/?apikey=${apiKey} for a higher rate limit, key ${apiKey} used.`;
    const scrubbed = scrubProviderErrorText(text, apiKey);
    expect(scrubbed).not.toContain(apiKey);
    expect(scrubbed).toContain("apikey=***");
  });

  it("scrubProviderErrorText with no secret still redacts a generic apikey= param", () => {
    const text = "fetch failed for https://finnhub.io/api/v1/quote?symbol=AAPL&token=leaked-value";
    expect(scrubProviderErrorText(text)).toBe(
      "fetch failed for https://finnhub.io/api/v1/quote?symbol=AAPL&token=***"
    );
  });
});

describe("appendErrorCause", () => {
  it("appends a truncated err.cause when present", () => {
    const err = new Error("fetch failed", { cause: new Error("ECONNREFUSED 127.0.0.1:443") });
    const message = appendErrorCause("fetch failed", err);
    expect(message).toContain("fetch failed");
    expect(message).toContain("ECONNREFUSED");
  });

  it("returns the message unchanged when there is no cause", () => {
    const err = new Error("plain failure");
    expect(appendErrorCause("plain failure", err)).toBe("plain failure");
  });

  it("returns the message unchanged for a non-Error thrown value", () => {
    expect(appendErrorCause("some string", "not an error")).toBe("some string");
  });

  it("truncates an overly long cause to maxLen characters", () => {
    const longCause = "x".repeat(500);
    const err = new Error("boom", { cause: longCause });
    const message = appendErrorCause("boom", err, 20);
    // "boom (cause: " + 20 chars + ")"
    expect(message.length).toBe("boom (cause: )".length + 20);
    expect(message).toContain("x".repeat(20));
    expect(message).not.toContain("x".repeat(21));
  });
});

const QUOTA_ENV_KEYS = [
  "PROVIDER_QUOTA_TWELVEDATA_PER_MIN",
  "PROVIDER_QUOTA_TWELVEDATA_PER_DAY",
  "PROVIDER_QUOTA_TIINGO_PER_HOUR",
  "PROVIDER_QUOTA_TESTPROV_PER_MIN",
  "PROVIDER_QUOTA_TESTPROV_PER_DAY",
  "PROVIDER_QUOTA_FMP_PER_MIN",
  "PROVIDER_QUOTA_FMP_PER_HOUR",
  "PROVIDER_QUOTA_FMP_PER_DAY",
  "TWELVEDATA_CREDITS_PER_MIN",
  "PROVIDER_QUOTA_FILINGAPI_PER_DAY",
  "PROVIDER_QUOTA_ROIC_PER_DAY",
  "PROVIDER_QUOTA_MARKETSTACK_PER_DAY",
];

describe("resolveProviderQuota", () => {
  beforeEach(() => { for (const k of QUOTA_ENV_KEYS) delete process.env[k]; });
  afterEach(() => { for (const k of QUOTA_ENV_KEYS) delete process.env[k]; });

  it("returns the built-in twelvedata windows (8/min + 800/day)", () => {
    const windows = resolveProviderQuota("twelvedata");
    expect(windows).toEqual([
      { maxRequests: 8, windowMs: 60_000 },
      { maxRequests: 800, windowMs: 86_400_000 },
    ]);
  });

  it("returns the built-in tiingo windows (50/hour + 1000/day)", () => {
    expect(resolveProviderQuota("tiingo")).toEqual([
      { maxRequests: 50, windowMs: 3_600_000 },
      { maxRequests: 1000, windowMs: 86_400_000 },
    ]);
  });

  it("returns the built-in fmp window (290/min, no day cap by default)", () => {
    expect(resolveProviderQuota("fmp")).toEqual([
      { maxRequests: 290, windowMs: 60_000 },
    ]);
  });

  it("lets PROVIDER_QUOTA_FMP_PER_MIN REPLACE the minute cap and =0 REMOVE it", () => {
    process.env.PROVIDER_QUOTA_FMP_PER_MIN = "100";
    expect(resolveProviderQuota("fmp")).toEqual([{ maxRequests: 100, windowMs: 60_000 }]);
    process.env.PROVIDER_QUOTA_FMP_PER_MIN = "0";
    // Removing the only window leaves an empty list → unlimited (undefined).
    expect(resolveProviderQuota("fmp")).toBeUndefined();
  });

  it("lets PROVIDER_QUOTA_FMP_PER_DAY ADD a day window alongside the 290/min", () => {
    process.env.PROVIDER_QUOTA_FMP_PER_DAY = "240";
    expect(resolveProviderQuota("fmp")).toEqual([
      { maxRequests: 290, windowMs: 60_000 },
      { maxRequests: 240, windowMs: 86_400_000 },
    ]);
  });

  it("PROVIDER_QUOTA_FMP_PER_DAY=0 is a no-op (no day window in the base)", () => {
    process.env.PROVIDER_QUOTA_FMP_PER_DAY = "0";
    expect(resolveProviderQuota("fmp")).toEqual([{ maxRequests: 290, windowMs: 60_000 }]);
  });

  it("returns the built-in filingapi window (45/day)", () => {
    expect(resolveProviderQuota("filingapi")).toEqual([{ maxRequests: 45, windowMs: 86_400_000 }]);
  });

  it("returns the built-in roic free-safe window (5/min from vendor pricing)", () => {
    // Paid Individual = 300/min via Connections plan tier, not the hard default.
    expect(resolveProviderQuota("roic")).toEqual([{ maxRequests: 5, windowMs: 60_000 }]);
    expect(resolveProviderQuota("roic", "individual")).toEqual([{ maxRequests: 300, windowMs: 60_000 }]);
    expect(resolveProviderQuota("roic", "professional")).toBeUndefined(); // unlimited tier
  });

  it("returns the built-in marketstack window (100/month free tier)", () => {
    expect(resolveProviderQuota("marketstack")).toEqual([{ maxRequests: 100, windowMs: 30 * 86_400_000 }]);
  });

  it("lets PROVIDER_QUOTA_<NAME>_PER_DAY override or add day windows on the new defaults", () => {
    process.env.PROVIDER_QUOTA_FILINGAPI_PER_DAY = "10";
    expect(resolveProviderQuota("filingapi")).toEqual([{ maxRequests: 10, windowMs: 86_400_000 }]);
    // ROIC free default is per-minute; PER_DAY adds a second window rather than inventing a day-only map.
    process.env.PROVIDER_QUOTA_ROIC_PER_DAY = "999";
    expect(resolveProviderQuota("roic")).toEqual([
      { maxRequests: 5, windowMs: 60_000 },
      { maxRequests: 999, windowMs: 86_400_000 }
    ]);
    // Marketstack free default is monthly (30d); PER_DAY adds a day window alongside it.
    process.env.PROVIDER_QUOTA_MARKETSTACK_PER_DAY = "1";
    const ms = resolveProviderQuota("marketstack")!;
    expect(ms.find((w) => w.windowMs === 86_400_000)?.maxRequests).toBe(1);
    expect(ms.find((w) => w.windowMs === 30 * 86_400_000)?.maxRequests).toBe(100);
  });

  it("is undefined for an unconfigured provider (unlimited)", () => {
    expect(resolveProviderQuota("yahoo-finance")).toBeUndefined();
  });

  it("lets an env override REPLACE an existing window's cap", () => {
    process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN = "3";
    const windows = resolveProviderQuota("twelvedata");
    expect(windows?.find((w) => w.windowMs === 60_000)?.maxRequests).toBe(3);
    expect(windows?.find((w) => w.windowMs === 86_400_000)?.maxRequests).toBe(800); // untouched
  });

  it("lets an env override REMOVE a window when set to <= 0", () => {
    process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN = "0";
    const windows = resolveProviderQuota("twelvedata");
    expect(windows).toEqual([{ maxRequests: 800, windowMs: 86_400_000 }]); // only the daily cap remains
  });

  it("lets an env override ADD windows to an otherwise-unlimited provider", () => {
    process.env.PROVIDER_QUOTA_TESTPROV_PER_MIN = "3";
    process.env.PROVIDER_QUOTA_TESTPROV_PER_DAY = "5";
    expect(resolveProviderQuota("testprov")).toEqual([
      { maxRequests: 3, windowMs: 60_000 },
      { maxRequests: 5, windowMs: 86_400_000 },
    ]);
  });

  it("honors the legacy TWELVEDATA_CREDITS_PER_MIN as a per-minute alias when the new name is unset", () => {
    process.env.TWELVEDATA_CREDITS_PER_MIN = "20";
    expect(resolveProviderQuota("twelvedata")?.find((w) => w.windowMs === 60_000)?.maxRequests).toBe(20);
  });

  it("prefers the new PROVIDER_QUOTA_TWELVEDATA_PER_MIN over the legacy alias", () => {
    process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN = "12";
    process.env.TWELVEDATA_CREDITS_PER_MIN = "20";
    expect(resolveProviderQuota("twelvedata")?.find((w) => w.windowMs === 60_000)?.maxRequests).toBe(12);
  });
});

// ── Usage Monitor knob fallback (Lane E: subscription -> knob) ──────────────────────
// process.env still wins; a UM-sourced knob is consulted only when the corresponding env var is
// unset; the built-in HARD_DEFAULTS/RATE_QUOTAS default is the final fallback.
const UM_ENV_KEYS = [
  "USAGE_MONITOR_BASE_URL",
  "USAGE_INGEST_TOKEN",
  "USAGE_READ_TOKEN",
  "USAGE_MONITOR_KNOBS_ENABLED",
  "PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN",
  "PROVIDER_RATE_LIMIT_FINNHUB_MIN_INTERVAL_MS",
  "PROVIDER_QUOTA_TIINGO_PER_HOUR",
  "PROVIDER_QUOTA_TESTPROV_PER_MIN",
];

/** Warm the in-process UM knob cache with a single "active" subscription row whose knobEnv is
 *  `map`, via the real public getUsageMonitorKnobsCached path (mocked fetch, no real network) —
 *  mirrors how resolveProviderLimiterConfig/resolveProviderQuota consume it in production, rather
 *  than reaching into the cache's internals. The first call only TRIGGERS the fire-and-forget
 *  refresh (and returns whatever was cached before, i.e. nothing) — awaiting a macrotask lets that
 *  refresh's promise chain settle before the caller reads the now-populated cache. */
async function warmUsageMonitorKnobs(map: Record<string, string>): Promise<void> {
  process.env.USAGE_MONITOR_BASE_URL = "https://usage.example.test";
  process.env.USAGE_INGEST_TOKEN = "test-token";
  const fetchImpl = (async () =>
    new Response(JSON.stringify([{ status: "active", knobEnv: map, freeTierKnobEnv: {} }]), { status: 200 })
  ) as unknown as typeof fetch;
  getUsageMonitorKnobsCached({ fetchImpl });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Usage Monitor knob fallback", () => {
  beforeEach(() => {
    for (const k of [...ENV_KEYS, ...QUOTA_ENV_KEYS, ...UM_ENV_KEYS]) delete process.env[k];
    resetUsageMonitorKnobsCacheForTests();
  });
  afterEach(() => {
    for (const k of [...ENV_KEYS, ...QUOTA_ENV_KEYS, ...UM_ENV_KEYS]) delete process.env[k];
    resetUsageMonitorKnobsCacheForTests();
  });

  it("resolveProviderLimiterConfig falls back to a UM PER_MIN knob when no env override exists", async () => {
    await warmUsageMonitorKnobs({ PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN: "10" });
    const config = resolveProviderLimiterConfig("finnhub");
    expect(config?.minIntervalMs).toBe(6_000); // 60000 / 10, NOT the hard default's 1200ms (50/min)
  });

  it("resolveProviderLimiterConfig: process.env still wins over a UM knob", async () => {
    process.env.PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN = "50"; // the hard default's own value, but via env
    await warmUsageMonitorKnobs({ PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN: "10" });
    const config = resolveProviderLimiterConfig("finnhub");
    expect(config?.minIntervalMs).toBe(1_200); // 60000 / 50 (env), not 60000 / 10 (UM)
  });

  it("resolveProviderQuota falls back to a UM knob for a provider with no hard default", async () => {
    await warmUsageMonitorKnobs({ PROVIDER_QUOTA_TESTPROV_PER_MIN: "7" });
    expect(resolveProviderQuota("testprov")).toEqual([{ maxRequests: 7, windowMs: 60_000 }]);
  });

  it("resolveProviderQuota: process.env still wins over a UM knob", async () => {
    process.env.PROVIDER_QUOTA_TIINGO_PER_HOUR = "20";
    await warmUsageMonitorKnobs({ PROVIDER_QUOTA_TIINGO_PER_HOUR: "999" });
    const windows = resolveProviderQuota("tiingo");
    expect(windows?.find((w) => w.windowMs === 3_600_000)?.maxRequests).toBe(20);
  });

  it("multiple UM knobs for the same unconfigured provider add multiple windows", async () => {
    await warmUsageMonitorKnobs({
      PROVIDER_QUOTA_TESTPROV_PER_MIN: "3",
      PROVIDER_QUOTA_TESTPROV_PER_DAY: "5",
    });
    expect(resolveProviderQuota("testprov")).toEqual([
      { maxRequests: 3, windowMs: 60_000 },
      { maxRequests: 5, windowMs: 86_400_000 },
    ]);
  });

  it("an empty UM knob map leaves an unrelated provider unaffected", async () => {
    await warmUsageMonitorKnobs({});
    expect(resolveProviderQuota("some-random-provider")).toBeUndefined();
  });

  it("UM outage/failure during refresh is fail-open — resolution stays at the hard default", async () => {
    process.env.USAGE_MONITOR_BASE_URL = "https://usage.example.test";
    process.env.USAGE_INGEST_TOKEN = "test-token";
    const fetchImpl = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    getUsageMonitorKnobsCached({ fetchImpl });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveProviderLimiterConfig("finnhub")).toEqual({ minIntervalMs: 1_200, concurrency: Infinity });
  });

  it("a lapsed (non-active) subscription's knobEnv is ignored in favor of freeTierKnobEnv", async () => {
    process.env.USAGE_MONITOR_BASE_URL = "https://usage.example.test";
    process.env.USAGE_INGEST_TOKEN = "test-token";
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          {
            status: "canceled",
            knobEnv: { PROVIDER_QUOTA_TESTPROV_PER_MIN: "999" }, // stale paid override — must NOT apply
            freeTierKnobEnv: { PROVIDER_QUOTA_TESTPROV_PER_MIN: "4" },
          },
        ]),
        { status: 200 }
      )
    ) as unknown as typeof fetch;
    getUsageMonitorKnobsCached({ fetchImpl });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveProviderQuota("testprov")).toEqual([{ maxRequests: 4, windowMs: 60_000 }]);
  });

  it("USAGE_MONITOR_KNOBS_ENABLED=off disables the lane even with a base URL configured", async () => {
    process.env.USAGE_MONITOR_KNOBS_ENABLED = "off";
    await warmUsageMonitorKnobs({ PROVIDER_QUOTA_TESTPROV_PER_MIN: "7" });
    expect(resolveProviderQuota("testprov")).toBeUndefined();
  });
});

describe("RequestQuota (sliding-window, fake clock)", () => {
  beforeEach(() => { for (const k of QUOTA_ENV_KEYS) delete process.env[k]; });
  afterEach(() => { for (const k of QUOTA_ENV_KEYS) delete process.env[k]; });

  it("admits up to the tightest window and records the hits", () => {
    const clock = new FakeClock();
    const quota = new RequestQuota(clock);
    // twelvedata: 8/min is tighter than 800/day.
    expect(quota.admit("twelvedata", "k1", 20)).toBe(8);
    expect(quota.admit("twelvedata", "k1", 20)).toBe(0); // budget spent in this minute
  });

  it("binds on the MINIMUM headroom across all windows, and each window depletes independently", async () => {
    process.env.PROVIDER_QUOTA_TESTPROV_PER_MIN = "3";
    process.env.PROVIDER_QUOTA_TESTPROV_PER_DAY = "5";
    const clock = new FakeClock();
    const quota = new RequestQuota(clock);

    expect(quota.admit("testprov", "k", 10)).toBe(3); // per-min binds (3 < 5)
    await clock.advance(60_000);
    // per-min window rolled over (fresh 3), but the day window has 3 recorded → 5-3 = 2 headroom.
    expect(quota.admit("testprov", "k", 10)).toBe(2);
    await clock.advance(60_000);
    // day budget now fully spent (5), even though the minute has room.
    expect(quota.admit("testprov", "k", 10)).toBe(0);
  });

  it("keeps a separate budget per credential", () => {
    const quota = new RequestQuota(new FakeClock());
    expect(quota.admit("twelvedata", "keyA", 8)).toBe(8);
    expect(quota.admit("twelvedata", "keyA", 8)).toBe(0);
    expect(quota.admit("twelvedata", "keyB", 8)).toBe(8); // keyB untouched by keyA's spend
  });

  it("admits up to the fmp 290/min cap, reopens after 60s, and refund/per-cred lanes work", async () => {
    const clock = new FakeClock();
    const quota = new RequestQuota(clock);
    expect(quota.admit("fmp", "credA", 300)).toBe(290); // 290/min ceiling
    expect(quota.admit("fmp", "credA", 300)).toBe(0);   // minute spent
    expect(quota.admit("fmp", "credB", 300)).toBe(290); // credB is an independent lane
    quota.refund("fmp", "credA", 10);                   // hand back 10 (partial remainder / breaker skip)
    expect(quota.admit("fmp", "credA", 300)).toBe(10);  // exactly the refunded 10
    await clock.advance(60_000);
    expect(quota.admit("fmp", "credA", 300)).toBe(290); // window reopened
  });

  it("enforces an opt-in PROVIDER_QUOTA_FMP_PER_DAY cap alongside the minute window", async () => {
    process.env.PROVIDER_QUOTA_FMP_PER_DAY = "240"; // free-tier 250/day, 240 headroom
    const clock = new FakeClock();
    const quota = new RequestQuota(clock);
    expect(quota.admit("fmp", "k", 1000)).toBe(240); // day cap (240) binds under the 290/min
    await clock.advance(60_000);
    expect(quota.admit("fmp", "k", 1000)).toBe(0);   // minute refreshed but the day budget is spent
  });

  it("admits up to filingapi's 45/day default and denies once the day's budget is spent", () => {
    const quota = new RequestQuota(new FakeClock());
    expect(quota.admit("filingapi", "k", 100)).toBe(45); // capped to the 45/day default
    expect(quota.admit("filingapi", "k", 100)).toBe(0); // day's budget already spent
  });

  it("admits up to roic's free-safe 5/min default and denies once the minute is spent", () => {
    const quota = new RequestQuota(new FakeClock());
    expect(quota.admit("roic", "k", 15000)).toBe(5);
    expect(quota.admit("roic", "k", 15000)).toBe(0);
  });

  it("admits up to marketstack's 100/month default and denies once the month window is spent", () => {
    const quota = new RequestQuota(new FakeClock());
    expect(quota.admit("marketstack", "k", 200)).toBe(100);
    expect(quota.admit("marketstack", "k", 200)).toBe(0);
  });

  it("lets a PROVIDER_QUOTA_<NAME>_PER_DAY env override constrain alongside defaults", () => {
    process.env.PROVIDER_QUOTA_FILINGAPI_PER_DAY = "2";
    process.env.PROVIDER_QUOTA_ROIC_PER_DAY = "1";
    process.env.PROVIDER_QUOTA_MARKETSTACK_PER_DAY = "5";
    const quota = new RequestQuota(new FakeClock());
    expect(quota.admit("filingapi", "k", 100)).toBe(2); // overridden default (45) does not apply
    // ROIC still has 5/min free default; day override of 1 is the tighter bound.
    expect(quota.admit("roic", "k", 100)).toBe(1);
    // Marketstack still has 100/month; day override of 5 is tighter.
    expect(quota.admit("marketstack", "k", 100)).toBe(5);
  });

  it("refills as older hits slide out of the window", async () => {
    const clock = new FakeClock();
    const quota = new RequestQuota(clock);
    expect(quota.admit("twelvedata", "k", 8)).toBe(8); // fill the minute at t=0
    await clock.advance(59_000);
    expect(quota.admit("twelvedata", "k", 8)).toBe(0); // still inside the 60s window → nothing
    await clock.advance(2_000); // t=61_000: the t=0 hits are now > 60s old → they slide out
    expect(quota.admit("twelvedata", "k", 8)).toBe(8); // fully refilled
  });

  it("passes unlimited providers through unchanged", () => {
    const quota = new RequestQuota(new FakeClock());
    expect(quota.admit("yahoo-finance", "k", 1000)).toBe(1000);
  });

  it("admits nothing for a non-positive request count", () => {
    const quota = new RequestQuota(new FakeClock());
    expect(quota.admit("twelvedata", "k", 0)).toBe(0);
    expect(quota.admit("twelvedata", "k", -5)).toBe(0);
  });

  it("reset(provider) clears only that provider's lanes", () => {
    const quota = new RequestQuota(new FakeClock());
    quota.admit("twelvedata", "k", 8);
    quota.admit("tiingo", "k", 50);
    quota.reset("twelvedata");
    expect(quota.admit("twelvedata", "k", 8)).toBe(8); // twelvedata budget restored
    expect(quota.admit("tiingo", "k", 50)).toBe(0);    // tiingo still spent
  });

  it("reset() with no argument clears every lane", () => {
    const quota = new RequestQuota(new FakeClock());
    quota.admit("twelvedata", "k", 8);
    quota.admit("tiingo", "k", 50);
    quota.reset();
    expect(quota.admit("twelvedata", "k", 8)).toBe(8);
    expect(quota.admit("tiingo", "k", 50)).toBe(50);
  });

  it("refund() returns admitted-but-undispatched requests to the budget", () => {
    const quota = new RequestQuota(new FakeClock());
    expect(quota.admit("twelvedata", "k", 8)).toBe(8); // spend the whole minute
    expect(quota.admit("twelvedata", "k", 8)).toBe(0); // nothing left
    quota.refund("twelvedata", "k", 3);                // hand back 3 (e.g. a breaker skip / partial remainder)
    expect(quota.admit("twelvedata", "k", 8)).toBe(3); // exactly the 3 refunded are available again
  });

  it("refund() is clamped to what was recorded and is per-credential", () => {
    const quota = new RequestQuota(new FakeClock());
    quota.admit("twelvedata", "k", 5);
    quota.refund("twelvedata", "k", 100); // over-refund can't exceed recorded hits
    expect(quota.admit("twelvedata", "k", 8)).toBe(8); // fully restored, not more
    quota.admit("twelvedata", "k", 8);
    quota.refund("twelvedata", "other", 4); // refunding an unknown credential is a no-op
    expect(quota.admit("twelvedata", "k", 8)).toBe(0);
  });

  it("refund() is a no-op for unlimited providers and non-positive amounts", () => {
    const quota = new RequestQuota(new FakeClock());
    expect(() => quota.refund("yahoo-finance", "k", 5)).not.toThrow();
    quota.admit("twelvedata", "k", 8);
    quota.refund("twelvedata", "k", 0);
    quota.refund("twelvedata", "k", -3);
    expect(quota.admit("twelvedata", "k", 8)).toBe(0); // unchanged
  });
});

describe("admitProviderRequests (the module singleton) — survives a simulated process restart", () => {
  beforeEach(() => { process.env.PROVIDER_QUOTA_TESTQUOTA_PER_MIN = "8"; });
  afterEach(() => {
    delete process.env.PROVIDER_QUOTA_TESTQUOTA_PER_MIN;
    resetProviderQuotaState("testquota");
  });

  it("a lane's spend from a PRIOR process is hydrated and enforced, not reset to a fresh budget", () => {
    const credKey = `cred-${randomUUID()}`;
    expect(admitProviderRequests("testquota", credKey, 8)).toBe(8); // spend the whole per-minute budget
    expect(admitProviderRequests("testquota", credKey, 8)).toBe(0); // none left, pre-"restart"
    flushDurableStateNow(); // debounced write lands in SQLite (what a graceful shutdown hook does)

    // Simulate a restart: forget the in-memory RequestQuota state AND durable-state's hydration flag
    // for this namespace, WITHOUT touching the persisted SQLite rows (a real restart doesn't touch
    // disk) — this is exactly what protects against a redeploy re-granting an already-burned budget.
    simulateProviderQuotaRestartForTests();

    // A fresh process must still see the spend from before the "restart" — not a clean 8/8 budget.
    expect(admitProviderRequests("testquota", credKey, 8)).toBe(0);
  });

  it("refundProviderRequests' effect also survives a restart (a partial-remainder/breaker-skip refund isn't lost)", () => {
    const credKey = `cred-${randomUUID()}`;
    expect(admitProviderRequests("testquota", credKey, 8)).toBe(8);
    refundProviderRequests("testquota", credKey, 3); // e.g. a breaker skip handing 3 back
    flushDurableStateNow();

    simulateProviderQuotaRestartForTests();

    // The refunded 3 must still be available post-"restart" — a lost refund would under-count the
    // real remaining budget and needlessly defer symbols that should have been admitted.
    expect(admitProviderRequests("testquota", credKey, 8)).toBe(3);
  });

  it("an unrelated credential's lane is unaffected by another lane's restart-survived spend", () => {
    const credA = `cred-a-${randomUUID()}`;
    const credB = `cred-b-${randomUUID()}`;
    admitProviderRequests("testquota", credA, 8);
    simulateProviderQuotaRestartForTests();
    expect(admitProviderRequests("testquota", credB, 8)).toBe(8); // credB's own fresh budget, untouched
  });
});
