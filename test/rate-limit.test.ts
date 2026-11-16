import { afterEach, describe, expect, it } from "vitest";
import {
  enforceRateLimit,
  RATE_LIMIT_BUCKET_CAP,
  rateLimit,
  rateLimiterBucketCount,
  resetRateLimiter
} from "../src/lib/rate-limit";

describe("rateLimit (sliding window)", () => {
  afterEach(() => resetRateLimiter());

  it("allows up to N requests then fails closed (429) on the N+1th in-window", () => {
    const opts = { limit: 3, windowMs: 60_000 };
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(rateLimit("user1:orders", opts, t0 + i).allowed).toBe(true);
    }
    const blocked = rateLimit("user1:orders", opts, t0 + 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("isolates buckets per key (userId+route)", () => {
    const opts = { limit: 1, windowMs: 60_000 };
    const t0 = 2_000_000;
    expect(rateLimit("userA:orders", opts, t0).allowed).toBe(true);
    expect(rateLimit("userA:orders", opts, t0).allowed).toBe(false); // same key blocked
    expect(rateLimit("userB:orders", opts, t0).allowed).toBe(true); // different user OK
    expect(rateLimit("userA:auth", opts, t0).allowed).toBe(true); // different route OK
  });

  it("frees capacity after the window slides past old hits", () => {
    const opts = { limit: 2, windowMs: 1_000 };
    const t0 = 3_000_000;
    expect(rateLimit("u:r", opts, t0).allowed).toBe(true);
    expect(rateLimit("u:r", opts, t0).allowed).toBe(true);
    expect(rateLimit("u:r", opts, t0).allowed).toBe(false);
    // Advance beyond the window — the two old hits age out.
    expect(rateLimit("u:r", opts, t0 + 1_001).allowed).toBe(true);
  });

  it("evicts fully expired subjects when the next request arrives", () => {
    const opts = { limit: 2, windowMs: 1_000 };
    const t0 = 3_500_000;
    rateLimit("expired-a", opts, t0);
    rateLimit("expired-b", opts, t0 + 1);
    expect(rateLimiterBucketCount()).toBe(2);

    rateLimit("current", opts, t0 + 1_002);
    expect(rateLimiterBucketCount()).toBe(1);
  });

  it("keeps the subject map at its hard cap under unique-key churn", () => {
    const opts = { limit: 1, windowMs: 60_000 };
    const t0 = 3_750_000;
    for (let i = 0; i < RATE_LIMIT_BUCKET_CAP + 25; i++) {
      rateLimit(`unique-${i}`, opts, t0);
    }
    expect(rateLimiterBucketCount()).toBe(RATE_LIMIT_BUCKET_CAP);
  });

  it("enforceRateLimit returns a 429 Response with Retry-After when over limit, null otherwise", () => {
    const opts = { limit: 1, windowMs: 60_000 };
    const t0 = 4_000_000;
    expect(enforceRateLimit("uX", "orders/cancel", opts, t0)).toBeNull();
    const res = enforceRateLimit("uX", "orders/cancel", opts, t0);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    expect(Number(res!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});
