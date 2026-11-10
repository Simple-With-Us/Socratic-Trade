import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OperationGuardRejectionSchema } from "@jaywedgeworth22/congress-trading-shared";
import {
  ADMIN_OPERATION_LIMITS,
  adminOperationIdentity,
  resetAdminOperationInFlight,
  withAdminOperationGuard
} from "../src/lib/admin-operation-guard";
import { resetRateLimiter } from "../src/lib/rate-limit";
import { resetTuningSingleFlight } from "../src/lib/tuning-singleflight";
import { rateLimitedOperationResponse } from "../src/lib/operation-guard-response";
import { OPERATION_LEASE_GROUPS, runWithOperationLease } from "../src/lib/operation-lease";

function adminRequest(email: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request("https://socratictrade.com/api/admin/test", {
    headers: {
      "x-authenticated-user-email": email,
      ...extraHeaders
    }
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-admin-operation-guard-${randomUUID()}.db`)}`;
});

describe("admin operation guard", () => {
  beforeEach(() => {
    resetRateLimiter();
    resetAdminOperationInFlight();
    resetTuningSingleFlight();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRateLimiter();
    resetAdminOperationInFlight();
    resetTuningSingleFlight();
  });

  it("defines a named budget and concurrency policy for every expensive admin operation", () => {
    expect(Object.keys(ADMIN_OPERATION_LIMITS).sort()).toEqual([
      "backtest-ic",
      "congress-score-eval",
      "congress-share",
      "earningscalls",
      "refresh-websource",
      "reindex-10k",
      "reindex-8k",
      "robinhood-probe",
      "sec-ingest-seed",
      "tuning-dry-run"
    ]);
    for (const config of Object.values(ADMIN_OPERATION_LIMITS)) {
      expect(config.limit).toBeGreaterThan(0);
      expect(config.windowMs).toBeGreaterThan(0);
      if ("concurrencyGroup" in config) expect(config.concurrencyGroup).not.toBe("");
      else expect(config.sharedSingleFlight).toBe("tuning");
    }
  });

  it("never emits an invalid Retry-After value", async () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
      const response = rateLimitedOperationResponse("test-operation", invalid);
      expect(response.headers.get("retry-after")).toBe("1");
      await expect(response.json()).resolves.toMatchObject({
        code: "rate_limited",
        retryAfterSeconds: 1
      });
    }
  });

  it("keys admission by the trusted email-derived user and ignores client user-id hints", () => {
    const first = adminOperationIdentity(adminRequest("Ops.One@Example.com", { "x-user-id": "attacker-a" }));
    const second = adminOperationIdentity(adminRequest("ops.one@example.com", { "x-user-id": "attacker-b" }));
    const other = adminOperationIdentity(adminRequest("ops.two@example.com"));

    expect(first).toBe(second);
    expect(first).not.toBe("attacker-a");
    expect(first).not.toBe(other);
  });

  it("returns an explicit 429 with Retry-After before invoking over-budget work", async () => {
    const request = adminRequest("rate-limit@example.com");
    const operation = "congress-score-eval" as const;
    const run = vi.fn(async () => new Response("ok"));

    for (let i = 0; i < ADMIN_OPERATION_LIMITS[operation].limit; i += 1) {
      expect((await withAdminOperationGuard(request, operation, run)).status).toBe(200);
    }

    const blocked = await withAdminOperationGuard(request, operation, run);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    const body = await blocked.json();
    expect(() => OperationGuardRejectionSchema.parse(body)).not.toThrow();
    expect(body).toMatchObject({
      ok: false,
      code: "rate_limited",
      operation,
      retryAfterSeconds: expect.any(Number),
      error: expect.any(String)
    });
    expect(run).toHaveBeenCalledTimes(ADMIN_OPERATION_LIMITS[operation].limit);

    const otherAdminRun = vi.fn(async () => new Response("other"));
    const otherAdmin = await withAdminOperationGuard(
      adminRequest("other-rate-limit@example.com"),
      operation,
      otherAdminRun
    );
    expect(otherAdmin.status).toBe(200);
    expect(otherAdminRun).toHaveBeenCalledOnce();
  });

  it("returns 409 for duplicate per-admin work while allowing another admin", async () => {
    const latch = deferred();
    const first = withAdminOperationGuard(adminRequest("admin-a@example.com"), "robinhood-probe", async () => {
      await latch.promise;
      return new Response("first");
    });

    const duplicate = await withAdminOperationGuard(
      adminRequest("admin-a@example.com"),
      "robinhood-probe",
      async () => new Response("duplicate")
    );
    const otherAdmin = await withAdminOperationGuard(
      adminRequest("admin-b@example.com"),
      "robinhood-probe",
      async () => new Response("other")
    );

    expect(duplicate.status).toBe(409);
    const duplicateBody = await duplicate.json();
    expect(() => OperationGuardRejectionSchema.parse(duplicateBody)).not.toThrow();
    expect(duplicateBody).toMatchObject({
      ok: false,
      code: "operation_in_flight",
      operation: "robinhood-probe",
      activeOperation: "robinhood-probe",
      error: expect.any(String)
    });
    expect(otherAdmin.status).toBe(200);
    latch.resolve();
    expect((await first).status).toBe(200);
  });

  it("excludes overlapping manual paid RAG reindexes across routes and admins without debiting the rejected operation", async () => {
    const latch = deferred();
    const eightK = withAdminOperationGuard(adminRequest("admin-a@example.com"), "reindex-8k", async () => {
      await latch.promise;
      return new Response("8-k");
    });

    const tenK = await withAdminOperationGuard(
      adminRequest("admin-b@example.com"),
      "reindex-10k",
      async () => new Response("10-k")
    );

    expect(tenK.status).toBe(409);
    const tenKBody = await tenK.json();
    expect(() => OperationGuardRejectionSchema.parse(tenKBody)).not.toThrow();
    expect(tenKBody).toMatchObject({
      ok: false,
      code: "operation_in_flight",
      operation: "reindex-10k",
      activeOperation: "reindex-8k",
      error: expect.any(String)
    });
    latch.resolve();
    expect((await eightK).status).toBe(200);

    const tenKRequest = adminRequest("admin-b@example.com");
    for (let i = 0; i < ADMIN_OPERATION_LIMITS["reindex-10k"].limit; i += 1) {
      expect((await withAdminOperationGuard(
        tenKRequest,
        "reindex-10k",
        async () => new Response("accepted")
      )).status).toBe(200);
    }
    expect((await withAdminOperationGuard(
      tenKRequest,
      "reindex-10k",
      async () => new Response("over-budget")
    )).status).toBe(429);
  });

  it("passes its opaque durable claim so the matching core boundary reuses the lease", async () => {
    const response = await withAdminOperationGuard(
      adminRequest("claim-reuse@example.com"),
      "reindex-8k",
      async (claim) => {
        expect(claim).toBeDefined();
        const nested = await runWithOperationLease(
          { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "nested-reindex", claim },
          async () => new Response("nested")
        );
        expect(nested.acquired).toBe(true);
        return nested.acquired ? nested.value : new Response("unexpected busy", { status: 500 });
      }
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("nested");
  });

  it("releases the single-flight entry after an operation throws", async () => {
    const request = adminRequest("throwing@example.com");
    await expect(
      withAdminOperationGuard(request, "tuning-dry-run", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const retry = await withAdminOperationGuard(
      request,
      "tuning-dry-run",
      async () => new Response("recovered")
    );
    expect(retry.status).toBe(200);
  });

  it("does not debit rate quota for duplicate in-flight spam", async () => {
    const request = adminRequest("duplicate-spam@example.com");
    const operation = "congress-score-eval" as const;
    const latch = deferred();
    const first = withAdminOperationGuard(request, operation, async () => {
      await latch.promise;
      return new Response("first");
    });

    for (let i = 0; i < ADMIN_OPERATION_LIMITS[operation].limit + 3; i += 1) {
      const duplicate = await withAdminOperationGuard(
        request,
        operation,
        async () => new Response("must-not-run")
      );
      expect(duplicate.status).toBe(409);
      await expect(duplicate.json()).resolves.toMatchObject({ code: "operation_in_flight" });
    }

    latch.resolve();
    expect((await first).status).toBe(200);

    // The accepted first entrant spent one hit. All remaining allowance is still available,
    // proving the 409 spam above did not debit quota.
    for (let i = 1; i < ADMIN_OPERATION_LIMITS[operation].limit; i += 1) {
      const accepted = await withAdminOperationGuard(
        request,
        operation,
        async () => new Response("accepted")
      );
      expect(accepted.status).toBe(200);
    }
    const limited = await withAdminOperationGuard(
      request,
      operation,
      async () => new Response("over-budget")
    );
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ code: "rate_limited" });
  });

  it("does not let an old completion release a successor claim", async () => {
    const request = adminRequest("successor@example.com");
    const firstLatch = deferred();
    const secondLatch = deferred();
    const first = withAdminOperationGuard(request, "backtest-ic", async () => {
      await firstLatch.promise;
      return new Response("first");
    });

    // Simulate the only replacement edge available to this in-process guard: a maintenance reset
    // followed by a new claim while the old callback is still unwinding.
    resetAdminOperationInFlight();
    const second = withAdminOperationGuard(request, "backtest-ic", async () => {
      await secondLatch.promise;
      return new Response("second");
    });

    firstLatch.resolve();
    expect((await first).status).toBe(200);

    const third = await withAdminOperationGuard(
      request,
      "backtest-ic",
      async () => new Response("must-not-run")
    );
    expect(third.status).toBe(409);
    await expect(third.json()).resolves.toMatchObject({
      code: "operation_in_flight",
      activeOperation: "backtest-ic"
    });

    secondLatch.resolve();
    expect((await second).status).toBe(200);
  });
});
