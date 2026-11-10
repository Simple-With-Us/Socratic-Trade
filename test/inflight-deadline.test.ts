import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GET_ACCOUNTS_FIRST_MS,
  GET_ACCOUNTS_RETRY_MS,
  ALPACA_ACCOUNT_READ_FIRST_MS,
  ALPACA_ACCOUNT_READ_RETRY_MS,
  EQUITY_QUOTES_MS,
  OPTION_POSITIONS_MS,
  alpacaAccountReadBudgetMs,
  awaitWithFirstCallRetry,
  firstOutcomeOf,
  getAccountsTimeoutMessage,
  outcomeOrTimeout,
  withDeadline,
  type BrokerCallAttempt
} from "../src/lib/inflight-deadline";

afterEach(() => {
  vi.useRealTimers();
});

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

function delayReject(ms: number, reason: Error): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(reason), ms);
  });
}

describe("awaitWithFirstCallRetry", () => {
  it("returns a first call that settles before the first budget", async () => {
    vi.useFakeTimers();
    const start = vi.fn(() => delay(20, ["PA1"]));
    const result = awaitWithFirstCallRetry(start, {
      firstMs: 100,
      retryMs: 100,
      onFinalTimeout: () => []
    });
    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toEqual(["PA1"]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("keeps a live-max 14s first getAccounts without aborting at 6s", async () => {
    vi.useFakeTimers();
    const start = vi.fn(() => delay(14_000, [{ accountNumber: "294709855" }]));
    const result = awaitWithFirstCallRetry(start, {
      firstMs: GET_ACCOUNTS_FIRST_MS,
      retryMs: GET_ACCOUNTS_RETRY_MS,
      onFinalTimeout: () => {
        throw new Error("should not hard-fail a 14s first getAccounts");
      }
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(result).resolves.toEqual([{ accountNumber: "294709855" }]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("first wait is above the live alpaca-broker max of 14s", () => {
    expect(GET_ACCOUNTS_FIRST_MS).toBeGreaterThan(14_416);
    expect(EQUITY_QUOTES_MS).toBeGreaterThan(14_416);
    expect(OPTION_POSITIONS_MS).toBeGreaterThan(14_416);
    expect(alpacaAccountReadBudgetMs()).toEqual({
      firstMs: ALPACA_ACCOUNT_READ_FIRST_MS,
      retryMs: ALPACA_ACCOUNT_READ_RETRY_MS
    });
    expect(alpacaAccountReadBudgetMs().firstMs).toBeGreaterThan(14_416);
  });

  it("uses a fresh retry when the first call stays pending", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const start = vi.fn(() => {
      calls += 1;
      if (calls === 1) return new Promise(() => undefined);
      return delay(50, "retry-ok");
    });
    const result = awaitWithFirstCallRetry(start, {
      firstMs: 100,
      retryMs: 200,
      onFinalTimeout: () => "timeout"
    });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBe("retry-ok");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not retry a real rejection — credential / broker-down stays loud", async () => {
    vi.useFakeTimers();
    const start = vi.fn(() => Promise.reject(new Error("Alpaca credentials rejected")));
    const result = awaitWithFirstCallRetry(start, {
      firstMs: 100,
      retryMs: 100,
      onFinalTimeout: () => "hidden"
    });
    await expect(result).rejects.toThrow("Alpaca credentials rejected");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("fail-closes only after first + retry budgets both expire", async () => {
    vi.useFakeTimers();
    const start = vi.fn(() => new Promise<string>(() => undefined));
    const timedOutSections: string[] = [];
    const result = awaitWithFirstCallRetry(start, {
      firstMs: GET_ACCOUNTS_FIRST_MS,
      retryMs: GET_ACCOUNTS_RETRY_MS,
      onFinalTimeout: () => "degraded",
      label: "gateway.getAccounts",
      timedOutSections
    });
    await vi.advanceTimersByTimeAsync(GET_ACCOUNTS_FIRST_MS + GET_ACCOUNTS_RETRY_MS);
    await expect(result).resolves.toBe("degraded");
    expect(start).toHaveBeenCalledTimes(2);
    expect(timedOutSections).toEqual(["gateway.getAccounts"]);
  });

  it("prefers a later fulfillment over a sibling rejection", async () => {
    vi.useFakeTimers();
    const a = delayReject(10, new Error("dead socket"));
    const b = delay(30, "recovered");
    const raced = firstOutcomeOf([a, b], 100);
    await vi.advanceTimersByTimeAsync(30);
    await expect(raced).resolves.toEqual({ kind: "fulfilled", value: "recovered" });
  });

  it("names the combined getAccounts budget in the timeout string", () => {
    expect(getAccountsTimeoutMessage()).toBe(
      `Timed out waiting for gateway.getAccounts after ${GET_ACCOUNTS_FIRST_MS}+${GET_ACCOUNTS_RETRY_MS}ms.`
    );
  });
});

describe("outcomeOrTimeout", () => {
  it("reports pending when the promise never settles", async () => {
    vi.useFakeTimers();
    const outcome = outcomeOrTimeout(new Promise(() => undefined), 25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(outcome).resolves.toEqual({ kind: "pending" });
  });
});

describe("withDeadline cancellation", () => {
  it("aborts the supplied controller when the deadline wins", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const raced = withDeadline(new Promise(() => undefined), 100, "broker timeout", { controller });
    raced.catch(() => undefined);

    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);

    await expect(raced).rejects.toThrow("broker timeout");
    // Without this, a timed-out broker call keeps running and holds its socket open for the
    // life of the process — the accumulator behind the slow-health-endpoint symptom.
    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error)?.message).toBe("broker timeout");
  });

  it("never aborts a call that settles inside the deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const raced = withDeadline(delay(20, "ok"), 100, "broker timeout", { controller });

    await vi.advanceTimersByTimeAsync(20);
    await expect(raced).resolves.toBe("ok");

    await vi.advanceTimersByTimeAsync(200);
    expect(controller.signal.aborted).toBe(false);
  });

  it("stays a pure race when no controller is supplied", async () => {
    vi.useFakeTimers();
    const raced = withDeadline(new Promise(() => undefined), 100, "broker timeout");
    raced.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    await expect(raced).rejects.toThrow("broker timeout");
  });
});

describe("awaitWithFirstCallRetry cancellation", () => {
  it("aborts the abandoned first call once the retry wins", async () => {
    vi.useFakeTimers();
    const signals: Array<AbortSignal | undefined> = [];
    let calls = 0;
    const start = vi.fn((attempt: BrokerCallAttempt) => {
      signals.push(attempt?.signal);
      calls += 1;
      if (calls === 1) return new Promise<string>(() => undefined);
      return delay(50, "retry-ok");
    });

    const result = awaitWithFirstCallRetry(start, {
      firstMs: 100,
      retryMs: 200,
      onFinalTimeout: () => "timeout"
    });

    await vi.advanceTimersByTimeAsync(100);
    // The first attempt is still allowed to win the race — it must not be cancelled merely
    // because the retry has been issued.
    expect(signals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBe("retry-ok");

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("cancels both attempts when the combined budget expires", async () => {
    vi.useFakeTimers();
    const signals: Array<AbortSignal | undefined> = [];
    const start = vi.fn((attempt: BrokerCallAttempt) => {
      signals.push(attempt?.signal);
      return new Promise<string>(() => undefined);
    });

    const result = awaitWithFirstCallRetry(start, {
      firstMs: 100,
      retryMs: 200,
      onFinalTimeout: () => "degraded"
    });

    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toBe("degraded");

    // Nobody won.  Both calls are abandoned, so neither may be left running behind a caller
    // that has already served a degraded snapshot.
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
  });

  it("does not abort a first call that wins inside its own budget", async () => {
    vi.useFakeTimers();
    const signals: Array<AbortSignal | undefined> = [];
    const start = vi.fn((attempt: BrokerCallAttempt) => {
      signals.push(attempt?.signal);
      return delay(20, "fast");
    });

    const result = awaitWithFirstCallRetry(start, {
      firstMs: 100,
      retryMs: 200,
      onFinalTimeout: () => "timeout"
    });

    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toBe("fast");
    expect(start).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);
  });
});
