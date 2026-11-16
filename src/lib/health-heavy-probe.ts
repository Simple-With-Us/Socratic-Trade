import { originLockEnabled } from "@/lib/cloudflare-origin-lock";
import { rateLimit, type RateLimitOptions, trustedCloudflareClientIp } from "@/lib/rate-limit";

export type HeavyHealthSectionKey = "openrouter" | "disk" | "litestream";

export type HeavySectionResult<T> = {
  value: T;
  /** Seconds since this section was last computed; null on a fresh compute. */
  cachedAgeSeconds: number | null;
  /** Served from cache without recomputing (TTL hit or rate limit). */
  fromCache: boolean;
};

type SectionSlot<T> = {
  at: number;
  value: T | undefined;
  inflight: Promise<{ at: number; value: T }> | null;
};

const globalForHeavyHealth = globalThis as typeof globalThis & {
  __socraticHealthHeavySectionSlots?: Map<HeavyHealthSectionKey, SectionSlot<unknown>>;
};

const sectionSlots =
  globalForHeavyHealth.__socraticHealthHeavySectionSlots ??
  (globalForHeavyHealth.__socraticHealthHeavySectionSlots =
    new Map<HeavyHealthSectionKey, SectionSlot<unknown>>());

function slotFor<T>(key: HeavyHealthSectionKey): SectionSlot<T> {
  const existing = sectionSlots.get(key);
  if (existing) return existing as SectionSlot<T>;
  const created: SectionSlot<T> = { at: 0, value: undefined, inflight: null };
  sectionSlots.set(key, created as SectionSlot<unknown>);
  return created;
}

/** Default 20s — memoizes OpenRouter / statfs / Litestream IPC+log within one process. */
export function heavyHealthSectionTtlMs(): number {
  const raw = process.env.HEALTH_HEAVY_SECTION_TTL_MS;
  if (raw != null && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 20_000;
}

export function heavyHealthRateLimits(): { perIp: RateLimitOptions; global: RateLimitOptions } {
  const perIpLimit = Number(process.env.HEALTH_HEAVY_PER_IP_LIMIT);
  const globalLimit = Number(process.env.HEALTH_HEAVY_GLOBAL_LIMIT);
  return {
    perIp: {
      limit: Number.isFinite(perIpLimit) && perIpLimit > 0 ? Math.floor(perIpLimit) : 12,
      windowMs: 60_000
    },
    global: {
      limit: Number.isFinite(globalLimit) && globalLimit > 0 ? Math.floor(globalLimit) : 60,
      windowMs: 60_000
    }
  };
}

/**
 * Per-IP limiter key for an anonymous probe.  CF-Connecting-IP is only a client address
 * when the Cloudflare origin lock is on and has marked this request as Cloudflare-fronted.
 * With REQUIRE_CLOUDFLARE_ORIGIN unset, anyone can send that header, and rotating it would
 * mint a fresh per-IP budget per request, so every anonymous caller shares one bucket.
 */
export function heavyHealthClientKey(request: Request): string {
  if (!originLockEnabled()) return "unknown-ip";
  return trustedCloudflareClientIp(request) ?? "unknown-ip";
}

/**
 * Charges the anonymous heavy-recompute budget.  Call it only when a heavy section is
 * actually about to recompute (see `runHeavyHealthSection`'s `recomputeHeavySections`
 * callback); warm-snapshot and heavy-cache hits must not consume it.  Ops-token detailed
 * view is never throttled.
 */
export function admitAnonymousHeavyHealthProbe(
  request: Request,
  detailed: boolean,
  now = Date.now()
): { recomputeHeavySections: boolean } {
  if (detailed) return { recomputeHeavySections: true };
  const limits = heavyHealthRateLimits();
  const clientIp = heavyHealthClientKey(request);
  const global = rateLimit("health-heavy:global", limits.global, now);
  const perIp = rateLimit(`health-heavy:ip:${clientIp}`, limits.perIp, now);
  const allowed = global.allowed && perIp.allowed;
  return { recomputeHeavySections: allowed };
}

function cachedAgeSeconds(at: number, now: number): number {
  return Math.max(0, Math.round((now - at) / 1000));
}

/**
 * Recompute permission for heavy sections: a fixed answer, or a callback that charges the
 * admission budget.  The callback runs only when a section would otherwise recompute, so a
 * TTL-fresh hit or a join onto an in-flight compute never spends budget.
 */
export type HeavyRecomputePermission = boolean | (() => boolean);

/** Memoize a permission callback so one request charges admission at most once. */
export function onceHeavyRecomputePermission(admit: () => boolean): () => boolean {
  let decided: boolean | undefined;
  return () => (decided ??= admit());
}

/**
 * TTL + single-flight cache for one heavy /api/health subsection.
 * When recompute is denied, returns the last value if any exists
 * (cache miss still computes once so the probe never lies about a missing field).
 */
export async function runHeavyHealthSection<T>(
  key: HeavyHealthSectionKey,
  compute: () => Promise<T>,
  options: { recomputeHeavySections: HeavyRecomputePermission; now?: number }
): Promise<HeavySectionResult<T>> {
  const now = options.now ?? Date.now();
  const ttl = heavyHealthSectionTtlMs();
  const slot = slotFor<T>(key);

  const serveCached = (at: number, value: T): HeavySectionResult<T> => ({
    value,
    cachedAgeSeconds: cachedAgeSeconds(at, now),
    fromCache: true
  });

  const hasCache = slot.at > 0 && slot.value !== undefined;
  const ttlFresh = ttl > 0 && hasCache && now - slot.at < ttl;

  if (hasCache && ttlFresh) {
    return serveCached(slot.at, slot.value as T);
  }

  if (slot.inflight) {
    const resolved = await slot.inflight;
    return serveCached(resolved.at, resolved.value);
  }

  const permission = options.recomputeHeavySections;
  const recompute = typeof permission === "function" ? permission() : permission;
  if (hasCache && !recompute) {
    return serveCached(slot.at, slot.value as T);
  }

  slot.inflight = (async () => {
    const value = await compute();
    const at = now;
    slot.at = at;
    slot.value = value;
    return { at, value };
  })();

  try {
    const resolved = await slot.inflight;
    return {
      value: resolved.value,
      cachedAgeSeconds: null,
      fromCache: false
    };
  } finally {
    slot.inflight = null;
  }
}

export function __resetHeavyHealthSectionsForTests(): void {
  sectionSlots.clear();
}
