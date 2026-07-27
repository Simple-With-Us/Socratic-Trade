// rapidapi-quota.ts — persisted, GLOBAL daily call-budget tracking for the RapidAPI-hosted
// enrichment providers (Mboum Finance, YH Finance 15, and Alpha Vantage's RapidAPI transport).
// Mirrors alpha-vantage-key-pool.ts's proactive-budget pattern (tryReserve/refund, persisted via
// getInternalSetting/setInternalSetting so a Coolify restart never forgets today's usage) rather
// than an in-memory counter — see that file's module doc comment for why persistence is load-
// bearing here: this app redeploys/restarts several times a day, and an in-memory window would
// quietly let the real day's total creep past budget across deploys.
//
// Two layers of ceiling, and the BINDING one for any given reservation is whichever is LOWER
// (owner's explicit instruction):
//   1. Each provider's OWN real/assumed cap (Mboum ~500/month ÷ ~30 ≈ 16/day; YH Finance Basic
//      100/month ÷ ~30 ≈ 3/day — yes, this is small, that is correct given Basic tier; Alpha
//      Vantage via RapidAPI 500/day for real).
//   2. A COMBINED ceiling across all three RapidAPI-backed lanes (owner: "stay under the 1000
//      calls safely like 900 max just to avoid runaway overage though it is cheap") — a single
//      shared account, so a bug in any one provider must not be able to run the account's total
//      RapidAPI spend past this regardless of how each provider's own cap is configured.
//
// Kept as its OWN module (like alpha-vantage-key-pool.ts) rather than folded into
// data-providers.ts: this is credential/quota plumbing, not enrichment-parsing logic, and keeping
// it separate lets the three RapidAPI provider classes in data-providers.ts share one persisted
// combined counter without circular imports.
import { getInternalSetting, setInternalSetting } from "./db";

/** The three RapidAPI-backed provider lanes this budget covers. Using a closed union (rather than
 *  an arbitrary string) means a typo in a call site fails to compile instead of silently opening
 *  an unbudgeted new bucket. */
export type RapidApiProviderKey =
  | "mboum-finance"
  | "yahoo-finance15"
  | "alpha-vantage-rapidapi"
  | "fmp-rapidapi"
  | "insiders-rapidapi"
  | "twelvedata-rapidapi"
  | "yh-finance-apidojo"
  | "real-time-finance-data"
  | "seeking-alpha-rapidapi";

const DEFAULT_PER_PROVIDER_DAILY_CAP: Record<RapidApiProviderKey, number> = {
  "mboum-finance": 16,
  "yahoo-finance15": 3,
  "alpha-vantage-rapidapi": 500,
  "fmp-rapidapi": 50000,
  "insiders-rapidapi": 100,
  "twelvedata-rapidapi": 100,
  // Free Basic tiers — keep small until owner confirms higher plan caps.
  "yh-finance-apidojo": 16,
  "real-time-finance-data": 50,
  "seeking-alpha-rapidapi": 20,
};

const ENV_KEY_FOR_PROVIDER: Record<RapidApiProviderKey, string> = {
  "mboum-finance": "PROVIDER_QUOTA_MBOUM_PER_DAY",
  "yahoo-finance15": "PROVIDER_QUOTA_YAHOO_FINANCE15_PER_DAY",
  "alpha-vantage-rapidapi": "PROVIDER_QUOTA_ALPHA_VANTAGE_RAPIDAPI_PER_DAY",
  "fmp-rapidapi": "PROVIDER_QUOTA_FMP_RAPIDAPI_PER_DAY",
  "insiders-rapidapi": "PROVIDER_QUOTA_INSIDERS_RAPIDAPI_PER_DAY",
  "twelvedata-rapidapi": "PROVIDER_QUOTA_TWELVEDATA_RAPIDAPI_PER_DAY",
  "yh-finance-apidojo": "PROVIDER_QUOTA_YH_FINANCE_APIDOJO_PER_DAY",
  "real-time-finance-data": "PROVIDER_QUOTA_REAL_TIME_FINANCE_DATA_PER_DAY",
  "seeking-alpha-rapidapi": "PROVIDER_QUOTA_SEEKING_ALPHA_RAPIDAPI_PER_DAY",
};

const DEFAULT_COMBINED_DAILY_CAP = 900;

/** Env-overridable per-provider daily cap. Falls back to the provider's own default on anything
 *  unset/unparsable/non-integer/negative. 0 is a valid override (proactively block all calls for
 *  this provider today without touching RAPIDAPI_KEY itself). */
export function rapidApiProviderDailyCap(provider: RapidApiProviderKey): number {
  const raw = process.env[ENV_KEY_FOR_PROVIDER[provider]];
  if (raw === undefined || raw.trim() === "") return DEFAULT_PER_PROVIDER_DAILY_CAP[provider];
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_PER_PROVIDER_DAILY_CAP[provider];
}

/** Env-overridable COMBINED daily cap shared across all three RapidAPI lanes. Env
 *  `PROVIDER_QUOTA_RAPIDAPI_COMBINED_PER_DAY`, default 900 (owner's explicit safety ceiling —
 *  see module doc comment). */
export function rapidApiCombinedDailyCap(): number {
  const raw = process.env.PROVIDER_QUOTA_RAPIDAPI_COMBINED_PER_DAY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_COMBINED_DAILY_CAP;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_COMBINED_DAILY_CAP;
}

const BUDGET_SETTING_KEY = "rapidapi_combined_call_budget";

interface PersistedRapidApiBudget {
  dayKey: string;
  combinedUsed: number;
  perProvider: Partial<Record<RapidApiProviderKey, number>>;
}

/**
 * Identifies the current UTC calendar day. Deliberately simpler than Alpha Vantage's DST-aware
 * ET-midnight reset math (alpha-vantage-key-pool.ts's `currentAlphaVantageQuotaDayKey`) — these
 * are SELF-IMPOSED haircuts this app applies below RapidAPI's real per-provider caps (a monthly
 * cap divided into a daily allowance, or a real daily cap given generous headroom via the combined
 * ceiling), not an attempt to track a precisely-documented external reset instant. A day-boundary
 * off-by-a-few-hours error here only shifts when today's conservative allowance resets, never lets
 * the real upstream quota get exceeded.
 */
function currentUtcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function loadPersistedBudget(): PersistedRapidApiBudget {
  try {
    return getInternalSetting<PersistedRapidApiBudget>(BUDGET_SETTING_KEY) ?? { dayKey: "", combinedUsed: 0, perProvider: {} };
  } catch {
    // A settings read must never break enrichment — worst case, this process under-counts
    // today's usage for one call and re-derives from the real persisted row on the next.
    return { dayKey: "", combinedUsed: 0, perProvider: {} };
  }
}

function savePersistedBudget(budget: PersistedRapidApiBudget): void {
  try {
    setInternalSetting(BUDGET_SETTING_KEY, budget);
  } catch {
    // Best-effort — the reservation this process just computed still holds for its own
    // lifetime even if the persist failed; only a later restart would under-count.
  }
}

/**
 * Reserves up to `n` calls for `provider` against BOTH today's per-provider cap AND the shared
 * combined cap, returning the number actually admitted (0 <= admitted <= n). The binding limit is
 * whichever ceiling is lower, exactly as the owner specified. Callers MUST treat any request count
 * beyond the admitted number exactly like Alpha Vantage's key-pool exhaustion skip path (never
 * dispatch them — leave that symbol/field unenriched by this provider this run). Rolls both
 * counters over to 0 the moment `now` crosses into a new UTC day. Persists the reservation
 * immediately (not just in-memory) so a mid-day restart can never forget calls already spent.
 */
export function tryReserveRapidApiCalls(provider: RapidApiProviderKey, n: number, now: number = Date.now()): number {
  if (n <= 0) return 0;
  const ownCap = rapidApiProviderDailyCap(provider);
  const combinedCap = rapidApiCombinedDailyCap();
  if (ownCap <= 0 || combinedCap <= 0) return 0;

  const dayKey = currentUtcDayKey(now);
  const persisted = loadPersistedBudget();
  const sameDay = persisted.dayKey === dayKey;
  const combinedUsed = sameDay ? persisted.combinedUsed : 0;
  const ownUsed = sameDay ? (persisted.perProvider[provider] ?? 0) : 0;

  const ownRemaining = Math.max(0, ownCap - ownUsed);
  const combinedRemaining = Math.max(0, combinedCap - combinedUsed);
  const admitted = Math.min(n, ownRemaining, combinedRemaining);
  if (admitted <= 0) return 0;

  const nextPerProvider = sameDay ? { ...persisted.perProvider } : {};
  nextPerProvider[provider] = ownUsed + admitted;
  savePersistedBudget({ dayKey, combinedUsed: combinedUsed + admitted, perProvider: nextPerProvider });
  return admitted;
}

/**
 * Returns `n` previously reserved-but-not-actually-dispatched calls to today's budget for
 * `provider` (both the per-provider and combined counters) — mirrors
 * `refundAlphaVantageCalls`'s contract exactly: a call that WAS dispatched and merely returned an
 * error/warning is NOT refunded (it still consumed RapidAPI's real quota); only a reservation whose
 * dispatch never reached the network should be given back. No-ops across a day rollover.
 */
export function refundRapidApiCalls(provider: RapidApiProviderKey, n: number, now: number = Date.now()): void {
  if (n <= 0) return;
  const dayKey = currentUtcDayKey(now);
  const persisted = loadPersistedBudget();
  if (persisted.dayKey !== dayKey) return;
  const ownUsed = persisted.perProvider[provider] ?? 0;
  const nextPerProvider = { ...persisted.perProvider, [provider]: Math.max(0, ownUsed - n) };
  savePersistedBudget({
    dayKey,
    combinedUsed: Math.max(0, persisted.combinedUsed - n),
    perProvider: nextPerProvider,
  });
}

/** Test-only: clears the persisted daily-budget usage so it never leaks across unrelated
 *  tests/files sharing a temp DB. Mirrors `__resetAlphaVantageDailyBudgetForTests`'s pattern. */
export function __resetRapidApiQuotaForTests(): void {
  try {
    setInternalSetting(BUDGET_SETTING_KEY, { dayKey: "", combinedUsed: 0, perProvider: {} } satisfies PersistedRapidApiBudget);
  } catch {
    // Best-effort, matching the rest of this module's persistence failure handling.
  }
}
