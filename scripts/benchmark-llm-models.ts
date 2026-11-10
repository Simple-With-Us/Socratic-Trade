// LLM model benchmark — every curated-catalog model in BOTH strategy roles (Green/Bull proposer +
// Red/Bear reviewer), through the app's REAL request-building code paths:
//   resolveLlmEndpoint (provider/transport/key routing) -> buildLlmRequestBody (per-transport wire
//   body incl. schemas + withLlmRequestBounds token caps/reasoning) -> llmAuthHeaders ->
//   llmFetchCapturing (soft timeout = strategyLlmTimeoutMs, no severing) -> extractLlmText/-Usage.
// System prompts come from buildBullSystem (strategy-prompts) for the proposer and
// buildRedTeamReviewSystem for the single Red Team reviewer; the Bull `trade_proposals` JSON schema
// mirrors the literal in src/lib/strategy.ts (proposeTrades) and the reviewer sends the app's real
// `red_team_verdict` three-way schema (RED_TEAM_VERDICT_SCHEMA) — keep them in sync if either changes.
//
// The Green user turn is reconstructed from REAL data when available: the most recent
// `signal_snapshot` audit event (CandidateEvidence digests -> compact candidates, the same fields
// compactCandidateForPrompt sends), the cached `last_macro_sent:<user>` macro block, and the latest
// portfolio snapshot. The Red role reviews 1-2 recent trade_proposals rows (or fixtures). A bundled
// fixture pack covers DBs without history.
//
// SAFETY: LLM calls only — NO broker interaction, NO audit writes, and no MIGRATIONS/other-table
// writes to the app DB. The one exception is the llm_usage ledger row + external usage-telemetry
// push, written unconditionally for every real call via a dedicated connection (see "Writable
// ledger connection" below) — never through getDb() or the readonly realDb. The realDb handle
// itself is still opened strictly READ-ONLY (better-sqlite3 { readonly: true }). Because the app's own
// credential resolution (resolveLlmCredential inside resolveLlmEndpoint) goes through getDb() —
// which runs migrations — DATABASE_URL is repointed at a throwaway SCRATCH SQLite file before any
// app module can open a DB, and the user's LLM keys (decrypted from the read-only real DB, plus env
// fallbacks — mirroring the boot env->store migration) are seeded into that scratch DB so
// resolveLlmEndpoint resolves credentials via the SAME code path production uses.
//
// Run from a checkout that has .env.local + data/app.db (e.g. /Users/jay/apps/trading-live):
//   npx tsx scripts/benchmark-llm-models.ts
//   npx tsx scripts/benchmark-llm-models.ts --models deepseek-v4-flash,gemini-3.5-flash --rounds 1 --role green
//   npx tsx scripts/benchmark-llm-models.ts --dry-run            (build+print all requests, no network)
// Flags: --models a,b,c (default: every curated catalog model) | --rounds N (default 3)
//        --role green|red|both (default both) | --out <basePath> (default ./llm-benchmark-<ts>)
//        --timeout-ms N (soft-timeout override) | --user <id> (default local) | --dry-run
//        --record-usage (DEPRECATED no-op, kept only so existing invocations don't break: usage is
//          ALWAYS recorded now — every real call is logged into the REAL app's llm_usage table,
//          tagged under a pretend account "benchmark:<user>" / context "benchmark:<role>", AND
//          pushed to the external API Usage Monitor via recordLlmUsage (owner directive: every
//          single LLM call is hardwired into the ledger + external telemetry, unconditionally — no
//          opt-in flag gates it anymore). This remains the one exception to the "no writes to the
//          app DB" safety rule above, and only touches llm_usage via a dedicated connection — never
//          the scratch-DB-bound getDb() the rest of the script uses, and never migrations/other
//          tables.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── CLI flags ────────────────────────────────────────────────────────────────
function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  const pref = argv.find((a) => a.startsWith(`${name}=`));
  return pref ? pref.slice(name.length + 1) : undefined;
}
const hasFlag = (name: string): boolean => process.argv.slice(2).includes(name);

const CLI = {
  models: argValue("--models")?.split(",").map((m) => m.trim()).filter(Boolean),
  rounds: Math.max(1, Number(argValue("--rounds") ?? 3) || 3),
  role: (argValue("--role") ?? "both") as "green" | "red" | "both",
  out: argValue("--out"),
  timeoutMs: Number(argValue("--timeout-ms")) || undefined,
  user: argValue("--user") ?? "local",
  dryRun: hasFlag("--dry-run"),
  // DEPRECATED no-op — accepted so pre-existing invocations don't break. Usage is now ALWAYS
  // recorded (ledger + external telemetry) regardless of this flag; see the header comment above.
  recordUsage: hasFlag("--record-usage"),
  // --effort <none|minimal|low|medium|high|xhigh|max|omit>: request a specific reasoning effort
  // instead of the app's default resolution. Still normalized per model by the app's own
  // capability map (so an unsupported value can't produce a 400). "omit" is a DIAGNOSTIC mode:
  // build the body normally, then strip the reasoning fields entirely — isolates whether an
  // explicit `reasoning_effort:"none"`/thinking-off param (vs its absence) changes model behavior.
  effort: argValue("--effort") as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "omit" | undefined
};
if (!["green", "red", "both"].includes(CLI.role)) {
  console.error(`Invalid --role "${CLI.role}" (expected green|red|both)`);
  process.exit(2);
}

// ── Env + DB isolation (BEFORE any src/lib import touches a DB) ──────────────
// tsx does not auto-load .env.local; parse it into process.env (without clobbering already-set vars).
const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
// Where the REAL app DB lives (read-only source of snapshots/keys).
const realDbPath = path.resolve((process.env.DATABASE_URL ?? "file:./data/app.db").replace(/^file:/, ""));
// Repoint the app's getDb() at a throwaway scratch DB so its migrations/seeding can never write the
// real DB. Every subsequent src/lib import sees this DATABASE_URL.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-benchmark-"));
const scratchDbPath = path.join(scratchDir, "scratch.db");
process.env.DATABASE_URL = `file:${scratchDbPath}`;

// Dynamic imports AFTER the env/DB setup above (static imports would hoist past it).
const { default: Database } = await import("better-sqlite3");
const { resolveLlmEndpoint } = await import("../src/lib/llm-provider");
const { buildLlmRequestBody, llmAuthHeaders, extractLlmText, detectLlmTruncation } = await import("../src/lib/llm-call");
const { llmFetchCapturing, strategyLlmTimeoutMs, LLM_OUTPUT_TOKEN_CAPS, LLM_REQUEST_DEFAULTS, interactiveStrategyReasoningEffort } = await import(
  "../src/lib/llm-request"
);
const { extractLlmUsage, estimateLlmCostUsd, recordLlmUsage } = await import("../src/lib/llm-usage");
// PR #1086 (cache-aware usage pricing) extends extractLlmUsage with cachedPromptTokens /
// cacheCreationTokens and estimateLlmCostUsd with optional 4th/5th args (cache-reads at 0.1x input,
// Anthropic cache-writes at 1.25x). Guarded optionally so this script runs on branches with either
// version: pre-#1086 the fields read as undefined and the extra args are ignored at runtime.
type CacheAwareUsage = { cachedPromptTokens?: number; cacheCreationTokens?: number };
const estimateCost = estimateLlmCostUsd as (
  model: string | undefined,
  promptTokens?: number,
  completionTokens?: number,
  cachedPromptTokens?: number,
  cacheCreationTokens?: number
) => number | undefined;
const { upsertUserApiKey, decryptValue, apiKeyEnvVarForService, LLM_PROVIDER_SERVICES } = await import("../src/lib/db-api-keys");
const { buildBullSystem, buildRedTeamReviewSystem, THESIS_PLAYBOOK } = await import("../src/lib/strategy-prompts");
const { RED_TEAM_VERDICT_SCHEMA } = await import("../src/lib/red-team");
const { CURATED_LLM_MODEL_GROUPS } = await import("../app/ui/llm-model-catalog");
const { DEFAULT_STRATEGY_PROMPT } = await import("../src/lib/defaults");

type Role = "green" | "red";
const ROLES: Role[] = CLI.role === "both" ? ["green", "red"] : [CLI.role];
const MODELS: string[] = CLI.models ?? CURATED_LLM_MODEL_GROUPS.flatMap((g) => g.options.map((o) => o.value));

// ── Read-only real DB ────────────────────────────────────────────────────────
let realDb: InstanceType<typeof Database> | undefined;
try {
  realDb = new Database(realDbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  console.warn(`[benchmark] app DB not readable at ${realDbPath} (${err instanceof Error ? err.message : String(err)}) — using bundled fixtures + env keys only.`);
}

// ── Writable ledger connection (usage is ALWAYS recorded, unconditionally) ──
// Deliberately SEPARATE from realDb (readonly) and from getDb() (bound to the scratch DB for the
// rest of this script) — this connection ONLY ever runs the single INSERT below, never migrations
// or any other table, so it can't reproduce the corruption risk the readonly design guards against.
//
// Why a raw INSERT instead of calling recordLlmUsage's OWN insert: recordLlmUsage (src/lib/
// llm-usage.ts) writes through getDb(), and getDb() is a first-call-wins singleton that this
// script already bound to the throwaway SCRATCH db above (resolveLlmEndpoint -> resolveLlmCredential
// -> getDb(), forced during the credential-seeding step before any LLM call runs) — there is no way
// to redirect it back to the real DB mid-process. So the durable ledger row is written HERE, directly
// against the real DB, mirroring recordLlmUsage's own INSERT shape. recordLlmUsage is still called
// below for every real call anyway — its local-DB write lands harmlessly in the scratch DB (deleted
// at exit), but its OTHER effect, firing external usage telemetry (pushLlmUsage) via the exact same
// code path every other LLM call site in the app uses, is the whole point (owner directive: every
// LLM use is hardwired into telemetry, not just the ones that happen to run through a fresh getDb()).
const USAGE_PSEUDO_USER = `benchmark:${CLI.user}`;
function prepareInsertUsageStmt(db: InstanceType<typeof Database>) {
  return db.prepare<unknown[]>(
    `INSERT INTO llm_usage (id, user_id, provider, model, context, key_source, key_ref, connected_account_id, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
  );
}
let usageDb: InstanceType<typeof Database> | undefined;
let insertUsageStmt: ReturnType<typeof prepareInsertUsageStmt> | undefined;
if (CLI.recordUsage) {
  console.warn('[benchmark] --record-usage is now a no-op: usage is ALWAYS recorded (ledger + external telemetry), unconditionally.');
}
if (!CLI.dryRun) {
  try {
    usageDb = new Database(realDbPath, { fileMustExist: true });
    usageDb.pragma("journal_mode = WAL");
    usageDb.pragma("busy_timeout = 5000");
    usageDb.pragma("foreign_keys = ON");
    insertUsageStmt = prepareInsertUsageStmt(usageDb);
    console.log(`[benchmark] logging to llm_usage as user_id="${USAGE_PSEUDO_USER}" (context "benchmark:<role>") + pushing to external usage telemetry (when configured).`);
  } catch (err) {
    console.warn(`[benchmark] ${realDbPath} isn't writable for usage logging (${err instanceof Error ? err.message : String(err)}) — the local ledger row will be skipped, but external telemetry (if configured) still fires via recordLlmUsage.`);
  }
}

// Seed the SCRATCH DB with the user's decrypted LLM keys (from the read-only real DB) plus env-var
// fallbacks, so resolveLlmEndpoint -> resolveLlmCredential (the app's real path) resolves them.
if (!process.env.ENCRYPTION_KEY) {
  console.warn("[benchmark] ENCRYPTION_KEY is not set — DB-stored (encrypted) keys cannot decrypt; only env keys will resolve.");
}
const seededServices = new Set<string>();
if (realDb) {
  const keyRows = realDb
    .prepare("SELECT service, api_key FROM user_api_keys WHERE user_id = ?")
    .all(CLI.user) as Array<{ service: string; api_key: string }>;
  for (const row of keyRows) {
    if (!(LLM_PROVIDER_SERVICES as readonly string[]).includes(row.service)) continue;
    try {
      const key = decryptValue(row.api_key);
      if (key && !key.includes(":")) {
        upsertUserApiKey(CLI.user, row.service, key, "benchmark-scratch");
        seededServices.add(row.service);
      }
    } catch {
      /* undecryptable row — env fallback below */
    }
  }
}
for (const service of LLM_PROVIDER_SERVICES) {
  if (seededServices.has(service)) continue;
  const envVar = apiKeyEnvVarForService(service);
  const envKey = envVar ? process.env[envVar]?.trim() : undefined;
  if (envKey) {
    upsertUserApiKey(CLI.user, service, envKey, "benchmark-scratch-env");
    seededServices.add(service);
  }
}
console.log(`[benchmark] credentials resolved for: ${[...seededServices].sort().join(", ") || "(none)"}`);

// ── Evidence pack: reconstruct the Green user turn from real data ────────────
interface EvidenceLike {
  symbol?: string;
  regime?: string;
  score?: number;
  refPrice?: number;
  sector?: string;
  factorBreakdown?: Record<string, number>;
  congressNet?: number;
  insiderSentiment?: number;
  shortPercentOfFloat?: number;
  beta?: number;
  intradayChangePct?: number;
  sectorRelStrength?: number;
  technicalScore?: number;
  technicalDirection?: string;
  technicalSignals?: string[];
  congressCompositeScore?: number;
  congressCompositeDirection?: string;
  congressCompositeConfidence?: number;
  asOf?: string;
  provider?: string;
  bulletins?: string[];
  derived?: Record<string, number>;
}

/** Drop null/undefined/non-finite/empty values — mirrors compactPromptObject in strategy.ts. */
function compact(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** CandidateEvidence (signal_snapshot digest) -> the compact candidate shape strategy.ts sends. */
function candidateFromEvidence(ev: EvidenceLike, index: number): Record<string, unknown> {
  return compact({
    rank: index + 1,
    sym: ev.symbol,
    px: ev.refPrice,
    chgPct: ev.intradayChangePct,
    shortFloat: ev.shortPercentOfFloat,
    beta: ev.beta,
    ...(ev.derived ?? {}),
    secRelStr: ev.sectorRelStrength,
    insiderSent: ev.insiderSentiment,
    senateNet: ev.congressNet,
    congressScore: ev.congressCompositeScore,
    congressDir: ev.congressCompositeDirection,
    congressConf: ev.congressCompositeConfidence,
    smartMoney: ev.bulletins?.slice(0, 3),
    sec: ev.sector,
    score: ev.score,
    factors: ev.factorBreakdown,
    techScore: ev.technicalScore,
    techDir: ev.technicalDirection,
    techSignals: ev.technicalSignals?.slice(0, 5),
    provider: ev.provider,
    asOf: ev.asOf
  });
}

// Bundled fixture pack (used when the DB holds no usable snapshot) — small but realistic.
const FIXTURE_CANDIDATES: EvidenceLike[] = [
  { symbol: "NVDA", refPrice: 172.4, intradayChangePct: 2.1, shortPercentOfFloat: 1.1, beta: 1.7, sector: "Technology", score: 78, technicalScore: 82, technicalDirection: "bullish", technicalSignals: ["sma20>sma50", "macd-cross-up"], derived: { earnYld: 2.3, dollarVolM: 28100, pctFromHigh: -4.2, rr52w: 1.4 }, congressNet: 2, insiderSentiment: 0.4, bulletins: ["Rep. X purchased $50k-100k NVDA (disclosed 3d ago)"] },
  { symbol: "XOM", refPrice: 118.9, intradayChangePct: -0.4, shortPercentOfFloat: 1.8, beta: 0.9, sector: "Energy", score: 71, technicalScore: 55, technicalDirection: "neutral", derived: { earnYld: 7.9, peg: 1.2, dollarVolM: 1450, pctFromHigh: -8.7 } },
  { symbol: "JPM", refPrice: 244.1, intradayChangePct: 0.8, shortPercentOfFloat: 0.9, beta: 1.1, sector: "Financial Services", score: 69, technicalScore: 66, technicalDirection: "bullish", derived: { earnYld: 6.9, roe: 16.1, dollarVolM: 2350, pctFromHigh: -2.9 } },
  { symbol: "UNH", refPrice: 301.5, intradayChangePct: -1.6, shortPercentOfFloat: 1.3, beta: 0.7, sector: "Healthcare", score: 66, technicalScore: 38, technicalDirection: "bearish", derived: { earnYld: 8.5, pctFromHigh: -47.8, rr52w: 2.6 }, insiderSentiment: 0.6, bulletins: ["Two directors bought $1M+ UNH last week"] },
  { symbol: "COST", refPrice: 912.7, intradayChangePct: 0.3, shortPercentOfFloat: 1.5, beta: 0.8, sector: "Consumer Defensive", score: 62, technicalScore: 61, technicalDirection: "neutral", derived: { earnYld: 2.0, payout: 28, dollarVolM: 1900, pctFromHigh: -10.2 } },
  { symbol: "CAT", refPrice: 397.2, intradayChangePct: 1.4, shortPercentOfFloat: 2.2, beta: 1.2, sector: "Industrials", score: 60, technicalScore: 72, technicalDirection: "bullish", derived: { earnYld: 5.4, peg: 1.6, dollarVolM: 980, pctFromHigh: -1.8 } }
];

const FIXTURE_MACRO: Record<string, unknown> = {
  vix: "17.4", vix3m: "18.9", tenYearTreasury: "4.28", twoYearTreasury: "3.92", dgs3moTreasury: "4.35",
  fedFundsRate: "4.33", cpi: "2.9", corePCE: "2.7", unemploymentRate: "4.1", realGDPGrowth: "2.3",
  hyCreditSpread: "3.1", usdIndex: "104.2", wtiOil: "71.5", inflationExpectation10y: "2.3", initialClaims: "224000"
};

function latestSnapshotEvidence(): { signals: EvidenceLike[]; regime?: string; source: string } {
  if (realDb) {
    try {
      const rows = realDb
        .prepare("SELECT payload, created_at FROM audit_events WHERE kind = 'signal_snapshot' AND user_id = ? ORDER BY created_at DESC LIMIT 5")
        .all(CLI.user) as Array<{ payload: string; created_at: string }>;
      for (const row of rows) {
        const parsed = JSON.parse(row.payload) as { signals?: EvidenceLike[] };
        const signals = (parsed.signals ?? []).filter((s) => typeof s.symbol === "string");
        if (signals.length >= 3) {
          signals.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
          return { signals: signals.slice(0, 12), regime: signals[0]?.regime, source: `signal_snapshot @ ${row.created_at}` };
        }
      }
    } catch (err) {
      console.warn(`[benchmark] signal_snapshot read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { signals: FIXTURE_CANDIDATES, regime: "Neutral", source: "bundled fixture (no usable signal_snapshot)" };
}

function latestMacro(): { macro: Record<string, unknown>; source: string } {
  if (realDb) {
    try {
      const row = realDb.prepare("SELECT value FROM settings WHERE key = ?").get(`last_macro_sent:${CLI.user}`) as { value: string } | undefined;
      if (row) return { macro: JSON.parse(row.value) as Record<string, unknown>, source: "settings:last_macro_sent" };
    } catch {
      /* fall through to fixture */
    }
  }
  return { macro: FIXTURE_MACRO, source: "bundled fixture" };
}

function latestPortfolio(): { portfolio: Record<string, unknown>; positions: unknown[]; source: string } {
  if (realDb) {
    try {
      const row = realDb
        .prepare("SELECT equity, cash, buying_power, positions_value, positions FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1")
        .get() as { equity: number; cash: number; buying_power: number; positions_value: number; positions: string } | undefined;
      if (row) {
        const positions = (JSON.parse(row.positions) as unknown[]).slice(0, 8);
        return {
          portfolio: {
            accountNumber: "benchmark",
            totalMarketValue: row.equity,
            buyingPower: row.buying_power,
            equityMarketValue: row.positions_value,
            optionMarketValue: 0,
            cash: row.cash
          },
          positions,
          source: "portfolio_snapshots (latest)"
        };
      }
    } catch {
      /* fall through to fixture */
    }
  }
  return {
    portfolio: { accountNumber: "benchmark", totalMarketValue: 25000, buyingPower: 8000, equityMarketValue: 17000, optionMarketValue: 0, cash: 8000 },
    positions: [
      { symbol: "AAPL", quantity: 10, averageCost: 205.2, marketValue: 2140, sector: "Technology" },
      { symbol: "XOM", quantity: 20, averageCost: 109.8, marketValue: 2378, sector: "Energy" }
    ],
    source: "bundled fixture"
  };
}

const evidence = latestSnapshotEvidence();
const macro = latestMacro();
const holdings = latestPortfolio();
const currentMarketRegime = evidence.regime ?? "Neutral";
const executionMode = "broker/live";
const executionModeClarification = "broker/live: orders route to the connected live brokerage account.";

const greenUserContent = {
  currentDate: new Date().toISOString(),
  executionMode,
  executionModeClarification,
  currentMarketRegime,
  portfolio: holdings.portfolio,
  positions: holdings.positions,
  recentOrders: [],
  allowedSymbols: {
    note: "All proposals must strictly be selected from `marketScan.topCandidates`. Do not propose symbols outside this list. You may SELL/TRIM any current position."
  },
  marketScan: {
    source: "benchmark-replay",
    generatedAt: new Date().toISOString(),
    scannedSymbols: 500,
    returnedQuotes: evidence.signals.length,
    candidateLimit: evidence.signals.length,
    hasAskData: false,
    topCandidates: evidence.signals.map(candidateFromEvidence),
    instructions: "No ask prices are available in this scan. Do not invent ask-relative limit prices."
  },
  limits: {
    maxOrderNotional: 1000,
    preferredMaxOrderNotional: 950,
    maxOrderPctOfNav: 5,
    remainingDailyNotional: 5000,
    remainingDailyOrders: 10
  },
  socraticAuthority: {
    overrideMode: "off",
    note: "Use autonomyOverride only for evidence-backed conflicts with owner preference gates. Do not use it for broker/account/integrity constraints."
  },
  macroeconomicData: macro.macro
};

// ── Schemas (mirror the literals in src/lib/strategy.ts proposeTrades) ───────
const ALLOWED_SIDES = ["buy", "sell"]; // long-only representative benchmark (shortAllowed=false)
const MAX_PROPOSALS = 3;

const autonomyOverrideSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["requested", "thesis", "preferenceConflicts", "invalidation", "cashDeploymentPct"],
      properties: {
        requested: { type: "boolean" },
        thesis: { type: "string" },
        preferenceConflicts: { type: "array", items: { type: "string" } },
        invalidation: { type: ["string", "null"] },
        cashDeploymentPct: { type: ["number", "null"] }
      }
    },
    { type: "null" }
  ]
};

const PROPOSAL_REQUIRED = [
  "symbol", "side", "type", "quantity", "dollarAmount", "limitPrice", "stopPrice", "timeInForce",
  "marketHours", "rationale", "tradeThesisTag", "confidenceScore", "autonomyOverride",
  "bracketStopLoss", "bracketTakeProfit"
];

function proposalItemSchema(confidenceDescription: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: PROPOSAL_REQUIRED,
    properties: {
      symbol: { type: "string" },
      side: { enum: ALLOWED_SIDES },
      type: { enum: ["market", "limit", "stop_market", "stop_limit"] },
      quantity: { type: ["number", "null"] },
      dollarAmount: { type: ["number", "null"] },
      limitPrice: { type: ["number", "null"] },
      stopPrice: { type: ["number", "null"] },
      timeInForce: { enum: ["gfd", "gtc"] },
      marketHours: { enum: ["regular_hours", "extended_hours", "all_day_hours"] },
      rationale: { type: "string" },
      tradeThesisTag: { enum: THESIS_PLAYBOOK },
      confidenceScore: { type: "number", minimum: 1, maximum: 100, description: confidenceDescription },
      autonomyOverride: autonomyOverrideSchema,
      bracketStopLoss: { type: ["number", "null"], description: "Per-trade protective stop PRICE (absolute price, not a percent) for this position. For a buy set it BELOW the entry, for a short ABOVE it. Derive it from the setup's own structure — a support/resistance level, a multiple of ATR, or the price that invalidates the thesis — sized to conviction, not a fixed one-size percentage. Leave null to fall back to the account's default per-symbol stop." },
      bracketTakeProfit: { type: ["number", "null"], description: "Optional per-trade take-profit PRICE (absolute). For a buy ABOVE the entry, for a short BELOW it. Leave null to use the account default." }
    }
  };
}

const bullSchema = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      maxItems: MAX_PROPOSALS,
      items: proposalItemSchema("Conviction score from 1 to 100")
    }
  }
};

// ── System prompts (the app's real builders, representative params) ──────────
const bullSystemPrompt = buildBullSystem({
  shortAllowed: false,
  executionMode,
  executionModeClarification,
  strategyPrompt: DEFAULT_STRATEGY_PROMPT,
  hasTaxContext: false,
  holdingHorizon: "swing",
  maxSymbolExposurePct: 20,
  stopLossPct: 8,
  takeProfitPct: 20
});
// The single Red Team reviewer critiques ONE finalized, risk-adding opening (representative:
// a long AAPL open). The benchmark measures the reviewer request through the real builder.
const bearSystemPrompt = buildRedTeamReviewSystem({ side: "buy", symbol: "AAPL" });

// ── Bear input: sample proposals under review ────────────────────────────────
type LooseProposal = Record<string, unknown>;

function sampleBullProposals(): { proposals: LooseProposal[]; source: string } {
  if (realDb) {
    try {
      const rows = realDb
        .prepare("SELECT proposal FROM trade_proposals ORDER BY created_at DESC LIMIT 25")
        .all() as Array<{ proposal: string }>;
      const picked: LooseProposal[] = [];
      for (const row of rows) {
        const p = JSON.parse(row.proposal) as LooseProposal;
        if (p.side !== "buy" && p.side !== "sell") continue;
        // Project onto the schema's fields so the Bear reviews exactly the shape the Bull emits.
        const projected: LooseProposal = {};
        for (const field of PROPOSAL_REQUIRED) projected[field] = p[field] ?? null;
        if (typeof projected.symbol === "string" && typeof projected.rationale === "string") picked.push(projected);
        if (picked.length >= 2) break;
      }
      if (picked.length > 0) return { proposals: picked, source: "trade_proposals (latest rows)" };
    } catch {
      /* fall through to fixture */
    }
  }
  const top = evidence.signals[0];
  return {
    proposals: [
      {
        symbol: top?.symbol ?? "NVDA",
        side: "buy",
        type: "limit",
        quantity: null,
        dollarAmount: 900,
        limitPrice: top?.refPrice ?? 172.0,
        stopPrice: null,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "Momentum breakout with sector leadership, strong technical score and congressional accumulation; sized below the preferred cap for liquidity.",
        tradeThesisTag: "Momentum-Breakout",
        confidenceScore: 72,
        autonomyOverride: null,
        bracketStopLoss: top?.refPrice ? Number((top.refPrice * 0.93).toFixed(2)) : 160.3,
        bracketTakeProfit: top?.refPrice ? Number((top.refPrice * 1.12).toFixed(2)) : 193.1
      }
    ],
    source: "bundled fixture proposal"
  };
}

const bearReview = sampleBullProposals();
const proposedSymbols = new Set(bearReview.proposals.map((p) => String(p.symbol)));
const bearUserContent = {
  currentDate: greenUserContent.currentDate,
  executionMode,
  executionModeClarification,
  currentMarketRegime,
  macroeconomicData: macro.macro,
  limits: greenUserContent.limits,
  socraticAuthority: greenUserContent.socraticAuthority,
  portfolio: holdings.portfolio,
  positions: holdings.positions,
  candidatesUnderReview: greenUserContent.marketScan.topCandidates.filter((c) => typeof c.sym === "string" && proposedSymbols.has(String(c.sym))),
  bullAgentProposals: bearReview.proposals
};

// ── Per-call execution + metrics ─────────────────────────────────────────────
interface CallRecord {
  model: string;
  role: Role;
  round: number;
  provider: string;
  transport: string;
  url: string;
  keySource: string;
  status: "ok" | "timeout" | "http-error" | "unparseable" | "no-credential" | "error" | "dry-run";
  latencyMs?: number;
  httpStatus?: number;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Provider-reported cache-read prompt tokens (post-#1086 extractLlmUsage; undefined before). */
  cachedPromptTokens?: number;
  /** Anthropic cache-write tokens (post-#1086; undefined before or on other providers). */
  cacheCreationTokens?: number;
  estCostUsd?: number;
  truncated?: boolean;
  proposalCount?: number;
  schemaValid?: boolean;
  bracketStopLossPopulated?: number;
  softTimeoutMs: number;
  requestBytes: number;
  /** True latency of a reply that settled AFTER the soft timeout (captured, not severed). */
  lateDurationMs?: number;
  lateHttpStatus?: number;
}

function validateProposals(parsed: unknown): { schemaValid: boolean; proposalCount: number; bracketPopulated: number } {
  // A bare top-level ARRAY of proposals is schema drift (the app's `parsed.proposals ?? []` would
  // silently read it as zero survivors) — flag it invalid but still count/inspect its items.
  const bareArray = Array.isArray(parsed);
  const nested = !bareArray && parsed && typeof parsed === "object" ? (parsed as { proposals?: unknown }).proposals : undefined;
  if (!bareArray && !Array.isArray(nested)) {
    return { schemaValid: false, proposalCount: 0, bracketPopulated: 0 };
  }
  const proposals = (bareArray ? parsed : nested) as unknown[];
  let valid = !bareArray;
  let bracketPopulated = 0;
  const numericFields = ["quantity", "dollarAmount", "limitPrice", "stopPrice", "confidenceScore", "bracketStopLoss", "bracketTakeProfit"];
  for (const item of proposals) {
    if (!item || typeof item !== "object") { valid = false; continue; }
    const p = item as LooseProposal;
    for (const field of PROPOSAL_REQUIRED) if (!(field in p)) valid = false;
    if (typeof p.symbol !== "string" || p.symbol.length === 0) valid = false;
    if (typeof p.rationale !== "string" || p.rationale.length === 0) valid = false;
    if (typeof p.confidenceScore !== "number" || !Number.isFinite(p.confidenceScore)) valid = false;
    for (const field of numericFields) {
      const v = p[field];
      if (v !== null && v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) valid = false;
    }
    if (typeof p.bracketStopLoss === "number" && Number.isFinite(p.bracketStopLoss)) bracketPopulated += 1;
  }
  return { schemaValid: valid, proposalCount: proposals.length, bracketPopulated };
}

const records: CallRecord[] = [];
const lateOutcomes: Promise<void>[] = [];

async function runOne(model: string, role: Role, round: number): Promise<void> {
  // The app's endpoint resolution: green routes off policy.llmModel, red off policy.redTeamLlmModel
  // (set explicitly so the cross-family Bear default never redirects the target model).
  const policy = role === "green" ? { llmModel: model } : { llmModel: model, redTeamLlmModel: model };
  const endpoint = resolveLlmEndpoint(policy, CLI.user, "https://api.openai.com/v1/responses", role);
  const softTimeoutMs = CLI.timeoutMs ?? strategyLlmTimeoutMs(endpoint.model, CLI.effort === "omit" ? undefined : CLI.effort);
  const base = {
    model: endpoint.model,
    role,
    round,
    provider: endpoint.provider,
    transport: endpoint.transport,
    url: endpoint.url,
    keySource: endpoint.keySource,
    softTimeoutMs
  };

  // Skip (never fail) when the provider has no credential — but in --dry-run still build the
  // request below so the whole pipeline is exercised without network or keys.
  if (!endpoint.key && !CLI.dryRun) {
    records.push({ ...base, status: "no-credential", requestBytes: 0, error: `no ${endpoint.provider} credential` });
    return;
  }

  const reasoningEffort = interactiveStrategyReasoningEffort(
    endpoint.model,
    CLI.effort === "omit" ? undefined : CLI.effort
  );
  const body = buildLlmRequestBody(
    { provider: endpoint.provider, transport: endpoint.transport },
    role === "green"
      ? {
          model: endpoint.model,
          systemPrompt: bullSystemPrompt,
          userContent: JSON.stringify(greenUserContent),
          schema: { name: "trade_proposals", schema: bullSchema, description: "The trade proposals the strategy advises this run." },
          maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.strategyProposal,
          reasoningEffort
        }
      : {
          model: endpoint.model,
          systemPrompt: bearSystemPrompt,
          userContent: JSON.stringify(bearUserContent),
          schema: { name: "red_team_verdict", schema: RED_TEAM_VERDICT_SCHEMA, description: "The Red Team's three-way verdict on the finalized trade." },
          maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.adversaryReview,
          reasoningEffort,
          temperature: LLM_REQUEST_DEFAULTS.adversaryTemperature
        }
  );
  if (CLI.effort === "omit") {
    // Diagnostic: send the same body with NO reasoning/thinking steering at all.
    delete (body as Record<string, unknown>).reasoning_effort;
    delete (body as Record<string, unknown>).prompt_mode;
    delete (body as Record<string, unknown>).thinking;
    delete (body as Record<string, unknown>).reasoning;
  }
  const requestJson = JSON.stringify(body);
  const requestBytes = Buffer.byteLength(requestJson);

  if (CLI.dryRun) {
    records.push({ ...base, status: "dry-run", requestBytes, ...(endpoint.key ? {} : { error: `no ${endpoint.provider} credential` }) });
    console.log(
      `[dry-run] ${role.padEnd(5)} ${endpoint.model.padEnd(24)} -> ${endpoint.provider}/${endpoint.transport} ${endpoint.url} ` +
        `(key=${endpoint.key ? endpoint.keySource : "MISSING"}, soft=${softTimeoutMs}ms, ${(requestBytes / 1024).toFixed(1)}KB, effort=${reasoningEffort ?? "n/a"})`
    );
    return;
  }

  const started = Date.now();
  const record: CallRecord = { ...base, status: "error", requestBytes };
  let lateResolve: (() => void) | undefined;
  try {
    const response = await llmFetchCapturing(
      endpoint.url,
      { method: "POST", headers: llmAuthHeaders(endpoint), body: requestJson },
      {
        softTimeoutMs,
        // Bound the leak backstop so a hung provider can't hold the process 300s past the last round.
        hardCapMs: softTimeoutMs + 120_000,
        onOutcome: (o) => {
          if (o.late) {
            record.lateDurationMs = o.durationMs;
            record.lateHttpStatus = o.status;
          }
          lateResolve?.();
        }
      }
    );
    record.latencyMs = Date.now() - started;
    if (!response.ok) {
      record.status = "http-error";
      record.httpStatus = response.status;
      record.error = (await response.text().catch(() => "")).slice(0, 300);
      return;
    }
    const payload: unknown = await response.json();
    const usage = extractLlmUsage(payload) as ReturnType<typeof extractLlmUsage> & CacheAwareUsage;
    record.promptTokens = usage.promptTokens;
    record.completionTokens = usage.completionTokens;
    record.totalTokens = usage.totalTokens;
    record.cachedPromptTokens = usage.cachedPromptTokens;
    record.cacheCreationTokens = usage.cacheCreationTokens;
    record.estCostUsd = estimateCost(endpoint.model, usage.promptTokens, usage.completionTokens, usage.cachedPromptTokens, usage.cacheCreationTokens);
    record.truncated = detectLlmTruncation(payload);
    const text = extractLlmText(payload);
    if (!text) {
      record.status = "unparseable";
      record.error = "empty response text";
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      record.status = "unparseable";
      record.error = `JSON.parse failed: ${text.slice(0, 160)}`;
      return;
    }
    const v = validateProposals(parsed);
    record.status = "ok";
    record.schemaValid = v.schemaValid;
    record.proposalCount = v.proposalCount;
    if (role === "green") record.bracketStopLossPopulated = v.bracketPopulated;
    // Keep a short excerpt of schema-drifting output so the report can say WHAT the model emitted.
    if (!v.schemaValid) record.error = `schema drift: ${text.slice(0, 240)}`;
  } catch (err) {
    record.latencyMs = Date.now() - started;
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      record.status = "timeout";
      record.error = `soft timeout after ${softTimeoutMs}ms (reply still capturing)`;
      // Keep waiting (bounded) for the late outcome so the true latency lands in the report.
      lateOutcomes.push(new Promise<void>((resolve) => { lateResolve = resolve; }));
    } else {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    records.push(record);
    if (record.promptTokens !== undefined || record.completionTokens !== undefined) {
      // recordLlmUsage is the ONE function that also fires external usage telemetry
      // (pushLlmUsage) — call it unconditionally so every benchmark call reaches the API Usage
      // Monitor exactly like every other LLM call site in the app. It never throws. Its own
      // local-ledger INSERT lands in this script's throwaway SCRATCH db (see the comment on
      // `usageDb` above) so it's harmless/discarded there; the REAL, persistent ledger row is
      // written separately below via the dedicated writable `usageDb` connection.
      recordLlmUsage({
        userId: USAGE_PSEUDO_USER,
        provider: record.provider,
        model: record.model,
        context: `benchmark:${role}`,
        keySource: record.keySource === "operator" ? "operator" : "user",
        promptTokens: record.promptTokens,
        completionTokens: record.completionTokens,
        cachedPromptTokens: record.cachedPromptTokens,
        cacheCreationTokens: record.cacheCreationTokens
      });
    }
    if (insertUsageStmt && (record.promptTokens !== undefined || record.completionTokens !== undefined)) {
      try {
        insertUsageStmt.run(
          crypto.randomUUID(),
          USAGE_PSEUDO_USER,
          record.provider,
          record.model,
          `benchmark:${role}`,
          record.keySource === "operator" ? "operator" : "user",
          null,
          record.promptTokens ?? null,
          record.completionTokens ?? null,
          record.totalTokens ?? null,
          record.estCostUsd ?? null,
          new Date().toISOString()
        );
      } catch (err) {
        console.warn(`[benchmark] usage log insert failed (${err instanceof Error ? err.message : String(err)}) — continuing without it.`);
      }
    }
    const tail = record.status === "ok"
      ? `${record.latencyMs}ms, ${record.proposalCount} proposal(s), schemaValid=${record.schemaValid}, tokens=${record.totalTokens ?? "?"}`
      : `${record.status}${record.httpStatus ? ` ${record.httpStatus}` : ""}${record.latencyMs ? ` @${record.latencyMs}ms` : ""}`;
    console.log(`[${role}] ${endpoint.model} r${round}: ${tail}`);
  }
}

// ── Aggregation ──────────────────────────────────────────────────────────────
interface Summary {
  model: string;
  role: Role;
  provider: string;
  attempts: number;
  successes: number;
  timeouts: number;
  httpErrors: number;
  unparseable: number;
  noCredential: boolean;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  /** Round-1 (cache-cold) vs rounds-2+ (cache-warm) split: identical back-to-back prompts hit
   *  provider prompt caches, so warm rounds run cheaper/faster than production's hourly cadence. */
  coldP50LatencyMs?: number;
  warmP50LatencyMs?: number;
  coldAvgCostUsd?: number;
  warmAvgCostUsd?: number;
  avgCachedPromptTokens?: number;
  avgCompletionTokens?: number;
  avgEstCostUsd?: number;
  schemaValidRate?: number;
  avgProposalCount?: number;
  bracketStopLossRate?: number;
}

function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(): Summary[] {
  const out: Summary[] = [];
  for (const model of MODELS) {
    for (const role of ROLES) {
      const rs = records.filter((r) => r.model === model && r.role === role);
      if (rs.length === 0) continue;
      const oks = rs.filter((r) => r.status === "ok");
      const latencies = oks.map((r) => r.latencyMs ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
      const completions = oks.map((r) => r.completionTokens).filter((v): v is number => typeof v === "number");
      const costs = oks.map((r) => r.estCostUsd).filter((v): v is number => typeof v === "number");
      const cachedToks = oks.map((r) => r.cachedPromptTokens).filter((v): v is number => typeof v === "number");
      // Cache-cold (round 1) vs cache-warm (rounds 2+): back-to-back identical prompts hit provider caches.
      const coldOks = oks.filter((r) => r.round === 1);
      const warmOks = oks.filter((r) => r.round > 1);
      const coldLatencies = coldOks.map((r) => r.latencyMs ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
      const warmLatencies = warmOks.map((r) => r.latencyMs ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
      const coldCosts = coldOks.map((r) => r.estCostUsd).filter((v): v is number => typeof v === "number");
      const warmCosts = warmOks.map((r) => r.estCostUsd).filter((v): v is number => typeof v === "number");
      const proposals = oks.map((r) => r.proposalCount).filter((v): v is number => typeof v === "number");
      const greenOks = oks.filter((r) => typeof r.bracketStopLossPopulated === "number");
      const bracketNumer = greenOks.reduce((sum, r) => sum + (r.bracketStopLossPopulated ?? 0), 0);
      const bracketDenom = greenOks.reduce((sum, r) => sum + (r.proposalCount ?? 0), 0);
      out.push({
        model,
        role,
        provider: rs[0].provider,
        attempts: rs.length,
        successes: oks.length,
        timeouts: rs.filter((r) => r.status === "timeout").length,
        httpErrors: rs.filter((r) => r.status === "http-error" || r.status === "error").length,
        unparseable: rs.filter((r) => r.status === "unparseable").length,
        noCredential: rs.every((r) => r.status === "no-credential"),
        p50LatencyMs: percentile(latencies, 50),
        p95LatencyMs: percentile(latencies, 95),
        coldP50LatencyMs: percentile(coldLatencies, 50),
        warmP50LatencyMs: percentile(warmLatencies, 50),
        coldAvgCostUsd: coldCosts.length ? coldCosts.reduce((a, b) => a + b, 0) / coldCosts.length : undefined,
        warmAvgCostUsd: warmCosts.length ? warmCosts.reduce((a, b) => a + b, 0) / warmCosts.length : undefined,
        avgCachedPromptTokens: cachedToks.length ? Math.round(cachedToks.reduce((a, b) => a + b, 0) / cachedToks.length) : undefined,
        avgCompletionTokens: completions.length ? Math.round(completions.reduce((a, b) => a + b, 0) / completions.length) : undefined,
        avgEstCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : undefined,
        schemaValidRate: oks.length ? oks.filter((r) => r.schemaValid).length / oks.length : undefined,
        avgProposalCount: proposals.length ? proposals.reduce((a, b) => a + b, 0) / proposals.length : undefined,
        bracketStopLossRate: role === "green" && bracketDenom > 0 ? bracketNumer / bracketDenom : undefined
      });
    }
  }
  return out;
}

function rankKey(s: Summary): number {
  // Higher is better: reliability first (successes with valid schema), then speed.
  const validRate = (s.successes / Math.max(1, s.attempts)) * (s.schemaValidRate ?? 0);
  const speedBonus = s.p50LatencyMs ? 1 / (1 + s.p50LatencyMs / 10_000) : 0;
  return validRate * 100 + speedBonus;
}

const fmtPct = (v: number | undefined): string => (v === undefined ? "-" : `${Math.round(v * 100)}%`);
const fmtMs = (v: number | undefined): string => (v === undefined ? "-" : `${(v / 1000).toFixed(1)}s`);
const fmtUsd = (v: number | undefined): string => (v === undefined ? "-" : `$${v.toFixed(4)}`);

function consoleTable(summaries: Summary[]): void {
  const header = ["model", "role", "ok/att", "t/o", "err", "p50", "p95", "cold", "warm", "valid", "props", "brkt", "avg$", "ctok", "cache"];
  const rows = summaries.map((s) => [
    s.model,
    s.role,
    s.noCredential ? "no-cred" : `${s.successes}/${s.attempts}`,
    String(s.timeouts),
    String(s.httpErrors + s.unparseable),
    fmtMs(s.p50LatencyMs),
    fmtMs(s.p95LatencyMs),
    fmtMs(s.coldP50LatencyMs),
    fmtMs(s.warmP50LatencyMs),
    fmtPct(s.schemaValidRate),
    s.avgProposalCount === undefined ? "-" : s.avgProposalCount.toFixed(1),
    fmtPct(s.bracketStopLossRate),
    fmtUsd(s.avgEstCostUsd),
    s.avgCompletionTokens === undefined ? "-" : String(s.avgCompletionTokens),
    s.avgCachedPromptTokens === undefined ? "-" : String(s.avgCachedPromptTokens)
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(`\n${line(header)}`);
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

/** Grand total + per-provider breakdown of what this run actually spent (est.), across ALL calls
 *  that returned usable token usage — regardless of role/model, so the script can self-report the
 *  real cost of a run in addition to the row it now always writes to the app's own ledger. */
interface SpendBreakdown {
  totalUsd: number;
  totalCalls: number;
  byProvider: Array<{ provider: string; usd: number; calls: number }>;
}
function computeSpend(): SpendBreakdown {
  const priced = records.filter((r) => typeof r.estCostUsd === "number");
  const byProviderMap = new Map<string, { usd: number; calls: number }>();
  for (const r of priced) {
    const entry = byProviderMap.get(r.provider) ?? { usd: 0, calls: 0 };
    entry.usd += r.estCostUsd ?? 0;
    entry.calls += 1;
    byProviderMap.set(r.provider, entry);
  }
  const byProvider = [...byProviderMap.entries()]
    .map(([provider, v]) => ({ provider, usd: v.usd, calls: v.calls }))
    .sort((a, b) => b.usd - a.usd);
  return { totalUsd: byProvider.reduce((a, b) => a + b.usd, 0), totalCalls: priced.length, byProvider };
}
function printSpend(spend: SpendBreakdown): void {
  console.log(`\n[benchmark] est. total spend this run: $${spend.totalUsd.toFixed(4)} across ${spend.totalCalls} priced call(s)`);
  for (const p of spend.byProvider) console.log(`  ${p.provider.padEnd(12)} $${p.usd.toFixed(4)}  (${p.calls} call${p.calls === 1 ? "" : "s"})`);
  if (!CLI.dryRun) console.log(`  (logged to /admin/llm-usage as user_id="${USAGE_PSEUDO_USER}" + pushed to external usage telemetry, when configured)`);
}

function markdownReport(summaries: Summary[], spend: SpendBreakdown): string {
  const lines: string[] = [];
  lines.push("# LLM model benchmark — Green (Bull proposer) + Red (Bear reviewer)");
  lines.push("");
  lines.push(`- Run: ${new Date().toISOString()} | rounds: ${CLI.rounds} | roles: ${ROLES.join(", ")} | user: ${CLI.user}${CLI.dryRun ? " | DRY RUN (no network)" : ""}`);
  lines.push(
    `- **Est. total spend this run: $${spend.totalUsd.toFixed(4)}** across ${spend.totalCalls} priced call(s)` +
      (spend.byProvider.length ? ` — ${spend.byProvider.map((p) => `${p.provider} $${p.usd.toFixed(4)} (${p.calls})`).join(", ")}` : "") +
      (CLI.dryRun ? "" : ` — logged to llm_usage as user_id="${USAGE_PSEUDO_USER}" + pushed to external usage telemetry (when configured)`)
  );
  lines.push(`- Input pack: candidates from ${evidence.source}; macro from ${macro.source}; portfolio from ${holdings.source}; Bear reviews ${bearReview.source}.`);
  lines.push("- Request path: resolveLlmEndpoint -> buildLlmRequestBody (real strategy schemas + prompts) -> llmFetchCapturing (soft timeout = strategyLlmTimeoutMs).");
  lines.push("- Rank = success-with-valid-schema rate, ties broken by p50 latency. `brkt` = share of green proposals with a populated bracketStopLoss.");
  lines.push(
    "- CACHE-WARM CAVEAT: rounds 2+ re-send the identical prompt back-to-back, so they hit provider prompt caches — warm latency/cost flatters vs production's spaced-out cadence. Compare `cold p50`/`cold $` (round 1) for realistic first-call behavior; `cache tok` = avg provider-reported cache-read prompt tokens."
  );
  lines.push("");
  for (const role of ROLES) {
    const roleRows = summaries.filter((s) => s.role === role).sort((a, b) => rankKey(b) - rankKey(a));
    lines.push(`## ${role === "green" ? "Green / Bull proposer" : "Red / Bear reviewer"}`);
    lines.push("");
    lines.push("| rank | model | ok/attempts | timeouts | errors | p50 | p95 | cold p50 | warm p50 | schema-valid | avg proposals | brkt | avg est $/call | cold $ | warm $ | avg completion tok | cache tok |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    roleRows.forEach((s, i) => {
      lines.push(
        `| ${i + 1} | ${s.model} | ${s.noCredential ? "no credential" : `${s.successes}/${s.attempts}`} | ${s.timeouts} | ${s.httpErrors + s.unparseable} | ` +
          `${fmtMs(s.p50LatencyMs)} | ${fmtMs(s.p95LatencyMs)} | ${fmtMs(s.coldP50LatencyMs)} | ${fmtMs(s.warmP50LatencyMs)} | ${fmtPct(s.schemaValidRate)} | ` +
          `${s.avgProposalCount === undefined ? "-" : s.avgProposalCount.toFixed(1)} | ${fmtPct(s.bracketStopLossRate)} | ` +
          `${fmtUsd(s.avgEstCostUsd)} | ${fmtUsd(s.coldAvgCostUsd)} | ${fmtUsd(s.warmAvgCostUsd)} | ${s.avgCompletionTokens ?? "-"} | ${s.avgCachedPromptTokens ?? "-"} |`
      );
    });
    lines.push("");
  }
  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────
console.log(
  `[benchmark] ${MODELS.length} model(s) x ${ROLES.length} role(s) x ${CLI.rounds} round(s)` +
    `${CLI.dryRun ? " [DRY RUN]" : ""} — candidates: ${evidence.source}`
);
for (const model of MODELS) {
  for (const role of ROLES) {
    for (let round = 1; round <= CLI.rounds; round++) {
      // Sequential on purpose: parallel calls would contaminate each other's latency + rate limits.
      await runOne(model, role, round);
      // A model+role with no credential is fully recorded on round 1; skip redundant rounds.
      if (records[records.length - 1]?.status === "no-credential") break;
    }
  }
}

// Give soft-timed-out replies a bounded grace window so their TRUE latency lands in the report.
if (lateOutcomes.length > 0) {
  console.log(`[benchmark] waiting up to 60s for ${lateOutcomes.length} late repl(ies) to settle...`);
  await Promise.race([Promise.allSettled(lateOutcomes), new Promise((resolve) => setTimeout(resolve, 60_000))]);
}

const summaries = summarize();
consoleTable(summaries);
const spend = computeSpend();
printSpend(spend);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const outBase = (CLI.out ?? path.join(process.cwd(), `llm-benchmark-${stamp}`)).replace(/\.(json|md)$/, "");
fs.writeFileSync(
  `${outBase}.json`,
  JSON.stringify(
    {
      runAt: new Date().toISOString(),
      rounds: CLI.rounds,
      roles: ROLES,
      models: MODELS,
      dryRun: CLI.dryRun,
      inputPack: { candidates: evidence.source, macro: macro.source, portfolio: holdings.source, bearProposals: bearReview.source },
      spend,
      recordedToLedger: !CLI.dryRun,
      summaries,
      records
    },
    null,
    2
  )
);
fs.writeFileSync(`${outBase}.md`, markdownReport(summaries, spend));
console.log(`\n[benchmark] wrote ${outBase}.json and ${outBase}.md`);

realDb?.close();
usageDb?.close();
try {
  fs.rmSync(scratchDir, { recursive: true, force: true });
} catch {
  /* scratch cleanup is best-effort */
}
// In-flight late fetches past the grace window would otherwise hold the event loop; exit explicitly.
process.exit(0);
