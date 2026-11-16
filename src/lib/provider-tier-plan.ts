// provider-tier-plan.ts — user-declared plan tiers for optional market-data keys.
//
// Connections/Settings lets the owner say "this Tiingo key is free vs Power" so the app can
// apply free-tier-safe quotas without requiring Infisical env knobs. Env
// PROVIDER_QUOTA_* / Usage Monitor knobs still win when set (see provider-rate-limit.ts).
//
// Facts live in docs/market-data-provider-pricing.md — keep labels/caps aligned when pricing
// changes. Mandatory infra (pinecone/voyage/openrouter/LLM) is intentionally out of this map.

export interface RateWindowHint {
  maxRequests: number;
  /** Rolling window length in ms. */
  windowMs: number;
}

export interface PlanTierOption {
  /** Stable id stored in user_api_keys.plan_tier */
  id: string;
  /** Dropdown label */
  label: string;
  /** Short description for title/tooltip */
  hint?: string;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Marketstack (and similar) publish monthly request caps — 30d rolling window approximates the vendor month. */
const MONTH = 30 * DAY;

/**
 * Canonical service ids match API_KEY_CATALOG / normalizeApiKeyService.
 *
 * Quota labels/windows MUST come from live vendor docs (or owner receipts), not memory.
 * Re-verify when pricing changes; cite date + URL in docs/market-data-provider-pricing.md.
 * Last research pass: 2026-08-06.
 */
const TIER_OPTIONS: Record<string, PlanTierOption[]> = {
  // https://www.tiingo.com/about/pricing — free vs Power; commercial is contact-sales / separate license.
  tiingo: [
    { id: "free", label: "Free / Starter", hint: "50/hr · 1,000/day · news not included" },
    { id: "power", label: "Power (individual)", hint: "10k/hr · 100k/day · $30/mo or $300/yr" },
    { id: "commercial", label: "Commercial", hint: "Commercial license (~$50/mo or $499/yr) — confirm RPM with Tiingo; free-safe uses Power windows" },
    { id: "unknown", label: "Unknown", hint: "Use free-safe caps until you confirm" }
  ],
  // https://massive.com/pricing — Stocks Basic/Starter/Developer/Advanced (2026-08-06).
  massive: [
    { id: "free", label: "Stocks Basic (free)", hint: "5 calls/min · EOD · 2 yr history" },
    { id: "starter", label: "Stocks Starter", hint: "Unlimited REST · 15m delayed · 5 yr · $29/mo" },
    { id: "developer", label: "Stocks Developer", hint: "Unlimited REST · trades · 10 yr · $79/mo" },
    { id: "advanced", label: "Stocks Advanced", hint: "Unlimited · real-time + ratios · $199/mo" },
    { id: "unknown", label: "Unknown", hint: "Use free-safe 5/min until you confirm" }
  ],
  // FMP is retired for ST product use — options remain for CT/admin archaeology only.
  fmp: [
    { id: "free", label: "Free", hint: "250/day" },
    { id: "starter", label: "Starter", hint: "~300/min · annual statements" },
    { id: "premium", label: "Premium", hint: "Quarterly fundamentals" },
    { id: "ultimate", label: "Ultimate", hint: "Transcripts (CT only)" },
    { id: "unknown", label: "Unknown" }
  ],
  // https://twelvedata.com/pricing.md — each named tier has multiple credit SKUs; pick the SKU you pay for.
  // "grow" / "pro" / "ultra" alone map to the FLOOR of that family (free-safe if you only know the family).
  twelvedata: [
    { id: "free", label: "Basic (free)", hint: "8 credits/min · 800/day" },
    { id: "grow", label: "Grow (floor 55)", hint: "55 credits/min · no daily · from $29 — pick exact SKU if higher" },
    { id: "grow_55", label: "Grow 55", hint: "$29/mo · 55 API credits/min" },
    { id: "grow_144", label: "Grow 144", hint: "$49/mo · 144 credits/min" },
    { id: "grow_377", label: "Grow 377", hint: "$79/mo · 377 credits/min" },
    { id: "pro", label: "Pro (floor 610)", hint: "610 credits/min · from $99" },
    { id: "pro_610", label: "Pro 610", hint: "$99/mo · 610 credits/min" },
    { id: "pro_987", label: "Pro 987", hint: "$149/mo · 987 credits/min" },
    { id: "pro_1597", label: "Pro 1597", hint: "$229/mo · 1,597 credits/min" },
    { id: "ultra", label: "Ultra (floor 2584)", hint: "2,584 credits/min · from $329" },
    { id: "ultra_2584", label: "Ultra 2584", hint: "$329/mo · 2,584 credits/min" },
    { id: "ultra_4181", label: "Ultra 4181", hint: "$499/mo · 4,181 credits/min" },
    { id: "ultra_10946", label: "Ultra 10946", hint: "$999/mo · 10,946 credits/min" },
    { id: "unknown", label: "Unknown", hint: "Use Basic free-safe caps until you confirm" }
  ],
  // Free 60/min documented widely; All-In-One is the only self-serve jump (~$3.5k) — exact paid RPM not trusted here.
  finnhub: [
    { id: "free", label: "Free", hint: "60 calls/min (app paces at 50 free-safe)" },
    {
      id: "all_in_one",
      label: "All-In-One",
      hint: "~$3,500/mo — set PROVIDER_QUOTA_* / dashboard limits; do not assume RPM"
    },
    { id: "unknown", label: "Unknown", hint: "Use free-safe 50/min" }
  ],
  // https://www.alphavantage.co/premium/ — free 25/day (per IP observed); premium ladder, no daily cap.
  alphavantage: [
    { id: "free", label: "Free", hint: "25/day per IP (not per key) · no premium endpoints" },
    { id: "premium", label: "Premium 75 (entry)", hint: "75/min · $49.99/mo · no daily cap" },
    { id: "premium_75", label: "Premium 75", hint: "75/min · $49.99/mo" },
    { id: "premium_150", label: "Premium 150", hint: "150/min · $99.99/mo" },
    { id: "premium_300", label: "Premium 300", hint: "300/min · $149.99/mo" },
    { id: "premium_600", label: "Premium 600", hint: "600/min · $199.99/mo" },
    { id: "premium_1200", label: "Premium 1200", hint: "1,200/min · $249.99/mo" },
    { id: "unknown", label: "Unknown", hint: "Use free 25/day until you confirm" }
  ],
  // https://marketstack.com/pricing — monthly request caps (2026-08-06).
  marketstack: [
    { id: "free", label: "Free", hint: "100 req/month · EOD · 1 yr history" },
    { id: "basic", label: "Basic", hint: "10,000 req/mo · $9.99 · IEX intraday" },
    { id: "professional", label: "Professional", hint: "100,000 req/mo · $49.99 · real-time" },
    { id: "business", label: "Business", hint: "500,000 req/mo · $149.99 · statements" },
    { id: "unknown", label: "Unknown", hint: "Use free 100/mo until you confirm" }
  ],
  // https://www.roic.ai/pricing — Free 5/min · Individual $29 300/min · Professional $89 unlimited (2026-08-06).
  // No "Starter" SKU on the public matrix — that was an invented tier; use individual.
  roic: [
    { id: "free", label: "Free", hint: "5 req/min · 2 quarters transcripts · 2 yr history" },
    { id: "individual", label: "Individual", hint: "$29/mo · 300 req/min · 20 quarters transcripts" },
    { id: "professional", label: "Professional", hint: "$89/mo · unlimited RPM · all transcript quarters" },
    { id: "enterprise", label: "Enterprise", hint: "Custom · unlimited · commercial terms" },
    { id: "unknown", label: "Unknown", hint: "Use free-safe 5/min until you confirm" }
  ],
  // Caps not re-fetched this pass — keep free-safe placeholders; mark unknown.
  filingapi: [
    { id: "free", label: "Free", hint: "~50 req/day (app free-safe 45) — re-verify on vendor site" },
    { id: "paid", label: "Paid", hint: "Set PROVIDER_QUOTA_FILINGAPI_* when confirmed" },
    { id: "unknown", label: "Unknown" }
  ],
  fintechstudios: [
    { id: "free", label: "Free", hint: "$0 marketing free plan — re-verify credits" },
    { id: "pro", label: "Pro", hint: "Self-serve Pro — set env quota when confirmed" },
    { id: "unknown", label: "Unknown" }
  ],
  marketaux: [
    { id: "free", label: "Free", hint: "~100 req/day placeholder — re-verify on marketaux.com" },
    { id: "paid", label: "Paid", hint: "Higher daily budget — set env when confirmed" },
    { id: "unknown", label: "Unknown" }
  ],
  earningscalls: [
    { id: "preview", label: "Preview / trial", hint: "Limited / 250-char style preview — not full text" },
    { id: "paid", label: "Paid full-text", hint: "Confirm plan + clear preview_blocked after upgrade" },
    { id: "unknown", label: "Unknown" }
  ],
  rapidapi: [
    { id: "basic", label: "Basic", hint: "Per-API marketplace Basic — often ~1k/hr platform, not full vendor text" },
    { id: "pro", label: "Pro", hint: "Higher RapidAPI plan for that API product" },
    { id: "unknown", label: "Unknown" }
  ],
  fred: [
    { id: "free", label: "Free", hint: "No paid tiers — FRED is always free with a key" },
    { id: "unknown", label: "Unknown" }
  ],
  apify: [
    { id: "free", label: "Free", hint: "Limited compute units / month" },
    { id: "starter", label: "Starter", hint: "Entry paid Actor compute" },
    { id: "scale", label: "Scale", hint: "Higher compute + concurrency" },
    { id: "business", label: "Business", hint: "Team / production scrapers" },
    { id: "enterprise", label: "Enterprise", hint: "Highest plan" },
    { id: "unknown", label: "Unknown" }
  ],
  logodev: [
    { id: "free", label: "Community free", hint: "500k req/mo · attribution may apply" },
    { id: "startup", label: "Startup", hint: "~1M req/mo · no attribution · annual" },
    { id: "pro", label: "Pro", hint: "Brand API + higher volume" },
    { id: "unknown", label: "Unknown" }
  ],
  tradier: [
    { id: "sandbox", label: "Sandbox", hint: "15m delayed · 60/min market-data typical" },
    { id: "live_lite", label: "Live Lite $0", hint: "Production token · real-time on funded/live account" },
    { id: "live", label: "Live (any plan)", hint: "Production market-data rates · ~120/min typical" },
    { id: "unknown", label: "Unknown" }
  ],
  pinecone: [
    { id: "free", label: "Free / Starter", hint: "Serverless free allowance · low WU" },
    { id: "standard", label: "Standard", hint: "Paid serverless" },
    { id: "enterprise", label: "Enterprise", hint: "Highest capacity" },
    { id: "unknown", label: "Unknown" }
  ],
  voyage: [
    { id: "free", label: "Free", hint: "Low free embed tokens" },
    { id: "paid", label: "Paid", hint: "Metered embeddings" },
    { id: "unknown", label: "Unknown" }
  ],
  siliconflow: [
    { id: "free", label: "Free", hint: "Low free embed/chat allowance" },
    { id: "paid", label: "Paid", hint: "Metered" },
    { id: "unknown", label: "Unknown" }
  ]
};

/**
 * Quota windows implied by a declared tier when PROVIDER_QUOTA_* env / UM knobs are unset.
 * Missing entry → fall through to provider-rate-limit RATE_QUOTAS hard defaults.
 * Align with docs/market-data-provider-pricing.md upgrade cheat-sheet.
 */
const TIER_QUOTA_WINDOWS: Record<string, Record<string, RateWindowHint[]>> = {
  tiingo: {
    free: [
      { maxRequests: 50, windowMs: HOUR },
      { maxRequests: 1000, windowMs: DAY }
    ],
    power: [
      { maxRequests: 10_000, windowMs: HOUR },
      { maxRequests: 100_000, windowMs: DAY }
    ],
    // Commercial license pricing differs; RPM not published distinctly on free matrix — Power-shaped free-safe.
    commercial: [
      { maxRequests: 10_000, windowMs: HOUR },
      { maxRequests: 100_000, windowMs: DAY }
    ],
    unknown: [
      { maxRequests: 50, windowMs: HOUR },
      { maxRequests: 1000, windowMs: DAY }
    ]
  },
  twelvedata: {
    free: [
      { maxRequests: 8, windowMs: MINUTE },
      { maxRequests: 800, windowMs: DAY }
    ],
    // Family floors (free-safe if you only know "Grow"/"Pro"/"Ultra" without the credit SKU).
    grow: [{ maxRequests: 55, windowMs: MINUTE }],
    grow_55: [{ maxRequests: 55, windowMs: MINUTE }],
    grow_144: [{ maxRequests: 144, windowMs: MINUTE }],
    grow_377: [{ maxRequests: 377, windowMs: MINUTE }],
    pro: [{ maxRequests: 610, windowMs: MINUTE }],
    pro_610: [{ maxRequests: 610, windowMs: MINUTE }],
    pro_987: [{ maxRequests: 987, windowMs: MINUTE }],
    pro_1597: [{ maxRequests: 1_597, windowMs: MINUTE }],
    ultra: [{ maxRequests: 2_584, windowMs: MINUTE }],
    ultra_2584: [{ maxRequests: 2_584, windowMs: MINUTE }],
    ultra_4181: [{ maxRequests: 4_181, windowMs: MINUTE }],
    ultra_10946: [{ maxRequests: 10_946, windowMs: MINUTE }],
    unknown: [
      { maxRequests: 8, windowMs: MINUTE },
      { maxRequests: 800, windowMs: DAY }
    ]
  },
  fmp: {
    free: [{ maxRequests: 240, windowMs: DAY }],
    starter: [{ maxRequests: 290, windowMs: MINUTE }],
    premium: [{ maxRequests: 740, windowMs: MINUTE }],
    ultimate: [{ maxRequests: 2900, windowMs: MINUTE }],
    unknown: [{ maxRequests: 240, windowMs: DAY }]
  },
  // Vendor publishes monthly caps — use 30d rolling window (not invented daily divisions).
  marketstack: {
    free: [{ maxRequests: 100, windowMs: MONTH }],
    basic: [{ maxRequests: 10_000, windowMs: MONTH }],
    professional: [{ maxRequests: 100_000, windowMs: MONTH }],
    business: [{ maxRequests: 500_000, windowMs: MONTH }],
    unknown: [{ maxRequests: 100, windowMs: MONTH }]
  },
  // ROIC: requests/minute + transcript depth (quarters) live on pricing page — not daily invents.
  roic: {
    free: [{ maxRequests: 5, windowMs: MINUTE }],
    individual: [{ maxRequests: 300, windowMs: MINUTE }],
    // empty = unlimited RPM from tier (Professional / Enterprise on pricing page).
    professional: [],
    enterprise: [],
    unknown: [{ maxRequests: 5, windowMs: MINUTE }]
  },
  filingapi: {
    free: [{ maxRequests: 45, windowMs: DAY }],
    // paid not re-verified — leave open so env/UM must set real caps rather than inventing 500/day.
    paid: [],
    unknown: [{ maxRequests: 45, windowMs: DAY }]
  },
  fintechstudios: {
    free: [{ maxRequests: 50, windowMs: DAY }],
    pro: [{ maxRequests: 500, windowMs: DAY }],
    unknown: [{ maxRequests: 50, windowMs: DAY }]
  },
  marketaux: {
    free: [{ maxRequests: 80, windowMs: DAY }],
    paid: [],
    unknown: [{ maxRequests: 80, windowMs: DAY }]
  },
  earningscalls: {
    preview: [{ maxRequests: 8, windowMs: DAY }],
    paid: [{ maxRequests: 100, windowMs: DAY }],
    unknown: [{ maxRequests: 8, windowMs: DAY }]
  },
  // Platform free ceiling ~1k/hr; per-API free quotas are usually much lower — free-safe conservative.
  rapidapi: {
    basic: [
      { maxRequests: 60, windowMs: MINUTE },
      { maxRequests: 500, windowMs: DAY }
    ],
    pro: [
      { maxRequests: 300, windowMs: MINUTE },
      { maxRequests: 5_000, windowMs: DAY }
    ],
    unknown: [
      { maxRequests: 30, windowMs: MINUTE },
      { maxRequests: 200, windowMs: DAY }
    ]
  },
  alphavantage: {
    free: [{ maxRequests: 25, windowMs: DAY }],
    premium: [{ maxRequests: 75, windowMs: MINUTE }],
    premium_75: [{ maxRequests: 75, windowMs: MINUTE }],
    premium_150: [{ maxRequests: 150, windowMs: MINUTE }],
    premium_300: [{ maxRequests: 300, windowMs: MINUTE }],
    premium_600: [{ maxRequests: 600, windowMs: MINUTE }],
    premium_1200: [{ maxRequests: 1_200, windowMs: MINUTE }],
    unknown: [{ maxRequests: 25, windowMs: DAY }]
  },
  finnhub: {
    free: [{ maxRequests: 50, windowMs: MINUTE }],
    // Do not invent All-In-One RPM — empty means no tier window; HARD_DEFAULTS/env apply.
    all_in_one: [],
    unknown: [{ maxRequests: 50, windowMs: MINUTE }]
  },
  massive: {
    free: [{ maxRequests: 5, windowMs: MINUTE }],
    // Unlimited REST on paid Stocks Starter/Developer/Advanced.
    starter: [],
    developer: [],
    advanced: [],
    unknown: [{ maxRequests: 5, windowMs: MINUTE }]
  },
  // Placeholders from main (2026-08-06 ladder expansion) — re-verify on vendor sites before raising.
  fred: {
    free: [{ maxRequests: 100, windowMs: MINUTE }],
    unknown: [{ maxRequests: 100, windowMs: MINUTE }]
  },
  apify: {
    free: [{ maxRequests: 50, windowMs: DAY }],
    starter: [{ maxRequests: 500, windowMs: DAY }],
    scale: [{ maxRequests: 2_000, windowMs: DAY }],
    business: [{ maxRequests: 10_000, windowMs: DAY }],
    enterprise: [{ maxRequests: 50_000, windowMs: DAY }],
    unknown: [{ maxRequests: 50, windowMs: DAY }]
  },
  logodev: {
    // Soft daily approximation of monthly free 500k (~16k/day).
    free: [{ maxRequests: 10_000, windowMs: DAY }],
    startup: [{ maxRequests: 30_000, windowMs: DAY }],
    pro: [{ maxRequests: 100_000, windowMs: DAY }],
    unknown: [{ maxRequests: 5_000, windowMs: DAY }]
  },
  tradier: {
    sandbox: [{ maxRequests: 50, windowMs: MINUTE }],
    live_lite: [{ maxRequests: 100, windowMs: MINUTE }],
    live: [{ maxRequests: 120, windowMs: MINUTE }],
    unknown: [{ maxRequests: 50, windowMs: MINUTE }]
  },
  pinecone: {
    free: [{ maxRequests: 100, windowMs: MINUTE }],
    standard: [{ maxRequests: 500, windowMs: MINUTE }],
    enterprise: [{ maxRequests: 2_000, windowMs: MINUTE }],
    unknown: [{ maxRequests: 100, windowMs: MINUTE }]
  },
  voyage: {
    free: [{ maxRequests: 3, windowMs: MINUTE }],
    paid: [{ maxRequests: 60, windowMs: MINUTE }],
    unknown: [{ maxRequests: 3, windowMs: MINUTE }]
  },
  siliconflow: {
    free: [{ maxRequests: 10, windowMs: MINUTE }],
    paid: [{ maxRequests: 120, windowMs: MINUTE }],
    unknown: [{ maxRequests: 10, windowMs: MINUTE }]
  }
};

/**
 * Every non-free-only market/RAG data source we use or have used must appear here and in
 * TIER_OPTIONS with free-safe defaults. LLM keys and SEC User-Agent stay out.
 */
export const PLAN_TIER_REQUIRED_SERVICES: readonly string[] = [
  "tiingo",
  "massive",
  "fmp",
  "twelvedata",
  "finnhub",
  "alphavantage",
  "marketstack",
  "roic",
  "filingapi",
  "fintechstudios",
  "marketaux",
  "earningscalls",
  "rapidapi",
  "fred",
  "apify",
  "logodev",
  "tradier",
  "pinecone",
  "voyage",
  "siliconflow"
] as const;

/** Normalize API key service / rate-limit provider names to TIER_OPTIONS keys. */
export function normalizePlanTierServiceId(service: string): string {
  const raw = service.trim().toLowerCase().replace(/[\s]+/g, "");
  if (raw === "alpha-vantage" || raw === "alpha_vantage") return "alphavantage";
  if (raw === "twelve-data" || raw === "twelve_data") return "twelvedata";
  if (raw === "fintech-studios" || raw === "fintech_studios" || raw === "powerintell") return "fintechstudios";
  if (raw === "filing-api" || raw === "filing_api") return "filingapi";
  if (raw === "earnings-calls" || raw === "earnings_calls") return "earningscalls";
  if (raw === "rapid-api" || raw === "rapid_api") return "rapidapi";
  if (raw === "logo_dev" || raw === "logo-dev") return "logodev";
  if (raw === "polygon" || raw === "polygon_io") return "massive";
  return raw;
}

/** Services that show a plan-tier dropdown next to the key field. */
export function servicesWithPlanTierUi(): ReadonlySet<string> {
  return new Set([...Object.keys(TIER_OPTIONS), ...PLAN_TIER_REQUIRED_SERVICES]);
}

export function planTierOptionsForService(service: string): PlanTierOption[] | null {
  const canonical = normalizePlanTierServiceId(service);
  const opts = TIER_OPTIONS[canonical];
  return opts ? opts.map((o) => ({ ...o })) : null;
}

export function isValidPlanTierForService(service: string, tier: string): boolean {
  const opts = planTierOptionsForService(service);
  if (!opts) return false;
  return opts.some((o) => o.id === tier);
}

/** Default when a key exists but no tier was ever chosen — free-safe. */
export function defaultPlanTierForService(service: string): string {
  const opts = planTierOptionsForService(service);
  if (!opts || opts.length === 0) return "unknown";
  if (opts.some((o) => o.id === "free")) return "free";
  if (opts.some((o) => o.id === "basic")) return "basic";
  if (opts.some((o) => o.id === "preview")) return "preview";
  if (opts.some((o) => o.id === "sandbox")) return "sandbox";
  return opts[0]!.id;
}

/**
 * Massive Stocks Starter+ include ≥5 years of aggregates, so a ~2.5-year history
 * probe must succeed.  Stocks Basic (free) and undeclared/unknown plans cap at ~2
 * years — a 403/empty on that window is expected, not an outage.
 */
export function massivePlanAllowsDeepHistory(planId: string | null | undefined): boolean {
  const id = (planId ?? "").trim().toLowerCase();
  return id === "starter" || id === "developer" || id === "advanced";
}

/**
 * Quota windows for a declared tier. Returns:
 *  - undefined when the service has no tier map or tier id is unknown to the map
 *    (caller should use RATE_QUOTAS hard defaults)
 *  - empty array when the tier is intentionally unlimited (e.g. Massive starter)
 *  - non-empty windows otherwise
 */
export function quotaWindowsForPlan(service: string, tier: string): RateWindowHint[] | undefined {
  const canonical = normalizePlanTierServiceId(service);
  const byTier = TIER_QUOTA_WINDOWS[canonical];
  if (!byTier) return undefined;
  const windows = byTier[tier];
  if (windows === undefined) return undefined;
  return windows.map((w) => ({ ...w }));
}

/** Provider names used by RATE_QUOTAS / admitProviderRequests (hyphen form for some). */
export function rateLimitProviderName(service: string): string {
  const canonical = normalizePlanTierServiceId(service);
  if (canonical === "alphavantage") return "alpha-vantage";
  return canonical;
}

/** Map rate-limit provider ids back to API key service ids. */
export function apiKeyServiceForRateLimitProvider(provider: string): string {
  if (provider === "alpha-vantage") return "alphavantage";
  return provider;
}

/**
 * How many completed fiscal quarters of earnings transcripts a declared ROIC plan should
 * attempt per symbol (scheduler + refresh).
 *
 * From https://www.roic.ai/pricing (2026-08-06): Free = 2 quarters, Individual = 20 quarters,
 * Professional/Enterprise = all available. App caps "all" at 40 per symbol per run so one
 * refresh cannot request unbounded history in a single pass.
 */
export function roicTranscriptQuartersForPlan(tier: string | null | undefined): number {
  switch ((tier ?? "unknown").toLowerCase()) {
    case "professional":
    case "enterprise":
      return 40;
    case "individual":
      return 20;
    // Legacy stored value from an invented "starter" tier — treat as free-safe depth.
    case "starter":
    case "plus":
    case "free":
    case "unknown":
    default:
      return 2;
  }
}

/** True when ST product must not use this service (key row may still be visible). */
export function isRetiredMarketDataService(service: string): boolean {
  const id = normalizePlanTierServiceId(service);
  // Keep in sync with retired-direct-vendors + Connections health intentional OFF.
  return id === "fmp" || id === "quiverquant" || id === "quiver" || id === "unusual_whales";
}

/**
 * Services that must never show a plan-tier dropdown (LLM keys, contact strings).
 * Used by tests to lock the catalog policy.
 */
export function isNonPlanTierService(service: string): boolean {
  const id = normalizePlanTierServiceId(service);
  if (id === "sec_edgar_user_agent" || id === "sec_edgar") return true;
  const llm = new Set([
    "openai",
    "anthropic",
    "xai",
    "gemini",
    "mistral",
    "deepseek",
    "moonshot",
    "kimi",
    "minimax",
    "openrouter",
    "meta"
  ]);
  return llm.has(id);
}

// ── Process-wide plan-tier lookup (operator / local key store) ───────────────
// Registered by db-api-keys after getUserApiKey is defined. provider-rate-limit
// consults this when resolveProviderQuota is called without an explicit planTier.
// Lives here (not in db-api-keys) so the rate-limit module never needs to import
// the DB layer.

type PlanTierLookup = (service: string) => string | null | undefined;

let planTierLookup: PlanTierLookup | undefined;

/** Wire the DB-backed lookup (called once from db-api-keys at module init). */
export function registerPlanTierLookup(fn: PlanTierLookup): void {
  planTierLookup = fn;
}

/** Test helper: clear or replace the lookup. */
export function registerPlanTierLookupForTests(fn: PlanTierLookup | undefined): void {
  planTierLookup = fn;
}

/**
 * Effective stored plan tier for a rate-limit provider name (e.g. "tiingo", "alpha-vantage").
 * Returns undefined when no lookup is registered; null when registered but no row/tier.
 */
export function lookupRegisteredPlanTier(provider: string): string | null | undefined {
  if (!planTierLookup) return undefined;
  const service = apiKeyServiceForRateLimitProvider(provider);
  return planTierLookup(service);
}
