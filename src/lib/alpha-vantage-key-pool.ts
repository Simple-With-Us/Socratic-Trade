// alpha-vantage-key-pool.ts — Alpha Vantage multi-key pooling: sticky-until-cap key
// rotation, per-key daily-cap exhaustion memory (persisted across restarts via an internal
// setting), and the message discriminator that tells a genuine daily-cap hit apart from AV's
// transient per-second burst warning.
//
// Kept as its OWN module rather than folded into provider-rate-limit.ts, so the generic
// per-provider pacer there stays provider-agnostic — this file is Alpha-Vantage-specific
// plumbing, consumed only by AlphaVantageEnrichmentProvider in data-providers.ts.
//
// PACING IS UNCHANGED AND STAYS GLOBAL: withProviderLimit("alpha-vantage") still gates every
// dispatch through one strictly-serial >=1.1s lane, regardless of which pool key is in use.
// Adding keys multiplies the DAILY quota (25/day per key), NOT the per-second rate — Alpha
// Vantage's burst-limit warning reads like it may key off the source IP/connection rather than
// the presented `apikey=` value (unverified either way; this app has only ever run one key
// against AV). Per-key parallel dispatch lanes could therefore trip the same burst gate across
// every key at once if that guess is wrong, so pacing deliberately stays keyed by provider name
// only — see provider-rate-limit.ts's HARD_DEFAULTS["alpha-vantage"].
import { getInternalSetting, setInternalSetting } from "./db";
import crypto from "crypto";

/**
 * Alpha Vantage's genuine daily-cap message ("We have detected your API key as `<KEY>` and our
 * standard API rate limit is 25 requests per day...") is the ONLY message shape observed to mean
 * "this key is dead until the next reset." Its transient burst-warning message ("Thank you for
 * using Alpha Vantage! Please consider spreading out your free API requests more sparingly...")
 * mentions the same "25 requests per day" figure as part of an upsell pitch but NEVER contains
 * this phrase — confirmed against real prod message samples (2026-07-09 grounding: 500
 * `api_health_log` rows, 2026-07-02..08). Do not broaden this match: a false positive here would
 * rotate away from a perfectly healthy key on a transient warning that the existing 1.1s pacer
 * already handles.
 */
export function isAlphaVantageDailyCapMessage(text: string): boolean {
  return /detected your api key/i.test(text);
}

// Alpha Vantage's daily quota reset instant is NOT documented anywhere (checked AV's own docs,
// support pages, and third-party writeups) — "midnight America/New_York" is the commonly-repeated
// community assumption, not a confirmed fact. Both pieces are env-tunable so a wrong assumption is
// a one-line config fix, not a code change, and empirical observation (watch when a real exhausted
// key starts succeeding again) should win over this default if they ever disagree.
const DEFAULT_RESET_TZ = "America/New_York";
const DEFAULT_RESET_HOUR = 0; // midnight in DEFAULT_RESET_TZ

function resetTz(): string {
  return process.env.ALPHAVANTAGE_RESET_TZ?.trim() || DEFAULT_RESET_TZ;
}

/** 0-23. Falls back to DEFAULT_RESET_HOUR on anything unset/unparsable/out of range. */
function resetHour(): number {
  const raw = process.env.ALPHAVANTAGE_RESET_HOUR;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RESET_HOUR;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 24 ? Math.floor(parsed) : DEFAULT_RESET_HOUR;
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

function zonedParts(ms: number, tz: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = formatter.formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // some locales/engines format midnight as "24"
    minute: get("minute"),
    second: get("second")
  };
}

/**
 * Milliseconds from `fromMs` until the next instant the wall clock in `tz` reads
 * `targetHour:00:00`. DST-safe: reads the actual wall-clock offset via Intl.DateTimeFormat
 * (rather than assuming a fixed UTC offset), so a key isn't marked exhausted an hour early or
 * late across the US March/November DST transitions. Uses a single offset-correction pass — the
 * standard trick for converting a target wall-clock date+time in a zone into a UTC instant
 * without a full tz database — which is exact except in the vanishingly rare case where the
 * target hour itself falls inside a spring-forward "skipped hour" gap; that only risks affecting
 * a non-default `ALPHAVANTAGE_RESET_HOUR` set to the local 2am transition hour, not the default
 * midnight target.
 */
export function millisUntilNextAlphaVantageDailyReset(fromMs: number): number {
  const tz = resetTz();
  const targetHour = resetHour();
  const now = zonedParts(fromMs, tz);
  const nowSecondsOfDay = now.hour * 3600 + now.minute * 60 + now.second;
  const targetSecondsOfDay = targetHour * 3600;
  const daysAhead = nowSecondsOfDay < targetSecondsOfDay ? 0 : 1;

  // Treat the target wall-clock date+time as if it were UTC, then correct by the zone's actual
  // offset at that approximate instant (reads back the offset via a second zonedParts call).
  const approxUtcMs = Date.UTC(now.year, now.month - 1, now.day + daysAhead, targetHour, 0, 0);
  const approxInTz = zonedParts(approxUtcMs, tz);
  const approxAsUtcMs = Date.UTC(approxInTz.year, approxInTz.month - 1, approxInTz.day, approxInTz.hour, approxInTz.minute, approxInTz.second);
  const offsetMs = approxAsUtcMs - approxUtcMs;
  const correctedMs = approxUtcMs - offsetMs;
  return Math.max(0, correctedMs - fromMs);
}

interface AlphaVantagePoolEntry {
  key: string;
  exhaustedUntil: number; // epoch ms; 0 = not exhausted
}

const EXHAUSTION_SETTING_KEY = "alpha_vantage_key_pool_exhaustion";

/** key fingerprint (sha256, truncated) -> exhaustedUntil epoch ms. Fingerprinted so the
 *  persisted setting never stores a raw key value at rest. */
type PersistedExhaustionMap = Record<string, number>;

function fingerprintKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function loadPersistedExhaustion(): PersistedExhaustionMap {
  try {
    return getInternalSetting<PersistedExhaustionMap>(EXHAUSTION_SETTING_KEY) ?? {};
  } catch {
    // A settings read must never break the pool — worst case, a restart re-probes a key once
    // before re-learning it's still capped.
    return {};
  }
}

function savePersistedExhaustion(map: PersistedExhaustionMap): void {
  try {
    setInternalSetting(EXHAUSTION_SETTING_KEY, map);
  } catch {
    // Best-effort — the pool still works in-memory for the rest of this process's lifetime.
  }
}

/**
 * Sticky-until-cap key pool for Alpha Vantage. Holds each key's `exhaustedUntil` (epoch ms, 0 =
 * usable) plus a sticky current-key pointer. Rotation happens ONLY on a genuine daily-cap message
 * (see isAlphaVantageDailyCapMessage) — the transient burst warning leaves the sticky key in
 * place, since the existing withProviderLimit("alpha-vantage") 1.1s pacer is what actually
 * addresses that case.
 */
export class AlphaVantageKeyPool {
  private entries: AlphaVantagePoolEntry[] = [];
  private currentIndex = 0;

  /**
   * Idempotent value-diff configure — NOT a blind replace. `getEnrichmentProvider()` re-resolves
   * the key list and reconstructs a new `AlphaVantageEnrichmentProvider` on EVERY call (i.e.
   * every scan), so `configure()` must preserve `exhaustedUntil` for keys that are still present
   * and only add/drop entries that actually changed. A blind replace would wipe exhaustion memory
   * every scan and the pool would re-hammer a known-dead key every single call — this
   * preservation is the single most important correctness property of this class.
   */
  configure(keys: readonly string[]): void {
    const persisted = loadPersistedExhaustion();
    const now = Date.now();
    const seen = new Set<string>();
    const next: AlphaVantagePoolEntry[] = [];
    for (const key of keys) {
      if (!key || seen.has(key)) continue; // defensive de-dupe; callers already dedupe too
      seen.add(key);
      const existing = this.entries.find((e) => e.key === key);
      if (existing) {
        next.push(existing);
        continue;
      }
      // A key new to THIS process instance — consult persisted exhaustion so a restart doesn't
      // forget a key was capped and re-burn a request on it before the real reset.
      const persistedUntil = persisted[fingerprintKey(key)];
      next.push({ key, exhaustedUntil: persistedUntil && persistedUntil > now ? persistedUntil : 0 });
    }
    this.entries = next;
    if (this.currentIndex >= this.entries.length) this.currentIndex = 0;
  }

  size(): number {
    return this.entries.length;
  }

  allKeys(): string[] {
    return this.entries.map((e) => e.key);
  }

  allExhausted(now: number = Date.now()): boolean {
    return this.entries.length > 0 && this.entries.every((e) => e.exhaustedUntil > now);
  }

  /**
   * The sticky current key if usable; otherwise the first non-exhausted key found scanning
   * forward (wrapping), which becomes the new sticky pointer. If every key is exhausted, returns
   * the one with the EARLIEST `exhaustedUntil` (so the first key to come back alive is picked
   * next) WITHOUT moving the sticky pointer — callers MUST check `allExhausted()` first to avoid
   * dispatching a guaranteed-fail call in that case.
   */
  currentKey(now: number = Date.now()): { key: string; index: number } | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.entries[this.currentIndex].exhaustedUntil <= now) {
      return { key: this.entries[this.currentIndex].key, index: this.currentIndex };
    }
    for (let step = 1; step <= this.entries.length; step++) {
      const idx = (this.currentIndex + step) % this.entries.length;
      if (this.entries[idx].exhaustedUntil <= now) {
        this.currentIndex = idx;
        return { key: this.entries[idx].key, index: idx };
      }
    }
    let earliestIdx = 0;
    for (let i = 1; i < this.entries.length; i++) {
      if (this.entries[i].exhaustedUntil < this.entries[earliestIdx].exhaustedUntil) earliestIdx = i;
    }
    return { key: this.entries[earliestIdx].key, index: earliestIdx };
  }

  /**
   * Marks `key` exhausted until the next Alpha Vantage daily reset and advances the sticky
   * pointer to the next non-exhausted key (wrapping) — "sticky-until-cap, rotate on cap."
   * Persists the exhaustion (keyed by a non-reversible fingerprint, never the raw key) so a
   * container restart doesn't forget a key is dead and re-burn a request on it.
   */
  markExhausted(key: string, now: number = Date.now()): void {
    const idx = this.entries.findIndex((e) => e.key === key);
    if (idx === -1) return;
    const exhaustedUntil = now + millisUntilNextAlphaVantageDailyReset(now);
    this.entries[idx] = { key, exhaustedUntil };

    const persisted = loadPersistedExhaustion();
    persisted[fingerprintKey(key)] = exhaustedUntil;
    savePersistedExhaustion(persisted);

    for (let step = 1; step <= this.entries.length; step++) {
      const nextIdx = (idx + step) % this.entries.length;
      if (this.entries[nextIdx].exhaustedUntil <= now) {
        this.currentIndex = nextIdx;
        return;
      }
    }
    // Every key is now exhausted — leave the pointer where it is (arbitrary; all dead anyway).
    this.currentIndex = idx;
  }
}

// ── Per-key-set pool registry ─────────────────────────────────────────────────
//
// Root cause this replaces (2026-07-09): a single mutable `defaultAlphaVantageKeyPool` singleton
// used to be reconfigured wholesale by EVERY `AlphaVantageEnrichmentProvider` construction.
// `getEnrichmentProvider()` reconstructs a provider per scan/request, and a per-user stored AV key
// (a one-key pool, e.g. [U]) constructed mid-scan would call `.configure([U])` on that SAME shared
// instance the scheduler's env-key pool (e.g. [E1, E2]) was just using — wiping the scheduler's
// rotation/exhaustion state (and vice versa) across concurrent contexts. `configure()`'s own
// idempotent value-diff only protects repeated calls with the SAME key set; it does nothing when
// two call sites hold genuinely different key sets and share one mutable object.
//
// Fix: key a registry by a fingerprint of the exact SET of keys (order-independent, de-duped) —
// distinct key sets get distinct, persistent `AlphaVantageKeyPool` instances that coexist, while
// repeated calls with the SAME key set keep sharing one instance (so exhaustion memory still
// survives the per-scan provider reconstruction, same as before). The persisted exhausted-until
// internal setting is unaffected — it already fingerprints per INDIVIDUAL key (see
// EXHAUSTION_SETTING_KEY/fingerprintKey above), not per pool, so it survives this change unchanged.
const poolsByKeySetFingerprint = new Map<string, AlphaVantageKeyPool>();

/** Order-independent, de-duped fingerprint of a key SET (distinct from `fingerprintKey`, which
 *  fingerprints a single key for the persisted-exhaustion setting). Two calls with the same keys
 *  in a different order, or with defensive duplicates, must resolve to the same registry entry. */
function fingerprintKeySet(keys: readonly string[]): string {
  const normalized = Array.from(new Set(keys.filter((key): key is string => Boolean(key)))).sort();
  return crypto.createHash("sha256").update(normalized.join("\x00")).digest("hex").slice(0, 16);
}

/**
 * Returns the persistent `AlphaVantageKeyPool` for this exact SET of keys — creating one on first
 * use and reusing it on every later call with the same key set (regardless of argument order).
 * Distinct key sets get DISTINCT instances that coexist without one clobbering the other's
 * rotation/exhaustion state (see the module doc comment above for the incident this fixes).
 * `configure(keys)` is still called on every retrieval — an idempotent value-diff (see
 * `AlphaVantageKeyPool.configure`'s own doc comment), so re-resolving the pool for the same key set
 * every scan is a correctness no-op, not a wipe.
 */
export function getPoolForKeys(keys: readonly string[]): AlphaVantageKeyPool {
  const fingerprint = fingerprintKeySet(keys);
  let pool = poolsByKeySetFingerprint.get(fingerprint);
  if (!pool) {
    pool = new AlphaVantageKeyPool();
    poolsByKeySetFingerprint.set(fingerprint, pool);
  }
  pool.configure(keys);
  return pool;
}

/** Test-only: clears the per-key-set pool registry so pool instances (and their in-memory
 *  rotation/exhaustion state) never leak across unrelated tests/files that happen to reuse the
 *  same key literal set. Mirrors `resetProviderRateLimiterState`'s test-only reset pattern. */
export function __resetKeyPoolRegistryForTests(): void {
  poolsByKeySetFingerprint.clear();
}

// ── Proactive daily call budget (persisted, GLOBAL, survives restarts) ────────────────────
//
// Alpha Vantage's real free-tier cap (25/day) is enforced PER SOURCE IP, not per key — pooling
// multiple keys was retired for exactly this reason (see resolveAlphaVantageKeyPool in
// db-api-keys.ts): extra keys never multiplied real throughput, they only shared the same IP's
// one true budget. The reactive machinery above (markExhausted/allExhausted) only reacts AFTER
// AV itself has already rejected a call with the daily-cap message — it does nothing to stop
// this app from being the process that pushes the shared IP over 25 in the first place (other
// processes on the same IP, past scans this same day, etc.). This section adds a PROACTIVE,
// self-imposed ceiling — default 23/day, 2-call headroom below AV's real 25 — checked BEFORE a
// call is dispatched.
//
// Must be PERSISTED, not an in-memory sliding window (contrast provider-rate-limit.ts's
// RequestQuota, which every other provider here uses): this app deploys and restarts several
// times a day, and an in-memory counter forgets every restart — it would let the day's real
// total quietly creep past budget across deploys. The persisted setting below survives process
// restarts exactly like the exhaustion map above (same getInternalSetting/setInternalSetting
// pattern), and is scoped GLOBALLY (one counter, not one per key/pool/user) because the thing
// being budgeted — the shared source IP's real daily cap — is itself global.

const BUDGET_SETTING_KEY = "alpha_vantage_daily_call_budget";
const DEFAULT_DAILY_CALL_BUDGET = 23;

interface PersistedCallBudget {
  dayKey: string; // see currentAlphaVantageQuotaDayKey — identifies the active AV quota "day"
  used: number;
}

/** Env-overridable daily call budget. Falls back to DEFAULT_DAILY_CALL_BUDGET on anything
 *  unset/unparsable/non-integer/negative. 0 is a valid override (proactively block all AV
 *  calls for the rest of today without touching ALPHAVANTAGE_API_KEY itself).
 *
 *  Name trap: PROVIDER_QUOTA_ALPHA_VANTAGE_PER_DAY also matches provider-rate-limit.ts's
 *  generic resolveProviderQuota env pattern. Nothing calls
 *  admitProviderRequests("alpha-vantage", ...) today; if that is ever wired, TWO counters with
 *  DIFFERENT day semantics (its rolling 24h window vs this ET-midnight quota day) would engage
 *  silently under one env var — pick one owner before wiring it there. */
export function alphaVantageDailyCallBudget(): number {
  const raw = process.env.PROVIDER_QUOTA_ALPHA_VANTAGE_PER_DAY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_CALL_BUDGET;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_CALL_BUDGET;
}

/**
 * Identifies the currently active Alpha Vantage quota "day" — the period between one daily
 * reset instant and the next. Deliberately reuses `millisUntilNextAlphaVantageDailyReset`'s own
 * DST-safe date math instead of re-deriving a calendar day independently: for any `nowMs` within
 * the same quota period, `nowMs + millisUntilNextAlphaVantageDailyReset(nowMs)` resolves to the
 * SAME absolute next-reset instant (only the distance to it shrinks as `nowMs` advances), so that
 * absolute instant makes a stable, collision-free key for "which quota day is this" without
 * duplicating any tz/DST logic.
 */
function currentAlphaVantageQuotaDayKey(nowMs: number): string {
  return String(nowMs + millisUntilNextAlphaVantageDailyReset(nowMs));
}

function loadPersistedBudget(): PersistedCallBudget {
  try {
    return getInternalSetting<PersistedCallBudget>(BUDGET_SETTING_KEY) ?? { dayKey: "", used: 0 };
  } catch {
    // A settings read must never break enrichment — worst case, this process under-counts
    // today's usage for one call and re-derives from the real persisted row on the next.
    return { dayKey: "", used: 0 };
  }
}

function savePersistedBudget(usage: PersistedCallBudget): void {
  try {
    setInternalSetting(BUDGET_SETTING_KEY, usage);
  } catch {
    // Best-effort — the reservation this process just computed still holds for its own
    // lifetime even if the persist failed; only a later restart would under-count.
  }
}

/**
 * Reserves up to `n` calls against today's proactive Alpha Vantage budget, returning the number
 * actually admitted (0 <= admitted <= n) — the caller must treat any symbols beyond the admitted
 * count exactly like the reactive `allExhausted()` skip path (never dispatch them). Rolls the
 * counter over to 0 the moment `now` crosses into a new quota day. Persists the reservation
 * immediately (not just in-memory) so a restart mid-day can never forget calls already spent.
 */
export function tryReserveAlphaVantageCalls(n: number, now: number = Date.now()): number {
  if (n <= 0) return 0;
  const budget = alphaVantageDailyCallBudget();
  if (budget <= 0) return 0;
  const dayKey = currentAlphaVantageQuotaDayKey(now);
  const persisted = loadPersistedBudget();
  const used = persisted.dayKey === dayKey ? persisted.used : 0;
  const remaining = Math.max(0, budget - used);
  const admitted = Math.min(n, remaining);
  if (admitted <= 0) return 0;
  savePersistedBudget({ dayKey, used: used + admitted });
  return admitted;
}

/**
 * Returns `n` previously reserved-but-not-actually-dispatched calls to today's budget (e.g. a
 * chunk whose dispatch was skipped by the reactive key-pool exhaustion check, a per-credential
 * circuit-breaker skip, or a fetch that threw before reaching the network). A call that WAS
 * dispatched and merely returned an error/warning is NOT refunded — it still consumed Alpha
 * Vantage's real quota. No-ops across a day rollover (a reservation made yesterday has no
 * meaningful bucket to credit back into once a new quota day has started) rather than crediting
 * calls into a fresh day's unrelated counter.
 */
export function refundAlphaVantageCalls(n: number, now: number = Date.now()): void {
  if (n <= 0) return;
  const dayKey = currentAlphaVantageQuotaDayKey(now);
  const persisted = loadPersistedBudget();
  if (persisted.dayKey !== dayKey) return;
  savePersistedBudget({ dayKey, used: Math.max(0, persisted.used - n) });
}

/** Test-only: clears the persisted daily-budget usage so it never leaks across unrelated
 *  tests/files sharing a temp DB. Mirrors `__resetKeyPoolRegistryForTests`'s pattern. */
export function __resetAlphaVantageDailyBudgetForTests(): void {
  try {
    setInternalSetting(BUDGET_SETTING_KEY, { dayKey: "", used: 0 } satisfies PersistedCallBudget);
  } catch {
    // Best-effort, matching the rest of this module's persistence failure handling.
  }
}
