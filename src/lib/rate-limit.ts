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

// Map insertion order is also LRU order: every access deletes+re-inserts the bucket.
const buckets = new Map<string, RateLimitBucket>();
let nextExpirySweepAt = Number.POSITIVE_INFINITY;

function sweepExpiredBuckets(now: number): void {
  if (now < nextExpirySweepAt) return;
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const [key, bucket] of buckets) {
    if (bucket.expiresAt <= now) {
      buckets.delete(key);
    } else {
      nextExpiry = Math.min(nextExpiry, bucket.expiresAt);
    }
  }
  nextExpirySweepAt = nextExpiry;
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
  nextExpirySweepAt = Math.min(nextExpirySweepAt, bucket.expiresAt);
}

/** Test/maintenance hook: drop all recorded hits. */
export function resetRateLimiter(): void {
  buckets.clear();
  nextExpirySweepAt = Number.POSITIVE_INFINITY;
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

/** Zod schema for Cloudflare's overwritten connecting-IP header (IPv4 or IPv6). */
export const TrustedCloudflareClientIpSchema = z.union([z.ipv4(), z.ipv6()]);
export type TrustedCloudflareClientIp = z.infer<typeof TrustedCloudflareClientIpSchema>;

/**
 * Production is Cloudflare-fronted; only the overwritten connecting-IP header is a trusted
 * client address. Returns null when the header is missing or fails Zod IP validation so
 * callers can answer HTTP 400 rather than keying the limiter on a forged / fallback string.
 */
export function trustedCloudflareClientIp(req: Request): TrustedCloudflareClientIp | null {
  const parsed = TrustedCloudflareClientIpSchema.safeParse(
    req.headers.get("cf-connecting-ip")?.trim()
  );
  return parsed.success ? parsed.data : null;
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
  congressWebhookUnauth: { limit: 60, windowMs: 60_000 }
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
  const result = rateLimit(`${userId}:${route}`, options, now);
  if (result.allowed) return null;
  return new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded. Please retry shortly." }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(result.retryAfterSeconds)
    }
  });
}
