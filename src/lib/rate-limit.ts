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

// key -> ascending list of hit timestamps (ms) still inside the window.
const buckets = new Map<string, number[]>();

/** Test/maintenance hook: drop all recorded hits. */
export function resetRateLimiter(): void {
  buckets.clear();
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

    const existing = buckets.get(key);
    const recent = existing ? existing.filter((t) => t > cutoff) : [];

    if (recent.length >= limit) {
      buckets.set(key, recent);
      const oldest = recent[0] ?? now;
      const resetAt = oldest + windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
      return { allowed: false, remaining: 0, resetAt, retryAfterSeconds };
    }

    recent.push(now);
    buckets.set(key, recent);
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
  scan: { limit: 30, windowMs: 60_000 }
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
