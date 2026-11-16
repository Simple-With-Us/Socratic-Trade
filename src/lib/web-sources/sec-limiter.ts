// Host-wide aggregate SEC EDGAR rate limiter (politeness and 429 Retry-After handling).
// Enforces a strict token-bucket model across all SEC fetches to stay within fair-access rules.

import { sleep } from "./http";

class SecRateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // tokens per millisecond
  private lastRefill: number;
  private pauseUntil: number;
  private queue: Array<() => void>;

  constructor() {
    // Default: 4 requests per second, maximum burst of 8
    const limitSec = Number(process.env.SEC_RATE_LIMIT ?? 4);
    const burst = Number(process.env.SEC_BURST_CAPACITY ?? 8);

    this.maxTokens = burst > 0 ? burst : 8;
    this.tokens = this.maxTokens;
    this.refillRate = (limitSec > 0 ? limitSec : 4) / 1000;
    this.lastRefill = Date.now();
    this.pauseUntil = 0;
    this.queue = [];
  }

  /** Refill the token bucket based on elapsed time. */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;

    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  /** Report a 429 from the SEC and pause the limiter according to the Retry-After header. */
  public report429(retryAfterHeader?: string | null): void {
    let seconds = 10; // safe default backoff
    if (retryAfterHeader) {
      const parsed = parseInt(retryAfterHeader, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        seconds = parsed;
      } else {
        const date = Date.parse(retryAfterHeader);
        if (Number.isFinite(date)) {
          seconds = Math.max(1, Math.round((date - Date.now()) / 1000));
        }
      }
    }
    const pauseMs = seconds * 1000;
    this.pauseUntil = Date.now() + pauseMs;
    console.warn(`[sec-limiter] SEC 429 rate limit hit. Pausing EDGAR requests for ${seconds}s.`);
  }

  /**
   * Report a 403 from the SEC. EDGAR signals automated-access blocks with 403 (not 429) and no
   * Retry-After, so this is an IP-level "stop entirely" signal, not a per-request failure —
   * pause the whole limiter for a cooldown (default 10 min, `SEC_403_COOLDOWN_SECONDS`).
   */
  public report403(): void {
    const configured = Number(process.env.SEC_403_COOLDOWN_SECONDS ?? 600);
    const seconds = Number.isFinite(configured) && configured > 0 ? Math.max(60, configured) : 600;
    const until = Date.now() + seconds * 1000;
    if (until > this.pauseUntil) {
      this.pauseUntil = until;
      console.warn(`[sec-limiter] SEC 403 (automated-access block). Pausing EDGAR requests for ${seconds}s.`);
    }
  }

  /** ISO instant the current pause ends, or null when not paused. Lets callers defer queued work
   *  (e.g. the SEC ingest worker) to the same horizon instead of spinning against the block. */
  public pausedUntilIso(): string | null {
    return this.pauseUntil > Date.now() ? new Date(this.pauseUntil).toISOString() : null;
  }

  /** Wait and acquire a token before performing an SEC request. */
  public async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) return;

    // Check if we are currently paused due to a 429
    const now = Date.now();
    if (now < this.pauseUntil) {
      const delay = this.pauseUntil - now;
      await sleep(delay);
      this.processQueue();
      return;
    }

    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      const next = this.queue.shift();
      if (next) {
        next();
      }
      // Trigger process of any other queued requests in the next tick
      if (this.queue.length > 0) {
        setTimeout(() => this.processQueue(), 0);
      }
    } else {
      // Not enough tokens: calculate time until we have at least 1 token and wait
      const needed = 1 - this.tokens;
      const waitMs = Math.ceil(needed / this.refillRate);
      await sleep(waitMs);
      this.processQueue();
    }
  }
}

// Export a single aggregate host-wide limiter singleton
export const secLimiter = new SecRateLimiter();
