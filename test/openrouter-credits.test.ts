import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-orcredit-${randomUUID()}.db`)}`;
});

type RouteBody = {
  credits?: unknown;
  key?: unknown;
  keys?: unknown;
  creditsOk?: boolean;
  keyOk?: boolean;
  keysOk?: boolean;
  creditsStatus?: number;
  keyStatus?: number;
  keysStatus?: number;
};

/** Route-aware fake fetch for /credits, /key, and /keys. */
function makeFetcher(body: RouteBody) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/api/v1/key") && !u.includes("/keys")) {
      return {
        ok: body.keyOk ?? true,
        status: body.keyStatus ?? 200,
        json: async () => body.key ?? { data: { is_management_key: false } }
      } as Response;
    }
    if (u.includes("/api/v1/keys")) {
      return {
        ok: body.keysOk ?? true,
        status: body.keysStatus ?? 200,
        json: async () => body.keys ?? { data: [] }
      } as Response;
    }
    // /credits
    return {
      ok: body.creditsOk ?? true,
      status: body.creditsStatus ?? 200,
      json: async () => body.credits ?? { data: { total_credits: 0, total_usage: 0 } }
    } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function wipeEnv() {
  delete process.env.OPENROUTER_LOW_CREDIT_USD;
  delete process.env.OPENROUTER_KEY_LIMIT_LOW_USD;
  delete process.env.OPENROUTER_CREDIT_CHECK_INTERVAL_MS;
  delete process.env.OPENROUTER_MANAGEMENT_KEY;
  delete process.env.OPENROUTER_ADMIN_KEY;
}

describe("openrouter credit status", () => {
  beforeEach(async () => {
    const { __resetOpenRouterCreditCache } = await import("../src/lib/openrouter-credits");
    __resetOpenRouterCreditCache();
    wipeEnv();
  });

  it("returns null when no OpenRouter key is configured (no signal to publish)", async () => {
    const { getOpenRouterCreditStatus } = await import("../src/lib/openrouter-credits");
    const { fetcher } = makeFetcher({
      credits: { data: { total_credits: 75, total_usage: 25 } }
    });
    expect(await getOpenRouterCreditStatus(1000, fetcher)).toBeNull();
  });

  it("ok=true when the account balance is at/above the threshold (inference key path)", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    const { getOpenRouterCreditStatus } = await import("../src/lib/openrouter-credits");
    const { fetcher, calls } = makeFetcher({
      credits: { data: { total_credits: 75, total_usage: 25.31 } },
      key: { data: { is_management_key: false } }
    });
    const s = (await getOpenRouterCreditStatus(1000, fetcher))!;
    expect(s.ok).toBe(true);
    expect(s.remainingUsd).toBeCloseTo(49.69, 2);
    expect(s.thresholdUsd).toBe(3);
    expect(s.source).toBe("inference");
    expect(s.keysChecked).toBe(false);
    expect(s.reasons).toEqual([]);
    // inference path: /key then /credits; never /keys
    expect(calls.some((c) => c.includes("/keys"))).toBe(false);
  });

  it("ok=false ONLY when the account balance is genuinely below the threshold", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    process.env.OPENROUTER_LOW_CREDIT_USD = "3";
    const { getOpenRouterCreditStatus, __resetOpenRouterCreditCache } = await import(
      "../src/lib/openrouter-credits"
    );
    __resetOpenRouterCreditCache();
    const { fetcher: above } = makeFetcher({
      credits: { data: { total_credits: 30, total_usage: 25.31 } },
      key: { data: { is_management_key: false } }
    });
    const aboveS = (await getOpenRouterCreditStatus(1000, above))!;
    expect(aboveS.ok).toBe(true);
    expect(aboveS.remainingUsd).toBeCloseTo(4.69, 2);

    __resetOpenRouterCreditCache();
    const { fetcher: below } = makeFetcher({
      credits: { data: { total_credits: 30, total_usage: 28 } },
      key: { data: { is_management_key: false } }
    });
    const s = (await getOpenRouterCreditStatus(2000, below))!;
    expect(s.ok).toBe(false);
    expect(s.remainingUsd).toBeCloseTo(2.0, 2);
    expect(s.reasons).toContain("account_low");
  });

  it("with a management key, ok=false when any enabled key has limit_remaining <= 0", async () => {
    process.env.OPENROUTER_ADMIN_KEY = "sk-or-mgmt-test";
    process.env.OPENROUTER_LOW_CREDIT_USD = "3";
    process.env.OPENROUTER_KEY_LIMIT_LOW_USD = "3";
    const { getOpenRouterCreditStatus } = await import("../src/lib/openrouter-credits");
    const { fetcher } = makeFetcher({
      credits: { data: { total_credits: 100, total_usage: 10 } }, // $90 remaining — account fine
      key: { data: { is_management_key: true } },
      keys: {
        data: [
          { label: "st-prod", disabled: false, limit: 50, limit_remaining: 0 },
          { label: "ct-prod", disabled: false, limit: 50, limit_remaining: 20 },
          { label: "old", disabled: true, limit: 10, limit_remaining: 0 }
        ]
      }
    });
    const s = (await getOpenRouterCreditStatus(1000, fetcher))!;
    expect(s.ok).toBe(false);
    expect(s.source).toBe("management");
    expect(s.keysChecked).toBe(true);
    expect(s.keysLimitReached).toBe(1);
    expect(s.reasons).toContain("key_limit_reached");
    expect(s.problemKeyLabels).toContain("st-prod");
    // disabled key must not count
    expect(s.keysWithLimit).toBe(2);
  });

  it("keeps a cached key_limit_reached failure when the next /keys read fails transiently", async () => {
    process.env.OPENROUTER_ADMIN_KEY = "sk-or-mgmt-test";
    process.env.OPENROUTER_LOW_CREDIT_USD = "3";
    process.env.OPENROUTER_KEY_LIMIT_LOW_USD = "3";
    process.env.OPENROUTER_CREDIT_CHECK_INTERVAL_MS = "1000";
    const { getOpenRouterCreditStatus } = await import("../src/lib/openrouter-credits");
    const exhausted = makeFetcher({
      credits: { data: { total_credits: 100, total_usage: 10 } },
      key: { data: { is_management_key: true } },
      keys: {
        data: [{ label: "st-prod", disabled: false, limit: 50, limit_remaining: 0 }]
      }
    });
    const first = (await getOpenRouterCreditStatus(1000, exhausted.fetcher))!;
    expect(first.ok).toBe(false);
    expect(first.reasons).toContain("key_limit_reached");

    // Past the cache interval, the /keys read now fails (HTTP 500) while the account
    // balance is still healthy: the known key exhaustion must not flap to ok=true.
    const keysDown = makeFetcher({
      credits: { data: { total_credits: 100, total_usage: 10 } },
      key: { data: { is_management_key: true } },
      keysOk: false,
      keysStatus: 500
    });
    const second = (await getOpenRouterCreditStatus(1000 + 60_000, keysDown.fetcher))!;
    expect(second.ok).toBe(false);
    expect(second.reasons).toContain("key_limit_reached");
    expect(second.keysLimitReached).toBe(1);
    expect(second.problemKeyLabels).toContain("st-prod");
    expect(second.remainingUsd).toBe(90);
  });

  it("with a management key, ok=false when any enabled key is low on its limit", async () => {
    process.env.OPENROUTER_MANAGEMENT_KEY = "sk-or-mgmt-test";
    process.env.OPENROUTER_KEY_LIMIT_LOW_USD = "5";
    const { getOpenRouterCreditStatus } = await import("../src/lib/openrouter-credits");
    const { fetcher } = makeFetcher({
      credits: { data: { total_credits: 100, total_usage: 10 } },
      key: { data: { is_management_key: true } },
      keys: {
        data: [{ label: "st-prod", disabled: false, limit: 50, limit_remaining: 2.5 }]
      }
    });
    const s = (await getOpenRouterCreditStatus(1000, fetcher))!;
    expect(s.ok).toBe(false);
    expect(s.keysLimitLow).toBe(1);
    expect(s.reasons).toContain("key_limit_low");
  });

  it("prefers OPENROUTER_ADMIN_KEY over the inference store key", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-inference");
    process.env.OPENROUTER_ADMIN_KEY = "sk-or-mgmt-test";
    const { getOpenRouterCreditStatus } = await import("../src/lib/openrouter-credits");
    const { fetcher, calls } = makeFetcher({
      credits: { data: { total_credits: 50, total_usage: 1 } },
      key: { data: { is_management_key: true } },
      keys: { data: [] }
    });
    const s = (await getOpenRouterCreditStatus(1000, fetcher))!;
    expect(s.source).toBe("management");
    expect(s.keysChecked).toBe(true);
    expect(calls.some((c) => c.includes("/keys"))).toBe(true);
  });

  it("fails OPEN on a credits read error — never masquerades as low balance", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    const { getOpenRouterCreditStatus, __resetOpenRouterCreditCache } = await import(
      "../src/lib/openrouter-credits"
    );
    __resetOpenRouterCreditCache();
    const { fetcher } = makeFetcher({
      creditsOk: false,
      creditsStatus: 500,
      key: { data: { is_management_key: false } }
    });
    const s = (await getOpenRouterCreditStatus(1000, fetcher))!;
    expect(s.ok).toBe(true);
    expect(s.error).toContain("500");
    expect(s.remainingUsd).toBeNull();
  });

  it("caches within the interval — a frequent health poll does not hammer the credits API", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    process.env.OPENROUTER_CREDIT_CHECK_INTERVAL_MS = "600000";
    const { getOpenRouterCreditStatus, __resetOpenRouterCreditCache } = await import(
      "../src/lib/openrouter-credits"
    );
    __resetOpenRouterCreditCache();
    const { fetcher, calls } = makeFetcher({
      credits: { data: { total_credits: 75, total_usage: 25 } },
      key: { data: { is_management_key: false } }
    });
    await getOpenRouterCreditStatus(1000, fetcher);
    await getOpenRouterCreditStatus(2000, fetcher);
    // Each miss does /key + /credits (2 calls); second hit is cache → still 2 total.
    expect(calls).toHaveLength(2);
    await getOpenRouterCreditStatus(1000 + 600001, fetcher);
    expect(calls).toHaveLength(4);
  });

  it("serves the last good balance when a refresh is aborted by the health budget", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    process.env.OPENROUTER_CREDIT_CHECK_INTERVAL_MS = "1000";
    const { getOpenRouterCreditStatus, __resetOpenRouterCreditCache } = await import("../src/lib/openrouter-credits");
    __resetOpenRouterCreditCache();
    const { fetcher } = makeFetcher({ credits: { data: { total_credits: 75, total_usage: 25 } } });
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
        keyLimitThresholdUsd: 3,
        source: "inference",
        keysChecked: false,
        keysWithLimit: 0,
        keysLimitReached: 0,
        keysLimitLow: 0,
        reasons: [],
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
        keyLimitThresholdUsd: 3,
        source: "inference",
        keysChecked: false,
        keysWithLimit: 0,
        keysLimitReached: 0,
        keysLimitLow: 0,
        reasons: [],
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
      keyLimitThresholdUsd: 3,
      source: "inference",
      keysChecked: false,
      keysWithLimit: 0,
      keysLimitReached: 0,
      keysLimitLow: 0,
      reasons: ["account_low"],
      checkedAt: "2026-08-17T00:00:00.000Z"
    });
    expect(hint).toMatch(/OpenRouter credits look exhausted \(\$0\.12 remaining; alert floor \$3\.00\)/);
    expect(hint).toMatch(/Empty LLM responses are the usual symptom/);
    expect(hint).toMatch(/Top up OpenRouter/);
  });
});
