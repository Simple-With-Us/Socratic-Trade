// In-process sliding-window rate limiter (no external deps, Node-runtime).
//
// Applied to SENSITIVE route handlers — OAuth start/callback and order placement/approval — keyed by
// `userId + route` so one user hammering "place order" can't exhaust the app and a per-user abuse spike
// is contained without affecting others. This is a single-process limiter: it protects one Next server
// instance (the deployment runs a single `next start`); it is NOT a distributed limiter.
//
// Failure policy (matches the task spec):
//   - OVER LIMIT  → fail CLOSED: caller returns 429.
//   - INTERNAL ERROR inside the limiter → fail OPEN: never block a legitimate request because the limiter
//     itself threw. `rateLimit()` swallows its own errors and allows the request.

import { z } from "zod";
import { clientIpTrustMarkerMatches, originLockEnabled, ORIGIN_CLIENT_IP_TRUST_HEADER } from "./cloudflare-origin-lock";

export interface RateLimitOptions {
  /** Max number of allowed requests within the window. */
  limit: number;
  /** Sliding window size in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining allowance in the current window (0 when blocked). */
  remaining: number;
  /** Epoch ms when the oldest in-window hit ages out (i.e. when capacity frees up). */
  resetAt: number;
  /** Suggested Retry-After in seconds (>= 1) when blocked; 0 when allowed. */
  retryAfterSeconds: number;
}

interface RateLimitBucket {
  /** Ascending hit timestamps still inside this bucket's window. */
  hits: number[];
  /** When every hit in this bucket is guaranteed to have expired. */
  expiresAt: number;
}

/** Hard bound against attacker-controlled subjects creating an unbounded process-memory map. */
export const RATE_LIMIT_BUCKET_CAP = 10_000;

interface RateLimiterState {
  buckets: Map<string, RateLimitBucket>;
  nextExpirySweepAt: number;
}

// Pin the limiter state to globalThis, like the dashboard event bus: the App Router and route
// bundles can load separate copies of this module in one process, and per-copy buckets would
// silently multiply every limit by the number of copies.
const globalForRateLimiter = globalThis as typeof globalThis & {
  __socraticRateLimiterState?: RateLimiterState;
};
const rateLimiterState: RateLimiterState =
  globalForRateLimiter.__socraticRateLimiterState ??
  (globalForRateLimiter.__socraticRateLimiterState = {
    buckets: new Map<string, RateLimitBucket>(),
    nextExpirySweepAt: Number.POSITIVE_INFINITY
  });
// Map insertion order is also LRU order: every access deletes+re-inserts the bucket.
const buckets = rateLimiterState.buckets;

function sweepExpiredBuckets(now: number): void {
  if (now < rateLimiterState.nextExpirySweepAt) return;
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const [key, bucket] of buckets) {
    if (bucket.expiresAt <= now) {
      buckets.delete(key);
    } else {
      nextExpiry = Math.min(nextExpiry, bucket.expiresAt);
    }
  }
  rateLimiterState.nextExpirySweepAt = nextExpiry;
}

function storeBucket(key: string, bucket: RateLimitBucket): void {
  const existed = buckets.delete(key);
  if (!existed) {
    // rateLimit() already performed the expiry sweep when its next-expiry watermark was due. If
    // every bucket is still live, evict the least-recently-used entry in O(1) before admitting the
    // new subject. Never rescan all 10k buckets on capped unique-key churn.
    while (buckets.size >= RATE_LIMIT_BUCKET_CAP) {
      const oldest = buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }
  buckets.set(key, bucket);
  rateLimiterState.nextExpirySweepAt = Math.min(rateLimiterState.nextExpirySweepAt, bucket.expiresAt);
}

/** Test/maintenance hook: drop all recorded hits. */
export function resetRateLimiter(): void {
  buckets.clear();
  rateLimiterState.nextExpirySweepAt = Number.POSITIVE_INFINITY;
}

/** Test/maintenance visibility without exposing bucket contents or rate-limit subjects. */
export function rateLimiterBucketCount(): number {
  return buckets.size;
}

/**
 * Record a hit for `key` and decide whether it is allowed under a sliding window. Pure in-memory; O(hits
 * in window). Fail-open: any internal error returns `allowed: true`.
 */
export function rateLimit(key: string, options: RateLimitOptions, now: number = Date.now()): RateLimitResult {
  try {
    const limit = Math.max(1, Math.floor(options.limit));
    const windowMs = Math.max(1, Math.floor(options.windowMs));
    const cutoff = now - windowMs;

    sweepExpiredBuckets(now);
    const existing = buckets.get(key);
    const recent = existing ? existing.hits.filter((t) => t > cutoff) : [];

    if (recent.length >= limit) {
      const oldest = recent[0] ?? now;
      const resetAt = oldest + windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
      storeBucket(key, { hits: recent, expiresAt: (recent.at(-1) ?? now) + windowMs });
      return { allowed: false, remaining: 0, resetAt, retryAfterSeconds };
    }

    recent.push(now);
    storeBucket(key, { hits: recent, expiresAt: now + windowMs });
    return {
      allowed: true,
      remaining: Math.max(0, limit - recent.length),
      resetAt: now + windowMs,
      retryAfterSeconds: 0
    };
  } catch {
    // Limiter internal error → fail OPEN. Never block a legitimate request on our own bug.
    return { allowed: true, remaining: 0, resetAt: now, retryAfterSeconds: 0 };
  }
}

/**
 * Same sliding window as `rateLimit`, without recording a hit.
 * A denied peek still drops expired timestamps. An allowed peek leaves the bucket unchanged,
 * so a caller can shed an already-full budget before taking a shared lease and record only
 * after that claim succeeds.
 */
export function peekRateLimit(key: string, options: RateLimitOptions, now: number = Date.now()): RateLimitResult {
  try {
    const limit = Math.max(1, Math.floor(options.limit));
    const windowMs = Math.max(1, Math.floor(options.windowMs));
    const cutoff = now - windowMs;

    sweepExpiredBuckets(now);
    const existing = buckets.get(key);
    const recent = existing ? existing.hits.filter((t) => t > cutoff) : [];

    if (recent.length >= limit) {
      const oldest = recent[0] ?? now;
      const resetAt = oldest + windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
      storeBucket(key, { hits: recent, expiresAt: (recent.at(-1) ?? now) + windowMs });
      return { allowed: false, remaining: 0, resetAt, retryAfterSeconds };
    }

    return {
      allowed: true,
      remaining: Math.max(0, limit - recent.length),
      resetAt: (recent[0] ?? now) + windowMs,
      retryAfterSeconds: 0
    };
  } catch {
    return { allowed: true, remaining: 0, resetAt: now, retryAfterSeconds: 0 };
  }
}

function rateLimitExceededResponse(result: RateLimitResult): Response | null {
  if (result.allowed) return null;
  return new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded. Please retry shortly." }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(result.retryAfterSeconds)
    }
  });
}

/** Zod schema for Cloudflare's overwritten connecting-IP header (IPv4 or IPv6). */
export const TrustedCloudflareClientIpSchema = z.union([z.ipv4(), z.ipv6()]);
export type TrustedCloudflareClientIp = z.infer<typeof TrustedCloudflareClientIpSchema>;

/**
 * Client address from CF-Connecting-IP.
 * With REQUIRE_CLOUDFLARE_ORIGIN off (the default), a parseable header is returned.
 * With the lock on, the header counts only when the Node hook has marked this
 * request as Cloudflare-fronted. A direct caller cannot forge that mark, and
 * health, loopback, and Tailscale admissions do not set it.
 * Returns null when the header is missing, fails validation, or is untrusted,
 * so callers can answer HTTP 400 rather than keying a limiter on a forged string.
 */
export function trustedCloudflareClientIp(req: Request): TrustedCloudflareClientIp | null {
  const parsed = TrustedCloudflareClientIpSchema.safeParse(
    req.headers.get("cf-connecting-ip")?.trim()
  );
  if (!parsed.success) return null;
  if (originLockEnabled() && !clientIpTrustMarkerMatches(req.headers.get(ORIGIN_CLIENT_IP_TRUST_HEADER))) {
    return null;
  }
  return parsed.data;
}

/** Sensible defaults for the route classes we guard. Override per-route as needed. */
export const RATE_LIMITS = {
  /** OAuth start/callback: a handful per minute is plenty for an interactive login dance. */
  oauth: { limit: 10, windowMs: 60_000 },
  /** Order placement / approval: cap bursts; protects the broker path and the human-approval gate. */
  orders: { limit: 20, windowMs: 60_000 },
  /** LLM chat: each request can spend operator-funded tokens, so cap per-user bursts. 30/min is
   *  generous for an interactive chat while containing a runaway loop or a scripted abuse spike. */
  chat: { limit: 30, windowMs: 60_000 },
  /** Market scan: read-only but fans out to several data providers (Yahoo, Massive, broker quotes),
   *  so a tight-loop refresh can hammer upstreams. 30/min covers manual refreshes with headroom. */
  scan: { limit: 30, windowMs: 60_000 },
  /** Weekly screens read: cache / value-only, cheap. */
  weeklyDigest: { limit: 30, windowMs: 60_000 },
  /** Weekly screens refresh: grouped daily + per-symbol OHLC.  Keep this tight. */
  weeklyDigestRefresh: { limit: 6, windowMs: 60_000 },
  /** Whole-market grouped daily bars. One call is every ticker, so keep it with the grouped-daily cap. */
  flatfile: { limit: 6, windowMs: 60_000 },
  /** Paid strategy tuning performs a full LLM review; contain retries and compromised-session spend. */
  strategyTuning: { limit: 10, windowMs: 60_000 },
  /** Peer reads from App A (congress.trade) */
  peerRead: { limit: 120, windowMs: 60_000 },
  /** Inbound congress.trade webhook pushes (App A -> App B). */
  congressWebhook: { limit: 120, windowMs: 60_000 },
  /** Inbound congress.trade securities gap-fill import (App A -> App B; ~130+ chunked POSTs/nightly). */
  securitiesImport: { limit: 600, windowMs: 60_000 },
  /** Failed bearer on securities import — cap audit rows from internet credential stuffing. */
  securitiesImportUnauth: { limit: 30, windowMs: 60_000 },
  /** Failed HMAC/bearer on congress webhook — cap audit rows after junk signatures force body+HMAC. */
  congressWebhookUnauth: { limit: 60, windowMs: 60_000 },
  /** Rejected TradingView webhook (bad IP/secret) - cap audit rows from unauthenticated floods. */
  tradingviewWebhookUnauth: { limit: 60, windowMs: 60_000 },
  /** Settings writes (API-key upsert/delete, policy save). A human saves settings a few times
   *  a minute at most; 30/min contains a buggy or compromised session (policy saves can fan out
   *  to symbol-quote checks and a live broker account verification) without ever being felt. */
  settingsWrite: { limit: 30, windowMs: 60_000 },
  /** Test-notification send: each call fans out to the user's push/webhook channels. */
  notificationTest: { limit: 10, windowMs: 60_000 },
  /**
   * Admin ingest/backfill starts (corpus reembed, SEC reindex/seed/requeue, forced web-source
   * refresh, earnings-call probe/burst). Per admin, per route. Tighter than interactive chat/scan.
   * Routes that already have an hourly operation budget keep that budget; this stops the burst
   * before the job starts, including paths the operation guard does not wrap.
   */
  adminIngest: { limit: 6, windowMs: 10 * 60_000 },
  /** Status reads on those same admin routes (vector stats, ingest receipts, chat transcript). */
  adminIngestRead: { limit: 30, windowMs: 60_000 }
} as const satisfies Record<string, RateLimitOptions>;

/**
 * Convenience wrapper for route handlers: builds the `userId:route` key and returns a ready-to-send 429
 * `Response` (with `Retry-After`) when over limit, or `null` to proceed.
 */
export function enforceRateLimit(
  userId: string,
  route: string,
  options: RateLimitOptions,
  now: number = Date.now()
): Response | null {
  return rateLimitExceededResponse(rateLimit(`${userId}:${route}`, options, now));
}

/**
 * 429 when the next hit would be denied, without recording that hit.
 * Pair with `enforceRateLimit` after a lease claim so a 409 duplicate stays free and an
 * already-full budget never takes the lease.
 */
export function previewRateLimit(
  userId: string,
  route: string,
  options: RateLimitOptions,
  now: number = Date.now()
): Response | null {
  return rateLimitExceededResponse(peekRateLimit(`${userId}:${route}`, options, now));
}
