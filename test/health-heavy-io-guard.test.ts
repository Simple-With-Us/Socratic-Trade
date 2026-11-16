import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceHealthSummary } from "../src/lib/db-health";
import { resetRateLimiter } from "../src/lib/rate-limit";
import {
  __resetHeavyHealthSectionsForTests,
  admitAnonymousHeavyHealthProbe,
  heavyHealthClientKey,
  onceHeavyRecomputePermission,
  runHeavyHealthSection
} from "../src/lib/health-heavy-probe";

const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-health-heavy-${randomUUID()}.db`)}`;
});

afterAll(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

const HEALTH_URL = "http://localhost/api/health";

async function loadRoute() {
  const db = await import("../src/lib/db");
  const healthRoute = await import("../app/api/health/route");
  const cache = await import("../src/lib/health-probe-cache");
  return { db, healthRoute, cache };
}

describe("runHeavyHealthSection", () => {
  beforeEach(() => {
    __resetHeavyHealthSectionsForTests();
    process.env.HEALTH_HEAVY_SECTION_TTL_MS = "5000";
  });

  afterEach(() => {
    __resetHeavyHealthSectionsForTests();
    delete process.env.HEALTH_HEAVY_SECTION_TTL_MS;
  });

  it("pins section slots on globalThis for cross-bundle sharing", () => {
    expect(
      (globalThis as { __socraticHealthHeavySectionSlots?: Map<string, unknown> })
        .__socraticHealthHeavySectionSlots
    ).toBeDefined();
  });

  it("reuses one in-flight computation for concurrent callers", async () => {
    let calls = 0;
    const compute = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return calls;
    });

    const [a, b] = await Promise.all([
      runHeavyHealthSection("openrouter", compute, { recomputeHeavySections: true }),
      runHeavyHealthSection("openrouter", compute, { recomputeHeavySections: true })
    ]);

    expect(compute).toHaveBeenCalledTimes(1);
    expect(a.value).toBe(1);
    expect(b.value).toBe(1);
    expect(a.fromCache || b.fromCache).toBe(true);
  });

  it("recomputes after the TTL expires", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    const now = 1_000_000;
    await runHeavyHealthSection("disk", compute, { recomputeHeavySections: true, now });
    const cached = await runHeavyHealthSection("disk", compute, {
      recomputeHeavySections: true,
      now: now + 1_000
    });
    expect(calls).toBe(1);
    expect(cached.fromCache).toBe(true);

    await runHeavyHealthSection("disk", compute, {
      recomputeHeavySections: true,
      now: now + 6_000
    });
    expect(calls).toBe(2);
  });

  it("serves cached data when recompute is denied and never throws", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { marker: calls };
    };
    await runHeavyHealthSection("litestream", compute, { recomputeHeavySections: true });
    const limited = await runHeavyHealthSection("litestream", compute, { recomputeHeavySections: false });
    expect(calls).toBe(1);
    expect(limited.value).toEqual({ marker: 1 });
    expect(limited.fromCache).toBe(true);
    expect(limited.cachedAgeSeconds).not.toBeNull();
  });

  it("charges a lazy admission callback only when a section would recompute", async () => {
    const admit = vi.fn(() => true);
    const permission = onceHeavyRecomputePermission(admit);
    const now = 1_000_000;
    let calls = 0;
    const compute = async () => (calls += 1);
    await runHeavyHealthSection("disk", compute, { recomputeHeavySections: permission, now });
    expect(admit).toHaveBeenCalledTimes(1);
    // TTL-fresh hit: no charge, even with a fresh (uncharged) callback.
    const fresh = vi.fn(() => true);
    await runHeavyHealthSection("disk", compute, { recomputeHeavySections: fresh, now: now + 1_000 });
    expect(fresh).not.toHaveBeenCalled();
    // One request's memoized callback charges once across several sections.
    await runHeavyHealthSection("litestream", compute, { recomputeHeavySections: permission, now });
    expect(admit).toHaveBeenCalledTimes(1);
    // Stale + denied serves the cached value.
    const denied = vi.fn(() => false);
    const stale = await runHeavyHealthSection("disk", compute, { recomputeHeavySections: denied, now: now + 6_000 });
    expect(denied).toHaveBeenCalledTimes(1);
    expect(stale.fromCache).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("admitAnonymousHeavyHealthProbe", () => {
  beforeEach(() => {
    resetRateLimiter();
    process.env.HEALTH_HEAVY_PER_IP_LIMIT = "2";
    process.env.HEALTH_HEAVY_GLOBAL_LIMIT = "100";
  });

  afterEach(() => {
    resetRateLimiter();
    delete process.env.HEALTH_HEAVY_PER_IP_LIMIT;
    delete process.env.HEALTH_HEAVY_GLOBAL_LIMIT;
  });

  it("never throttles ops-token detailed probes", () => {
    const req = new Request(HEALTH_URL, { headers: { "x-ops-token": "secret" } });
    expect(admitAnonymousHeavyHealthProbe(req, true).recomputeHeavySections).toBe(true);
  });

  it("does not let a rotated CF-Connecting-IP mint a fresh per-IP budget without the origin lock", () => {
    vi.stubEnv("REQUIRE_CLOUDFLARE_ORIGIN", "");
    try {
      const spoofed = (ip: string) => new Request(HEALTH_URL, { headers: { "cf-connecting-ip": ip } });
      expect(heavyHealthClientKey(spoofed("198.51.100.1"))).toBe("unknown-ip");
      expect(admitAnonymousHeavyHealthProbe(spoofed("198.51.100.1"), false).recomputeHeavySections).toBe(true);
      expect(admitAnonymousHeavyHealthProbe(spoofed("198.51.100.2"), false).recomputeHeavySections).toBe(true);
      // Per-IP limit is 2: a third, rotated address is still the same anonymous bucket.
      expect(admitAnonymousHeavyHealthProbe(spoofed("198.51.100.3"), false).recomputeHeavySections).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ignores CF-Connecting-IP under the origin lock unless the request carries the trust marker", () => {
    vi.stubEnv("REQUIRE_CLOUDFLARE_ORIGIN", "1");
    try {
      const forged = new Request(HEALTH_URL, {
        headers: { "cf-connecting-ip": "198.51.100.9", "x-socratic-cf-client-trusted": "forged|1" }
      });
      expect(heavyHealthClientKey(forged)).toBe("unknown-ip");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("throttles anonymous probes after the per-IP budget", () => {
    const req = new Request(HEALTH_URL, { headers: { "cf-connecting-ip": "203.0.113.44" } });
    expect(admitAnonymousHeavyHealthProbe(req, false).recomputeHeavySections).toBe(true);
    expect(admitAnonymousHeavyHealthProbe(req, false).recomputeHeavySections).toBe(true);
    expect(admitAnonymousHeavyHealthProbe(req, false).recomputeHeavySections).toBe(false);
  });
});

describe("/api/health heavy sections", () => {
  beforeEach(async () => {
    process.env.HEALTH_SNAPSHOT_TTL_MS = "0";
    process.env.HEALTH_HEAVY_SECTION_TTL_MS = "60000";
    process.env.HEALTH_HEAVY_PER_IP_LIMIT = "1000";
    resetRateLimiter();
    const { db, cache } = await loadRoute();
    cache.__resetHealthSnapshotForTests();
    __resetHeavyHealthSectionsForTests();
    db.getDb().prepare("DELETE FROM settings").run();
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
  });

  afterEach(async () => {
    const { cache } = await loadRoute();
    cache.__resetHealthSnapshotForTests();
    __resetHeavyHealthSectionsForTests();
    resetRateLimiter();
    delete process.env.HEALTH_SNAPSHOT_TTL_MS;
    delete process.env.HEALTH_HEAVY_SECTION_TTL_MS;
    delete process.env.HEALTH_HEAVY_PER_IP_LIMIT;
  });

  it("hits OpenRouter at most once within the heavy-section TTL", async () => {
    const { healthRoute, cache } = await loadRoute();
    let creditCalls = 0;
    const original = cache.healthProbeDeps.getOpenRouterCreditStatus;
    cache.healthProbeDeps.getOpenRouterCreditStatus = async () => {
      creditCalls += 1;
      return null;
    };

    try {
      for (let i = 0; i < 5; i++) {
        const response = await healthRoute.GET(new Request(HEALTH_URL));
        expect(response.status).toBeLessThan(500);
      }
      expect(creditCalls).toBe(1);
    } finally {
      cache.healthProbeDeps.getOpenRouterCreditStatus = original;
    }
  });

  it("returns 200 and stale heavy sections when the anonymous limiter fires", async () => {
    const { healthRoute, cache } = await loadRoute();
    process.env.HEALTH_HEAVY_PER_IP_LIMIT = "1";
    process.env.HEALTH_HEAVY_SECTION_TTL_MS = "0";
    resetRateLimiter();

    const controlIp = "203.0.113.78";
    const controlRequest = () =>
      new Request(HEALTH_URL, { headers: { "cf-connecting-ip": controlIp } });
    expect(admitAnonymousHeavyHealthProbe(controlRequest(), false).recomputeHeavySections).toBe(true);
    expect(admitAnonymousHeavyHealthProbe(controlRequest(), false).recomputeHeavySections).toBe(false);

    let creditCalls = 0;
    const original = cache.healthProbeDeps.getOpenRouterCreditStatus;
    cache.healthProbeDeps.getOpenRouterCreditStatus = async () => {
      creditCalls += 1;
      return {
        ok: true,
        remainingUsd: 5,
        totalUsd: 10,
        usedUsd: 5,
        thresholdUsd: 3,
        keyLimitThresholdUsd: 3,
        checkedAt: new Date().toISOString(),
        source: "inference" as const,
        keysChecked: false,
        keysWithLimit: 0,
        keysLimitReached: 0,
        keysLimitLow: 0,
        reasons: [] as const
      };
    };

    try {
      const ip = "203.0.113.77";
      const first = await healthRoute.GET(
        new Request(HEALTH_URL, { headers: { "cf-connecting-ip": ip } })
      );
      expect(first.status).toBe(200);
      const second = await healthRoute.GET(
        new Request(HEALTH_URL, { headers: { "cf-connecting-ip": ip } })
      );
      expect(second.status).toBe(200);
      expect(creditCalls).toBe(1);
      const body = await second.json();
      expect(body.checks.openrouterCredits?.cachedAgeSeconds).toBeGreaterThanOrEqual(0);
    } finally {
      cache.healthProbeDeps.getOpenRouterCreditStatus = original;
    }
  });

  it("does not charge anonymous admission for a warm snapshot or heavy-cache hit", async () => {
    const { healthRoute } = await loadRoute();
    process.env.HEALTH_SNAPSHOT_TTL_MS = "60000";
    process.env.HEALTH_HEAVY_PER_IP_LIMIT = "2";
    process.env.HEALTH_HEAVY_SECTION_TTL_MS = "60000";
    resetRateLimiter();

    const request = () => new Request(HEALTH_URL);

    // Cold: the first heavy recompute charges once (one request, three sections).
    expect((await healthRoute.GET(request())).status).toBe(200);
    // Warm snapshot hits: no charge.
    for (let i = 0; i < 5; i++) {
      expect((await healthRoute.GET(request())).status).toBe(200);
    }
    // Control: exactly one of the two per-IP slots was used, so one more admission is allowed
    // and the next is refused.  Under the old order every GET charged and both would be refused.
    expect(admitAnonymousHeavyHealthProbe(request(), false).recomputeHeavySections).toBe(true);
    expect(admitAnonymousHeavyHealthProbe(request(), false).recomputeHeavySections).toBe(false);
  });

  it("background refresh recomputes heavy sections even when the triggering client is throttled", async () => {
    const { healthRoute, cache } = await loadRoute();
    process.env.HEALTH_SNAPSHOT_TTL_MS = "1";
    process.env.HEALTH_HEAVY_PER_IP_LIMIT = "1";
    process.env.HEALTH_HEAVY_SECTION_TTL_MS = "0";
    resetRateLimiter();
    let creditCalls = 0;
    const original = cache.healthProbeDeps.getOpenRouterCreditStatus;
    cache.healthProbeDeps.getOpenRouterCreditStatus = async () => {
      creditCalls += 1;
      return null;
    };
    try {
      expect((await healthRoute.GET(new Request(HEALTH_URL))).status).toBe(200);
      expect(creditCalls).toBe(1);
      // Exhaust the anonymous budget, so this client is throttled.
      admitAnonymousHeavyHealthProbe(new Request(HEALTH_URL), false);
      expect(admitAnonymousHeavyHealthProbe(new Request(HEALTH_URL), false).recomputeHeavySections).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Stale snapshot: served warm, and the scheduled refresh must recompute heavy sections.
      expect((await healthRoute.GET(new Request(HEALTH_URL))).status).toBe(200);
      await vi.waitFor(() => expect(creditCalls).toBe(2), { timeout: 5000 });
    } finally {
      cache.healthProbeDeps.getOpenRouterCreditStatus = original;
    }
  });

  it("merges live openrouter dependency state when credits are served from cache", async () => {
    const { healthRoute, cache } = await loadRoute();
    process.env.HEALTH_HEAVY_SECTION_TTL_MS = "60000";

    let creditCalls = 0;
    const originalCredits = cache.healthProbeDeps.getOpenRouterCreditStatus;
    cache.healthProbeDeps.getOpenRouterCreditStatus = async () => {
      creditCalls += 1;
      return {
        ok: true,
        remainingUsd: 5,
        totalUsd: 10,
        usedUsd: 5,
        thresholdUsd: 3,
        keyLimitThresholdUsd: 3,
        checkedAt: new Date().toISOString(),
        source: "inference" as const,
        keysChecked: false,
        keysWithLimit: 0,
        keysLimitReached: 0,
        keysLimitLow: 0,
        reasons: [] as const
      };
    };

    const originalSummaries = cache.healthProbeDeps.getServiceHealthSummaries;
    cache.healthProbeDeps.getServiceHealthSummaries = () =>
      [
        {
          service: "openrouter",
          keySource: "env" as const,
          intentionalOff: false,
          stoppedWorking: true,
          stoppedReasonKind: "consecutive-failures" as const,
          lastFailureError: "synthetic hard stop"
        }
      ] as ServiceHealthSummary[];

    try {
      const first = await healthRoute.GET(new Request(HEALTH_URL));
      const firstBody = await first.json();
      expect(firstBody.checks.dependencies?.openrouter?.ok).toBe(false);
      expect(creditCalls).toBe(1);

      cache.healthProbeDeps.getServiceHealthSummaries = () =>
        [
          {
            service: "openrouter",
            keySource: "env" as const,
            intentionalOff: false,
            stoppedWorking: false,
            stoppedReasonKind: null,
            lastFailureError: null
          }
        ] as ServiceHealthSummary[];

      const second = await healthRoute.GET(new Request(HEALTH_URL));
      const secondBody = await second.json();
      expect(creditCalls).toBe(1);
      expect(secondBody.checks.openrouterCredits?.cachedAgeSeconds).toBeGreaterThanOrEqual(0);
      expect(secondBody.checks.dependencies?.openrouter?.ok).toBe(true);
    } finally {
      cache.healthProbeDeps.getOpenRouterCreditStatus = originalCredits;
      cache.healthProbeDeps.getServiceHealthSummaries = originalSummaries;
    }
  });
});

describe("disk vs litestream storage degradation", () => {
  beforeEach(() => {
    __resetHeavyHealthSectionsForTests();
    process.env.HEALTH_HEAVY_SECTION_TTL_MS = "5000";
  });

  afterEach(() => {
    __resetHeavyHealthSectionsForTests();
    delete process.env.HEALTH_HEAVY_SECTION_TTL_MS;
  });

  async function storageDegradedWith(diskDegraded: boolean, litestreamDegraded: boolean): Promise<unknown> {
    const { healthRoute, cache } = await loadRoute();
    cache.__resetHealthSnapshotForTests();
    __resetHeavyHealthSectionsForTests();
    process.env.HEALTH_SNAPSHOT_TTL_MS = "0";
    // Seed the real section slots TTL-fresh, so the route merges these verdicts instead of
    // statting the host disk.  Shapes match what the route's own compute closures return.
    await runHeavyHealthSection(
      "disk",
      async () => ({
        dbSizeBytes: 1,
        walSizeBytes: 0,
        freeBytes: 100,
        totalBytes: 1000,
        latestLocalActivityAtMs: 0,
        diskDerivedStorageDegraded: diskDegraded
      }),
      { recomputeHeavySections: true }
    );
    await runHeavyHealthSection(
      "litestream",
      async () => ({ storageBody: { litestreamTiersDegraded: false }, litestreamDerivedStorageDegraded: litestreamDegraded }),
      { recomputeHeavySections: true }
    );
    const response = await healthRoute.GET(new Request(HEALTH_URL));
    const body = await response.json();
    expect(body.checks.storage?.diskCachedAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.checks.storage?.litestreamCachedAgeSeconds).toBeGreaterThanOrEqual(0);
    return body.checks.storageDegraded;
  }

  it("the route folds the disk verdict from the disk slot and the Litestream verdict from its own slot", async () => {
    const { db } = await loadRoute();
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    process.env.HEALTH_HEAVY_SECTION_TTL_MS = "60000";
    try {
      expect(await storageDegradedWith(true, false)).toBe(true);
      expect(await storageDegradedWith(false, true)).toBe(true);
      // Control: both clean is not degraded, so the two cases above are the slots talking.
      expect(await storageDegradedWith(false, false)).not.toBe(true);
    } finally {
      delete process.env.HEALTH_SNAPSHOT_TTL_MS;
      const { cache } = await loadRoute();
      cache.__resetHealthSnapshotForTests();
    }
  });
});
