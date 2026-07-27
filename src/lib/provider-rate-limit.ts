// Per-provider request pacing for outbound market-data REST calls, plus a small helper
// to scrub API keys out of text before it is stored/logged (api_health_log rows are
// surfaced verbatim through connections-health / the ops snapshot, so an embedded key
// there is a real secret leak, not a cosmetic wart).
//
// Why a SEPARATE limiter from data-providers.ts's CONCURRENCY chunking: that chunking
// caps how many symbols a single provider processes in parallel per batch, but does
// nothing to pace the RATE of dispatch across batches/endpoints — e.g. Finnhub fires 5
// endpoints x 5 symbols = 25 near-simultaneous requests per chunk with zero inter-chunk
// delay. This module gates the actual outbound dispatch, independent of caller batching,
// so the cascade's chunking logic can stay untouched.

import { createDurableMap, hasHydratedNamespace, resetDurableStateCacheForTests } from "./durable-state";

export interface ProviderLimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: ProviderLimiterClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
};

export interface ProviderLimiterConfig {
  /** Max requests in flight at once for this provider. Infinity = uncapped. */
  concurrency: number;
  /** Minimum spacing (ms) between successive dispatch starts. 0 = no pacing. */
  minIntervalMs: number;
}

// Hard defaults for providers with a real, known upstream limit. A provider with NO
// entry here (and no env override) resolves to `undefined` — fully unlimited, zero
// bookkeeping — so adding a new keyed provider never accidentally throttles it.
const HARD_DEFAULTS: Record<string, { perMin?: number; minIntervalMs?: number; concurrency?: number }> = {
  // Free tier is 60 req/min; 50 leaves headroom so the fetchWithRetry 429 backoff isn't
  // fighting the pacer too.
  finnhub: { perMin: 50 },
  // Free tier is ~1 req/sec (AND a 25/day cap the pacer can't do anything about) — strictly
  // serial with >1s spacing keeps every burst that trips the per-second gate from happening.
  "alpha-vantage": { minIntervalMs: 1100, concurrency: 1 },
  // No published limit, but the prod egress IP gets HTTP 429 on a cold burst while paced,
  // low-concurrency requests succeed — gentle pacing, not parallel bursts.
  "yahoo-finance": { minIntervalMs: 400, concurrency: 2 },
  // Public Nasdaq.com JSON endpoints (no key) — gentle pacing to avoid 429 bursts.
  "nasdaq-quote": { minIntervalMs: 250, concurrency: 2 },
  // Free "Basic" tier is 8 API credits/min and each symbol in a batch /quote costs ONE credit
  // (see docs/data-provider-mcp-evaluation.md). The REAL budget control now lives in the provider
  // (data-providers.ts): it caps a call to `twelveDataCreditsPerMin()` symbols AND gates to one
  // credit-budget call per rolling minute window, SKIPPING (not queueing) extra scans so they
  // aren't stalled. This entry is just a light serialization backstop (concurrency 1, short spacing)
  // for any cross-path race; it deliberately does NOT use a 60s interval, which would re-introduce
  // the multi-minute scan stall the window-gate exists to avoid. The old 10s/120-symbol config
  // burst ~120 credits in one call and was 100% HTTP 429 in prod.
  twelvedata: { minIntervalMs: 2_000, concurrency: 1 },
  // RapidAPI "Basic" tier for both Mboum Finance and YH Finance 15 is documented as 1 req/sec —
  // strictly serial with >1s spacing, same shape as the alpha-vantage entry above. The REAL
  // throttle for these two is their tiny persisted daily budget (see rapidapi-quota.ts —
  // Mboum ~16/day, YH Finance ~3/day); this pacer just keeps whatever few calls DO fire from
  // bursting past the per-second gate within one scan.
  "mboum-finance": { minIntervalMs: 1100, concurrency: 1 },
  "yahoo-finance15": { minIntervalMs: 1100, concurrency: 1 },
  // Alpha Vantage's RapidAPI-hosted plan is a separate subscription/quota shape from the native
  // key pool above (500/day, 5/min — NOT the native 25/day) — see alpha-vantage-key-pool.ts's
  // own doc comment for why native pacing stays keyed by provider name only; this is a distinct
  // provider name so the two transports never share one pacer/quota by accident.
  "alpha-vantage-rapidapi": { perMin: 5, concurrency: 1 },
  "yh-finance-apidojo": { minIntervalMs: 1100, concurrency: 1 },
  "real-time-finance-data": { minIntervalMs: 500, concurrency: 1 },
  "seeking-alpha-rapidapi": { minIntervalMs: 1100, concurrency: 1 },
  filingapi: { minIntervalMs: 400, concurrency: 1 }
};

function envKeyFor(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function finiteEnvNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Effective limiter config for a provider: env overrides win over hard defaults, and
 * `_MIN_INTERVAL_MS` wins over `_PER_MIN` when both env vars are set for the same
 * provider. Returns `undefined` when neither env nor a hard default applies — meaning
 * unlimited (callers must treat that as a passthrough, not a zero-wait limiter).
 */
export function resolveProviderLimiterConfig(provider: string): ProviderLimiterConfig | undefined {
  const hard = HARD_DEFAULTS[provider];
  const key = envKeyFor(provider);

  const envPerMin = finiteEnvNumber(`PROVIDER_RATE_LIMIT_${key}_PER_MIN`);
  const envMinInterval = finiteEnvNumber(`PROVIDER_RATE_LIMIT_${key}_MIN_INTERVAL_MS`);
  const envConcurrency = finiteEnvNumber(`PROVIDER_RATE_LIMIT_${key}_CONCURRENCY`);

  const minIntervalMs =
    envMinInterval !== undefined && envMinInterval >= 0
      ? envMinInterval
      : envPerMin !== undefined && envPerMin > 0
        ? Math.ceil(60_000 / envPerMin)
        : hard?.minIntervalMs ?? (hard?.perMin ? Math.ceil(60_000 / hard.perMin) : undefined);

  const concurrency = envConcurrency !== undefined && envConcurrency > 0 ? envConcurrency : hard?.concurrency;

  if (minIntervalMs === undefined && concurrency === undefined) return undefined;
  return { minIntervalMs: minIntervalMs ?? 0, concurrency: concurrency ?? Infinity };
}

interface LimiterState {
  config: ProviderLimiterConfig;
  inFlight: number;
  lastDispatchAt: number;
  queue: Array<() => void>;
  waking: boolean;
}

/**
 * A registry of per-provider pacers. Production code uses the module-level singleton
 * (`withProviderLimit`, real clock); tests construct their own instance with an
 * injected clock so pacing can be exercised without real wall-clock delays.
 */
export class ProviderRateLimiter {
  private readonly states = new Map<string, LimiterState>();

  constructor(private readonly clock: ProviderLimiterClock = realClock) {}

  /** Run `fn` gated by the named provider's limiter. A provider with no configured
   *  limit (see resolveProviderLimiterConfig) passes through immediately — no queueing,
   *  no bookkeeping. */
  async withLimit<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const config = resolveProviderLimiterConfig(provider);
    if (!config) return fn();

    const state = this.stateFor(provider, config);
    await this.acquire(state);
    try {
      return await fn();
    } finally {
      state.inFlight = Math.max(0, state.inFlight - 1);
      this.pump(state);
    }
  }

  /** Test-only escape hatch: drop bookkeeping for a provider (or every provider) so
   *  pacing state from one test can't bleed into the next. */
  reset(provider?: string): void {
    if (provider) this.states.delete(provider);
    else this.states.clear();
  }

  private stateFor(provider: string, config: ProviderLimiterConfig): LimiterState {
    let state = this.states.get(provider);
    if (!state) {
      state = { config, inFlight: 0, lastDispatchAt: -Infinity, queue: [], waking: false };
      this.states.set(provider, state);
    } else {
      // Env can change between calls (mainly a test concern) — always use the latest.
      state.config = config;
    }
    return state;
  }

  private acquire(state: LimiterState): Promise<void> {
    return new Promise((resolve) => {
      state.queue.push(resolve);
      this.pump(state);
    });
  }

  // Admits queued waiters as fast as concurrency + interval spacing allow, scheduling a
  // single wake-up (via the injected clock) when only the interval is blocking.
  private pump(state: LimiterState): void {
    while (state.queue.length > 0 && state.inFlight < state.config.concurrency) {
      const elapsed = this.clock.now() - state.lastDispatchAt;
      if (elapsed < state.config.minIntervalMs) {
        if (!state.waking) {
          state.waking = true;
          void this.clock.sleep(state.config.minIntervalMs - elapsed).then(() => {
            state.waking = false;
            this.pump(state);
          });
        }
        return;
      }
      const resolve = state.queue.shift();
      if (!resolve) break;
      state.inFlight += 1;
      state.lastDispatchAt = this.clock.now();
      resolve();
    }
  }
}

const defaultLimiter = new ProviderRateLimiter();

// Escape hatch for the production singleton only (mirrors API_CIRCUIT_BREAKER_DISABLED in
// api-circuit-breaker.ts) — tests exercising the full data-providers.ts call chain against
// real provider classes would otherwise inherit real-world pacing (real 400ms-1.2s waits
// per call) since they don't know about this module. A `ProviderRateLimiter` constructed
// directly (as in this module's own unit tests) is NOT affected — this only short-circuits
// the convenience wrapper below.
function providerRateLimitDisabled(): boolean {
  const v = (process.env.PROVIDER_RATE_LIMIT_DISABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Gate `fn` by the named provider's pacer (real clock, module-level singleton shared
 *  across every call site in the process). Providers with no configured limit pass
 *  through immediately, as does every call when PROVIDER_RATE_LIMIT_DISABLED is set. */
export async function withProviderLimit<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  if (providerRateLimitDisabled()) return fn();
  return defaultLimiter.withLimit(provider, fn);
}

/** Test-only: clear the default limiter's pacing state. */
export function resetProviderRateLimiterState(provider?: string): void {
  defaultLimiter.reset(provider);
}

// ── Request QUOTA (rate-limit budget) ───────────────────────────────────────────────
// A control ORTHOGONAL to the pacer above. The pacer spaces dispatch in TIME (burst/IP safety);
// this caps the NUMBER of requests admitted per rolling window, from each provider's REAL published
// rate limits. It is deliberately scan-size-agnostic: a caller says "I want to make N requests" and
// gets back how many fit RIGHT NOW under every one of the provider's windows — the caller queries
// that many symbols and defers the rest best-effort. It never blocks/queues/sleeps (no scan stall),
// and it is keyed per CREDENTIAL so a per-user key with its own upstream quota is never gated by the
// operator key. Providers with no configured limits are unlimited (admit returns everything asked),
// so paid/broker/generous providers keep working unchanged and adding a new provider never
// accidentally throttles it.

export interface RateWindow {
  /** Max requests allowed within `windowMs`. */
  maxRequests: number;
  /** Rolling window length in ms. */
  windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// The QUOTA is the right control ONLY for providers with a hard windowed cap that PACING can't solve:
//  - twelvedata sends ONE batch /quote call costing 1 credit PER SYMBOL, so you can't space it under
//    8 credits/min — you must cap the batch size (budget).
//  - tiingo's binding cap is 50 requests/HOUR; spacing 90 requests over an hour would stall every scan
//    for the whole hour, so you budget the top-N symbols instead.
// Providers whose cap is per-MINUTE and whose calls are per-symbol (finnhub 60/min, yahoo, alpha-vantage
// ~5/min + its 25/day key-pool exhaustion) are handled by the PACER above (minIntervalMs spacing) — it
// covers EVERY symbol over time and is itself scan-size-agnostic, so they are deliberately NOT quota'd
// here (a quota would needlessly drop coverage). Providers absent here are unlimited. A symbol may cost
// >1 request (tiingo up to 3) — callers pass the request count, not the symbol count.
const RATE_QUOTAS: Record<string, RateWindow[]> = {
  twelvedata: [{ maxRequests: 8, windowMs: MINUTE }, { maxRequests: 800, windowMs: DAY }], // 1 credit/symbol
  tiingo: [{ maxRequests: 50, windowMs: HOUR }, { maxRequests: 1000, windowMs: DAY }],     // up to 3 req/symbol
  // FMP Starter plan = 300 requests/min account-wide; 290 leaves headroom so the fetchWithRetry
  // 429 backoff isn't racing the reservation. Each miss symbol costs 2–5 requests (insider + senate
  // always, plus ratios-ttm/grades-consensus/price-target-consensus when not skipped) — callers pass
  // the request count via callsPerSymbol("fmp", …), not the symbol count. NO day window by default
  // (no daily cap on Starter); PROVIDER_QUOTA_FMP_PER_DAY opts one in (e.g. 240 for the free 250/day
  // tier) via the generic env path in resolveProviderQuota.
  fmp: [{ maxRequests: 290, windowMs: MINUTE }]
};

/** Env-overridable effective windows for a provider. `PROVIDER_QUOTA_<NAME>_PER_MIN|_PER_HOUR|_PER_DAY`
 *  overrides (or adds) the corresponding window; a value <= 0 removes that window. Returns the merged
 *  window list, or `undefined` for an unlimited provider. */
// Back-compat: providers whose per-minute knob had a different name before the unified quota. The
// new PROVIDER_QUOTA_<NAME>_PER_MIN wins; the legacy name is honored only when the new one is unset,
// so an operator who set the old var to match a paid/retuned plan doesn't silently fall back to the
// built-in budget. (twelvedata's old limiter read TWELVEDATA_CREDITS_PER_MIN.)
const LEGACY_PER_MIN_ENV: Record<string, string> = {
  twelvedata: "TWELVEDATA_CREDITS_PER_MIN"
};

export function resolveProviderQuota(provider: string): RateWindow[] | undefined {
  const key = envKeyFor(provider);
  const base = RATE_QUOTAS[provider] ? RATE_QUOTAS[provider].map((w) => ({ ...w })) : [];
  const legacyPerMinEnv = LEGACY_PER_MIN_ENV[provider];
  const perMin =
    finiteEnvNumber(`PROVIDER_QUOTA_${key}_PER_MIN`) ??
    (legacyPerMinEnv ? finiteEnvNumber(legacyPerMinEnv) : undefined);
  const overrides: Array<[number, number]> = [
    [perMin ?? NaN, MINUTE],
    [finiteEnvNumber(`PROVIDER_QUOTA_${key}_PER_HOUR`) ?? NaN, HOUR],
    [finiteEnvNumber(`PROVIDER_QUOTA_${key}_PER_DAY`) ?? NaN, DAY]
  ];
  for (const [max, windowMs] of overrides) {
    if (Number.isNaN(max)) continue;
    const existing = base.find((w) => w.windowMs === windowMs);
    if (max <= 0) {
      if (existing) base.splice(base.indexOf(existing), 1); // remove this window
    } else if (existing) {
      existing.maxRequests = max;
    } else {
      base.push({ maxRequests: max, windowMs });
    }
  }
  return base.length > 0 ? base : undefined;
}

/**
 * Sliding-window request quota, per (provider, credential). `admit(provider, credKey, wanted)` returns
 * how many of `wanted` intended requests are allowed right now under ALL of the provider's windows,
 * and RECORDS that many. Instantaneous (never blocks) — the caller defers whatever isn't admitted.
 * Production uses the module singleton; tests inject a clock so window math is exercised without real
 * time.
 */
export class RequestQuota {
  private readonly hits = new Map<string, number[]>(); // "provider|cred" -> ascending request timestamps

  constructor(private readonly clock: ProviderLimiterClock = realClock) {}

  admit(provider: string, credKey: string, wanted: number): number {
    if (wanted <= 0) return 0;
    const windows = resolveProviderQuota(provider);
    if (!windows || windows.length === 0) return wanted; // unlimited

    const key = `${provider}|${credKey}`;
    const now = this.clock.now();
    const maxWindow = windows.reduce((m, w) => Math.max(m, w.windowMs), 0);
    // Prune anything older than the widest window — those hits can't affect any constraint.
    const ts = (this.hits.get(key) ?? []).filter((t) => now - t < maxWindow);

    let allowed = wanted;
    for (const w of windows) {
      const inWindow = ts.reduce((n, t) => (now - t < w.windowMs ? n + 1 : n), 0);
      allowed = Math.min(allowed, Math.max(0, w.maxRequests - inWindow));
    }
    for (let i = 0; i < allowed; i++) ts.push(now);
    this.hits.set(key, ts);
    return allowed;
  }

  /** Return up to `n` of the most-recent reservations on (provider, credKey) to the budget — for
   *  requests that were admitted but never actually dispatched (partial whole-symbol remainder, a
   *  circuit-breaker skip, etc.), so the local counter doesn't suppress later coverage. Best-effort:
   *  clamps to what's recorded; a no-op for unlimited providers (nothing was recorded). */
  refund(provider: string, credKey: string, n: number): void {
    if (n <= 0) return;
    const key = `${provider}|${credKey}`;
    const ts = this.hits.get(key);
    if (!ts || ts.length === 0) return;
    ts.splice(Math.max(0, ts.length - n)); // drop the n newest (highest timestamps sit at the end)
  }

  reset(provider?: string): void {
    if (!provider) { this.hits.clear(); return; }
    for (const k of [...this.hits.keys()]) if (k.startsWith(`${provider}|`)) this.hits.delete(k);
  }

  /** Read-only snapshot of one lane's raw timestamp array, for persistence — treat as opaque, do
   *  not mutate the returned array in place. undefined when the lane has no recorded hits. */
  getLane(provider: string, credKey: string): number[] | undefined {
    return this.hits.get(`${provider}|${credKey}`);
  }

  /** Seed a lane's raw timestamp array from persisted state (process-boot hydration). Bypasses
   *  window pruning — the next admit()/refund() call prunes as usual. Ignores a malformed value
   *  rather than throwing (a durable-state row surviving a schema change, corruption, etc.). */
  restoreLane(combinedKey: string, timestamps: unknown): void {
    if (Array.isArray(timestamps) && timestamps.every((t) => typeof t === "number")) {
      this.hits.set(combinedKey, [...(timestamps as number[])].sort((a, b) => a - b));
    }
  }
}

const defaultQuota = new RequestQuota();

// Durable backing for defaultQuota's hits (provider-rate-limit.ts's `hits` Map is otherwise pure
// in-memory and forgets every past request the instant a process restarts). This matters because
// the app now auto-deploys on every merge to main, replacing the running container mid-cycle — an
// in-memory-only quota would let the app believe it has a full fresh twelvedata/tiingo budget again
// after a redeploy even though the real account already burned most of an hour's/day's cap moments
// before, risking real HTTP 429s or provider-side throttling. See durable-state.ts's file header
// for the pacer-vs-quota-vs-ephemeral-cache reasoning this module's sibling primitives follow.
const QUOTA_NAMESPACE = "provider-request-quota";
// Lazily created on first actual use (NOT at module top level): createDurableMap() eagerly reaches
// into durable-state.ts -> db-durable-state.ts -> db.ts's barrel, and this module is itself imported
// from deep in that same barrel's dependency graph (data-providers.ts, etc.) — constructing it at
// import time risked a circular-import TDZ crash ("Cannot access 'host' before initialization") if
// this module's evaluation happened to be nested inside durable-state.ts's own still-in-progress
// top-level evaluation. Deferring construction to the first real call sidesteps the whole class of
// import-order hazards, since by then every module has finished loading.
let quotaStoreInstance: ReturnType<typeof createDurableMap<number[]>> | undefined;
function quotaStore(): ReturnType<typeof createDurableMap<number[]>> {
  return quotaStoreInstance ?? (quotaStoreInstance = createDurableMap<number[]>(QUOTA_NAMESPACE));
  // debounced: admit() is called at most once per enrich() batch per provider (not once per HTTP
  // request), so this is not a hot path.
}

function ensureQuotaHydrated(): void {
  // Gate on durable-state's OWN hydration tracking (not a second, parallel flag here) so a test's
  // resetDurableStateCacheForTests(QUOTA_NAMESPACE) — or a real process forgetting everything on
  // restart — is the single source of truth for "has this been loaded from SQLite yet".
  if (hasHydratedNamespace(QUOTA_NAMESPACE)) return;
  for (const [combinedKey, timestamps] of quotaStore().entries()) {
    defaultQuota.restoreLane(combinedKey, timestamps);
  }
}

function persistLane(provider: string, credKey: string): void {
  const lane = defaultQuota.getLane(provider, credKey);
  if (lane) quotaStore().set(`${provider}|${credKey}`, lane);
}

/** How many of `wanted` requests to `provider` on credential `credKey` fit the provider's rate
 *  budget right now (recording them). Unlimited providers return `wanted`. NOTE: unlike the pacer,
 *  this does NOT honor PROVIDER_RATE_LIMIT_DISABLED — the quota adds no wall-clock delay (it's a pure
 *  counter), so the speed escape hatch that switch exists for doesn't apply; disabling it would let a
 *  test/scan blow real free-tier caps. Full-chain tests use fresh per-test keys → isolated lanes. */
export function admitProviderRequests(provider: string, credKey: string, wanted: number): number {
  ensureQuotaHydrated();
  const allowed = defaultQuota.admit(provider, credKey, wanted);
  if (allowed > 0) persistLane(provider, credKey);
  return allowed;
}

/** Return up to `n` admitted-but-undispatched requests on (provider, credKey) to the budget —
 *  e.g. the partial remainder below one whole symbol, or calls a tripped circuit breaker skipped. */
export function refundProviderRequests(provider: string, credKey: string, n: number): void {
  ensureQuotaHydrated();
  defaultQuota.refund(provider, credKey, n);
  persistLane(provider, credKey);
}

/** Test-only: clear the default quota's window state, in-memory AND persisted. */
export function resetProviderQuotaState(provider?: string): void {
  defaultQuota.reset(provider);
  if (!provider) {
    quotaStore().clear();
  } else {
    for (const [combinedKey] of quotaStore().entries()) {
      if (combinedKey.startsWith(`${provider}|`)) quotaStore().delete(combinedKey);
    }
  }
}

/** Test-only: simulate a process restart for the quota — forgets defaultQuota's in-memory hits AND
 *  durable-state's hydration flag for this namespace, WITHOUT touching the persisted SQLite rows (a
 *  real restart doesn't touch disk). Unlike resetProviderQuotaState (which deletes the persisted
 *  rows too, for test isolation between scenarios), this proves the NEXT admitProviderRequests call
 *  re-hydrates from whatever a "prior process" already wrote. */
export function simulateProviderQuotaRestartForTests(): void {
  defaultQuota.reset();
  resetDurableStateCacheForTests(QUOTA_NAMESPACE);
}

// ── Secret scrubbing ──────────────────────────────────────────────────────────────
// Provider error/warning text ends up stored verbatim in api_health_log and surfaced
// through connections-health / the ops snapshot. Some providers (Alpha Vantage in
// particular) embed the caller's own API key in that text — scrub it before it ever
// reaches logApiHealth.

const KEY_QUERY_PARAM_RE = /([?&](?:apikey|api_key|access_key|token)=)([^&\s"'<>]+)/gi;

/** Redact `apikey=<value>`-shaped query params (any casing of the common key names)
 *  embedded in arbitrary text — e.g. a URL that leaked into an error message. */
export function redactApiKeyParams(text: string): string {
  return text.replace(KEY_QUERY_PARAM_RE, "$1***");
}

/** Redact every literal occurrence of `secret` in `text`. No-op when secret is falsy. */
export function redactSecretValue(text: string, secret: string | undefined | null): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

/** Combined scrub: a known secret value (e.g. this provider's own API key) AND any
 *  `apikey=...`-shaped query param, so both "the key appeared verbatim" and "a URL
 *  containing the key leaked into the message" are covered. */
export function scrubProviderErrorText(text: string, secret?: string | null): string {
  return redactApiKeyParams(redactSecretValue(text, secret));
}

/** Pool-aware variant of scrubProviderErrorText: redacts EVERY key in a multi-key pool (not
 *  just the currently-dispatching one), then a final `apikey=...`-shaped query-param pass.
 *  Alpha Vantage's quota/error text has only ever been observed echoing the CALLING key, but
 *  folding every pool member in here means a future echo of a DIFFERENT pool member's key
 *  (e.g. if AV's message format ever changes) can't leak unredacted either. */
export function scrubProviderErrorTextForPool(text: string, keys: readonly string[]): string {
  let scrubbed = text;
  for (const key of keys) {
    scrubbed = redactSecretValue(scrubbed, key);
  }
  return redactApiKeyParams(scrubbed);
}

/** Append `err.cause` (when present) to an error message, truncated so one verbose
 *  network-layer cause can't blow out a health-log row. Otherwise "fetch failed"-class
 *  errors carry zero information about WHY. */
export function appendErrorCause(message: string, err: unknown, maxLen = 160): string {
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  if (cause === undefined || cause === null) return message;
  const causeText = String(cause).slice(0, maxLen);
  return `${message} (cause: ${causeText})`;
}
