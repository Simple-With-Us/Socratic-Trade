import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-orcredit-${randomUUID()}.db`)}`;
});

// A fake fetch that returns the OpenRouter /credits shape, and counts calls (for cache assertions).
function makeFetcher(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(String(url));
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => body
    } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("openrouter credit status", () => {
  beforeEach(async () => {
    const { __resetOpenRouterCreditCache } = await import("../src/lib/openrouter-credits");
    __resetOpenRouterCreditCache();
    delete process.env.OPENROUTER_LOW_CREDIT_USD;
    delete process.env.OPENROUTER_CREDIT_CHECK_INTERVAL_MS;
  });

  it("returns null when no OpenRouter key is configured (no signal to publish)", async () => {
    const { getOpenRouterCreditStatus } = await import("../src/lib/openrouter-credits");
    const { fetcher } = makeFetcher({ data: { total_credits: 75, total_usage: 25 } });
    // Fresh DB, no key stored for local, failover off → resolves no key.
    expect(await getOpenRouterCreditStatus(1000, fetcher)).toBeNull();
  });

  it("ok=true when the balance is at/above the threshold; reports the remaining amount", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    // Default threshold is $3; leave env unset to exercise the default.
    const { getOpenRouterCreditStatus } = await import("../src/lib/openrouter-credits");
    const { fetcher } = makeFetcher({ data: { total_credits: 75, total_usage: 25.31 } });
    const s = (await getOpenRouterCreditStatus(1000, fetcher))!;
    expect(s.ok).toBe(true);
    expect(s.remainingUsd).toBeCloseTo(49.69, 2);
    expect(s.thresholdUsd).toBe(3);
  });

  it("ok=false ONLY when the balance is genuinely below the threshold (the alert signal)", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    process.env.OPENROUTER_LOW_CREDIT_USD = "3";
    const { getOpenRouterCreditStatus, __resetOpenRouterCreditCache } = await import("../src/lib/openrouter-credits");
    __resetOpenRouterCreditCache();
    // ~4.69 remaining is ABOVE the $3 floor → still ok (this was the false-alarm zone under the old $10 default)
    const { fetcher: above } = makeFetcher({ data: { total_credits: 30, total_usage: 25.31 } });
    const aboveS = (await getOpenRouterCreditStatus(1000, above))!;
    expect(aboveS.ok).toBe(true);
    expect(aboveS.remainingUsd).toBeCloseTo(4.69, 2);

    __resetOpenRouterCreditCache();
    // ~2.00 remaining is BELOW $3 → alert signal
    const { fetcher: below } = makeFetcher({ data: { total_credits: 30, total_usage: 28 } });
    const s = (await getOpenRouterCreditStatus(2000, below))!;
    expect(s.ok).toBe(false);
    expect(s.remainingUsd).toBeCloseTo(2.0, 2);
    expect(s.thresholdUsd).toBe(3);
  });

  it("fails OPEN on a read error — a broken credits check never masquerades as low balance", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    const { getOpenRouterCreditStatus, __resetOpenRouterCreditCache } = await import("../src/lib/openrouter-credits");
    __resetOpenRouterCreditCache();
    const { fetcher } = makeFetcher({}, { ok: false, status: 500 });
    const s = (await getOpenRouterCreditStatus(1000, fetcher))!;
    expect(s.ok).toBe(true); // fail-open — do NOT page on our own read failure
    expect(s.error).toContain("500");
    expect(s.remainingUsd).toBeNull();
  });

  it("caches within the interval — a frequent health poll does not hammer the credits API", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    process.env.OPENROUTER_CREDIT_CHECK_INTERVAL_MS = "600000";
    const { getOpenRouterCreditStatus, __resetOpenRouterCreditCache } = await import("../src/lib/openrouter-credits");
    __resetOpenRouterCreditCache();
    const { fetcher, calls } = makeFetcher({ data: { total_credits: 75, total_usage: 25 } });
    await getOpenRouterCreditStatus(1000, fetcher);
    await getOpenRouterCreditStatus(2000, fetcher); // within interval → served from cache
    expect(calls).toHaveLength(1);
    // After the interval elapses, it fetches again.
    await getOpenRouterCreditStatus(1000 + 600001, fetcher);
    expect(calls).toHaveLength(2);
  });

  it("serves the last good balance when a refresh is aborted by the health budget", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    process.env.OPENROUTER_CREDIT_CHECK_INTERVAL_MS = "1000";
    const { getOpenRouterCreditStatus, __resetOpenRouterCreditCache } = await import("../src/lib/openrouter-credits");
    __resetOpenRouterCreditCache();
    const { fetcher } = makeFetcher({ data: { total_credits: 75, total_usage: 25 } });
    const first = (await getOpenRouterCreditStatus(1000, fetcher))!;
    expect(first.remainingUsd).toBe(50);

    const aborting = (async () => {
      throw Object.assign(new Error("This operation was aborted"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const stale = (await getOpenRouterCreditStatus(1000 + 60_000, aborting))!;
    expect(stale.remainingUsd).toBe(50);
    expect(stale.ok).toBe(true);
  });
});

describe("formatOpenRouterCreditsExhaustedHint", () => {
  it("returns undefined when the check is healthy or missing", async () => {
    const { formatOpenRouterCreditsExhaustedHint } = await import("../src/lib/openrouter-credits");
    expect(formatOpenRouterCreditsExhaustedHint(null)).toBeUndefined();
    expect(formatOpenRouterCreditsExhaustedHint(undefined)).toBeUndefined();
    expect(
      formatOpenRouterCreditsExhaustedHint({
        ok: true,
        remainingUsd: 12,
        totalUsd: 20,
        usedUsd: 8,
        thresholdUsd: 3,
        checkedAt: "2026-08-17T00:00:00.000Z"
      })
    ).toBeUndefined();
  });

  it("returns undefined on a fail-open read (ok=false must come with a real remaining balance)", async () => {
    const { formatOpenRouterCreditsExhaustedHint } = await import("../src/lib/openrouter-credits");
    expect(
      formatOpenRouterCreditsExhaustedHint({
        ok: false,
        remainingUsd: null,
        totalUsd: null,
        usedUsd: null,
        thresholdUsd: 3,
        checkedAt: "2026-08-17T00:00:00.000Z",
        error: "credits check HTTP 500"
      })
    ).toBeUndefined();
  });

  it("names the remaining balance and the alert floor when credits are below threshold", async () => {
    const { formatOpenRouterCreditsExhaustedHint } = await import("../src/lib/openrouter-credits");
    const hint = formatOpenRouterCreditsExhaustedHint({
      ok: false,
      remainingUsd: 0.12,
      totalUsd: 10,
      usedUsd: 9.88,
      thresholdUsd: 3,
      checkedAt: "2026-08-17T00:00:00.000Z"
    });
    expect(hint).toMatch(/OpenRouter credits look exhausted \(\$0\.12 remaining; alert floor \$3\.00\)/);
    expect(hint).toMatch(/Empty LLM responses are the usual symptom/);
    expect(hint).toMatch(/Top up OpenRouter/);
  });
});
