import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceHealthSummary } from "../src/lib/db-health";
import { resetRateLimiter } from "../src/lib/rate-limit";
import {
  __resetHeavyHealthSectionsForTests,
  admitAnonymousHeavyHealthProbe,
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

  it("consumes anonymous admission before a warm snapshot short-circuit", async () => {
    const { healthRoute, cache } = await loadRoute();
    process.env.HEALTH_SNAPSHOT_TTL_MS = "60000";
    process.env.HEALTH_HEAVY_PER_IP_LIMIT = "2";
    process.env.HEALTH_HEAVY_SECTION_TTL_MS = "60000";
    resetRateLimiter();

    const ip = "203.0.113.99";
    const request = () => new Request(HEALTH_URL, { headers: { "cf-connecting-ip": ip } });

    const first = await healthRoute.GET(request());
    expect(first.status).toBe(200);

    const second = await healthRoute.GET(request());
    expect(second.status).toBe(200);

    expect(admitAnonymousHeavyHealthProbe(request(), false).recomputeHeavySections).toBe(false);
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

  it("keeps disk-derived storageDegraded in the disk section only", async () => {
    const now = 1_000_000;
    const disk = await runHeavyHealthSection(
      "disk",
      async () => ({
        freeBytes: 100,
        walSizeBytes: 0,
        diskDerivedStorageDegraded: true
      }),
      { recomputeHeavySections: true, now }
    );
    await runHeavyHealthSection(
      "litestream",
      async () => ({
        litestreamDerivedStorageDegraded: false
      }),
      { recomputeHeavySections: true, now }
    );
    const litestream = await runHeavyHealthSection(
      "litestream",
      async () => ({
        litestreamDerivedStorageDegraded: true
      }),
      { recomputeHeavySections: false, now }
    );
    const mergedDegraded = disk.value.diskDerivedStorageDegraded || litestream.value.litestreamDerivedStorageDegraded;
    expect(disk.fromCache).toBe(false);
    expect(litestream.fromCache).toBe(true);
    expect(mergedDegraded).toBe(true);
  });
});
