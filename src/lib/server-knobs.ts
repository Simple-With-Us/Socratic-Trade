/**
 * Server-level operational knobs — the Infisical/env pause & kill switches, made real runtime
 * toggles (owner directive 2026-08-13: "add toggles to the settings for any variable that can
 * pause anything in Infisical").  Resolution order per knob:
 *
 *   1. server-scoped DB override (settings KV `server_knobs`, written from Admin > Operations)
 *   2. Infisical settings cache (src/lib/infisical-settings.ts) — the live, background-refreshed
 *      in-memory copy of the Infisical project values; falls back to process.env before the
 *      cache initializes (the runner injects the same Infisical-sourced values at boot, so the
 *      fallback is identical)
 *   3. catalog defaultValue
 *
 * Admin flips are WRITE-THROUGH (fleet SOT directive 2026-10-03): writeServerKnobThrough()
 * persists the value to the Infisical app project FIRST, then updates the cache, then the DB
 * override.  A failed Infisical write fails the save.  In production the app process holds no
 * Infisical credentials (the secrets runner scrubs them by design), so write-through is
 * unavailable there and the DB override remains the persistent local layer — see INFISICAL.md.
 *
 * Reads are hot-path cheap: one in-process cache with a short TTL (SERVER_KNOB_CACHE_TTL_MS) plus
 * explicit invalidation on write, and they FAIL OPEN to env/default on any store error — a broken
 * settings table must never take a data lane down harder than the knob itself would.
 *
 * Scope decisions (inventory of `process.env` pause/enable knobs across src/lib, 2026-08-13):
 *
 * INCLUDED (server-scoped pause/kill switches; consumption sites converted to resolveServerKnob):
 *   - SEC_INGEST_WORKER_ENABLED       backfill worker; loop parks/resumes per tick (sec-ingest-worker.ts)
 *   - STREAMS_ALPACA_NEWS_ENABLED     news WS worker (streams/alpaca-news-stream.ts)
 *   - STREAMS_ALPACA_TRADE_UPDATES_ENABLED  fill WS worker (streams/alpaca-trade-updates-stream.ts)
 *   - STREAMS_ALPACA_PRICE_EVENTS_ENABLED   price-event WS worker (streams/alpaca-price-events-stream.ts)
 *   - CONGRESS_STREAM_ENABLED         App A SSE consumer (congress-stream.ts; edge-safe module, so it
 *                                     consumes this knob via an injected resolver — see server-knob-supervisor.ts)
 *   - R2_USAGE_DAILY_DIGEST           daily R2 usage push (r2-usage.ts)
 *   - RAG_INGEST_BUDGET_ENABLED       daily embed-volume budget (vector-db.ts)
 *   - RAG_PINECONE_WRITE_BUDGET_ENABLED  daily Pinecone WU budget (vector-db.ts)
 *   - SEC_FILING_RAG_MAX_PER_RUN      filings-per-tick cap, 0 = pause (web-sources/sec-filings.ts).
 *                                     Also a per-user source setting; precedence there is now
 *                                     user > server override > env > default (source-settings.ts).
 *
 * EXCLUDED, with reasons:
 *   - Credential-like / infra-boot-critical: DB_BOOTSTRAP, LITESTREAM_*, REQUIRE_SECRETS_MANAGER,
 *     INFISICAL_*, ENCRYPTION_KEY, ADMIN_* tokens — consumed before/outside the DB, or secrets.
 *   - Per-user data-plane knobs already REAL via SOURCE_SETTINGS_CATALOG (WEB_SOURCE_*,
 *     EARNINGSCALLS_*, ROIC_*, RAG_MULTIQUERY/HYDE, SEC_XBRL_ENRICHMENT_ENABLED, NEWS_RELEVANCE_*,
 *     POLYMARKET_*): those live in user Settings > Sources, not here.
 *   - Safety-interlock disables (PROVIDER_RATE_LIMIT_DISABLED, API_CIRCUIT_BREAKER_DISABLED,
 *     LLM_PROVIDER_COOLDOWN_DISABLED, HEALTH_LANE_REPROBE_ENABLED): incident/test escape hatches
 *     for provider-protective pacing and health self-probes, not operational pauses; deliberately
 *     left env-only so a UI mis-click cannot remove provider protection.  Still adjustable via
 *     Infisical.
 *   - Data-plane provider/enrichment tier gates (WEBULL_UNOFFICIAL_ENABLED, MASSIVE_*,
 *     ROBINHOOD_*, ENRICHMENT_*, FMP_PRICE_TARGETS_ENABLED, NASDAQ_CALENDAR_ENRICHMENT_ENABLED):
 *     select WHICH quote/fundamentals providers serve the enrichment cascade — data-source
 *     selection knobs that pair with keys/plan tiers provisioned alongside them in env, not
 *     pause switches.
 *   - Cross-app Congress.Trade integration flags (CONGRESS_TRADE_READS_ENABLED,
 *     CONGRESS_SHARE_ENABLED, CONGRESS_ANALYTICS_ENABLED): App A link wiring that pairs with
 *     env-provisioned tokens/base URLs; only the SSE consumer (CONGRESS_STREAM_ENABLED) is an
 *     operational pause and IS catalogued.
 *   - USAGE_MONITOR_KNOBS_ENABLED: gates syncing subscription knobs FROM the external usage
 *     monitor — cross-app config plumbing, not an in-app pause.
 *   - R2_COLD_SNAPSHOT_ENABLED: the weekly disaster-recovery snapshot kill switch
 *     (r2-cold-snapshot.ts); left env-only for now so a UI mis-click cannot silently stop DR
 *     backups — a candidate for a future catalog entry with copy that makes that risk explicit.
 *   - Observability vendor wiring (SENTRY_CRONS_ENABLED, LANGFUSE_ENABLED): boot-time SDK init;
 *     a runtime flip would not take effect honestly.
 *   - OTLP_METRICS_INGEST_ENABLED: no such knob exists in this codebase (verified by grep).
 *
 * Env parsing: truthy = 1/true/on/yes, falsy = 0/false/off/no (case/space-insensitive); any other
 * set value falls back to the catalog default.  This is deliberately NOT envFlagOn's garbage->false:
 * for default-ON budget knobs, a typo'd env value must keep the budget ENFORCED, not silently
 * remove it.
 */

import { getInternalSetting, setInternalSetting } from "./db-settings";
import {
  infisicalSettingsStatus,
  peekSetting,
  setSetting
} from "./infisical-settings";

export type ServerKnobType = "boolean" | "number";

export type ServerKnobGroup = "workers" | "streams" | "budgets" | "retrieval";

export interface ServerKnobSpec {
  /** Stable id — exactly the env var name it overrides. */
  id: string;
  group: ServerKnobGroup;
  label: string;
  description: string;
  type: ServerKnobType;
  /** Default when neither DB override nor env is set.  Mirrors the consumption site's old default. */
  defaultValue: boolean | number;
  min?: number;
  max?: number;
  /** Honest note on WHEN a flip takes effect.  Shown verbatim in Admin > Operations. */
  effect: string;
}

export const SERVER_KNOB_GROUPS: Record<ServerKnobGroup, { title: string; blurb: string }> = {
  workers: {
    title: "Background workers",
    blurb: "Process-level job loops.  Flips park or resume the loop at runtime — no redeploy."
  },
  streams: {
    title: "Streaming connections",
    blurb: "Long-lived outbound WebSocket/SSE consumers.  Flips start or park each stream at runtime."
  },
  budgets: {
    title: "Budgets & digests",
    blurb: "Daily spend caps and scheduled pushes.  Read fresh on every pass — flips apply on the next call."
  },
  retrieval: {
    title: "Retrieval",
    blurb: "RAG read-path routing.  Checked fresh on every retrieval pass — flips apply to the next query."
  }
};

export const SERVER_KNOBS_CATALOG: readonly ServerKnobSpec[] = [
  {
    id: "SEC_INGEST_WORKER_ENABLED",
    group: "workers",
    label: "SEC backfill worker",
    description: "Background job queue for large 10-K/10-Q backfills.  Jobs are seeded separately via the sec-ingest admin route.",
    type: "boolean",
    defaultValue: true,
    effect: "Takes effect within about 20 seconds.  The worker loop parks itself while off and resumes when turned back on."
  },
  {
    id: "SEC_INGEST_DAYTIME_ENABLED",
    group: "workers",
    label: "SEC ingest during market hours",
    description: "Allow polite 1-task-per-tick SEC filing ingestion during regular trading hours (09:30-16:00 ET).  When off, ingest defers to non-RTH ticks.",
    type: "boolean",
    defaultValue: true,
    effect: "Takes effect on the next worker tick.  When on, the worker paces at 1 task per tick and yields to in-flight strategy work."
  },
  {
    id: "SEC_INGEST_TASKS_PER_TICK_RTH",
    group: "workers",
    label: "SEC ingest daytime tasks / tick",
    description: "Number of filing tasks claimed per tick during regular trading hours.",
    type: "number",
    defaultValue: 1,
    min: 1,
    max: 5,
    effect: "Applies on the next worker tick during market hours."
  },
  {
    id: "SEC_INGEST_TASKS_PER_TICK_OFF_HOURS",
    group: "workers",
    label: "SEC ingest night/off-hours tasks / tick",
    description: "Number of filing tasks claimed per tick outside trading hours and at night (accelerated throughput).",
    type: "number",
    defaultValue: 5,
    min: 1,
    max: 20,
    effect: "Applies on the next worker tick outside market hours."
  },
  {
    id: "TRANSCRIPTS_DAYTIME_ENABLED",
    group: "workers",
    label: "Earnings transcripts daytime ingestion",
    description: "Allow earnings call transcripts (ROIC, EarningsCalls, FMP) to ingest at a measured pace during market hours rather than deferring entirely to off-hours.",
    type: "boolean",
    defaultValue: true,
    effect: "Applies at the next scheduler pass.  Ingest yields immediately to in-flight strategy runs."
  },
  {
    id: "STREAMS_ALPACA_NEWS_ENABLED",
    group: "streams",
    label: "Alpaca news stream",
    description: "Persistent Benzinga news WebSocket feeding streamed headlines into enrichment.",
    type: "boolean",
    defaultValue: false,
    effect: "Turning on starts the stream within about a minute.  Turning off stops article processing within about 15 seconds; the idle socket closes at the next message or reconnect."
  },
  {
    id: "STREAMS_ALPACA_TRADE_UPDATES_ENABLED",
    group: "streams",
    label: "Alpaca trade-updates stream",
    description: "Persistent fill/partial-fill WebSocket that drives real-time fill reconciliation.",
    type: "boolean",
    defaultValue: false,
    effect: "Turning on starts the stream within about a minute.  Turning off stops fill processing within about 15 seconds; the idle socket closes at the next message or reconnect.  While off, fills reconcile on the polling path instead."
  },
  {
    id: "STREAMS_ALPACA_PRICE_EVENTS_ENABLED",
    group: "streams",
    label: "Alpaca price-events stream",
    description: "Minute-bar WebSocket that feeds the intraday trigger engine for watched symbols.",
    type: "boolean",
    defaultValue: false,
    effect: "Turning on starts the stream within about a minute.  Turning off stops bar processing within about 15 seconds; the idle socket closes at the next bar or reconnect."
  },
  {
    id: "CONGRESS_STREAM_ENABLED",
    group: "streams",
    label: "Congress.Trade live stream",
    description: "SSE consumer of congress.trade disclosures (App A push link).",
    type: "boolean",
    defaultValue: false,
    effect: "Turning on starts the consumer within about a minute.  Turning off parks it at the next event frame or reconnect."
  },
  {
    id: "R2_USAGE_DAILY_DIGEST",
    group: "budgets",
    label: "R2 usage daily digest",
    description: "Daily push summary of Cloudflare R2 free-tier consumption and pace.",
    type: "boolean",
    defaultValue: true,
    effect: "Applies at the next scheduler pass."
  },
  {
    id: "RAG_INGEST_BUDGET_ENABLED",
    group: "budgets",
    label: "RAG ingest budget",
    description: "Rolling 24h cap on embedded texts (RAG_INGEST_MAX_TEXTS_PER_DAY).",
    type: "boolean",
    defaultValue: true,
    effect: "Applies to the next ingest call.  Turning off removes the daily cap — embedding volume is then unlimited."
  },
  {
    id: "RAG_PINECONE_WRITE_BUDGET_ENABLED",
    group: "budgets",
    label: "Pinecone write budget",
    description: "Rolling 24h cap on Pinecone write units (RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY).",
    type: "boolean",
    defaultValue: true,
    effect: "Applies to the next upsert call.  Turning off removes the daily cap — Pinecone writes are then unlimited."
  },
  {
    id: "RAG_VECTOR_READ_QDRANT",
    group: "retrieval",
    label: "Qdrant read backend",
    description: "Serve RAG retrieval queries from the self-hosted Qdrant collection instead of Pinecone.",
    type: "boolean",
    defaultValue: true,
    effect: "Applies to the next retrieval pass.  Requires QDRANT_URL (and QDRANT_API_KEY) in the environment; without them reads stay on Pinecone.  The string env RAG_VECTOR_READ_BACKEND=qdrant|pinecone is honored when neither this override nor this env var is set."
  },
  {
    id: "RAG_VECTOR_WRITE_QDRANT",
    group: "retrieval",
    label: "Qdrant write backend",
    description: "Send RAG upserts, deletes, and inventory to the self-hosted Qdrant collection instead of Pinecone.  Default on when QDRANT_URL is configured so ingest is not parked on exhausted Pinecone write units.",
    type: "boolean",
    defaultValue: true,
    effect: "Applies to the next store, delete, or inventory call.  Requires QDRANT_URL (and QDRANT_API_KEY) in the environment; without them writes stay on Pinecone.  The string env RAG_VECTOR_WRITE_BACKEND=qdrant|pinecone is honored when neither this override nor this env var is set.  The Pinecone monthly WU breaker and daily write fuse apply only to the Pinecone write backend."
  },
  {
    id: "SEC_FILING_RAG_MAX_PER_RUN",
    group: "budgets",
    label: "10-K/10-Q filings per run",
    description: "Max full filing bodies ingested per scheduler tick (paid embedding).  0 pauses filing ingest.",
    type: "number",
    defaultValue: 25,
    min: 0,
    max: 5000,
    effect: "Applies at the next scheduler tick.  A signed-in user's own Settings > Sources override still wins over this server value."
  },
  {
    id: "CONGRESS_SHARE_FUNDAMENTALS_ENABLED",
    group: "retrieval",
    label: "Share fundamentals with Congress Trade",
    description: "Includes fundamentals and analyst consensus in data shared with Congress Trade.",
    type: "boolean",
    defaultValue: true,
    effect: "Applies at the next market scan or daily share. When true, forwards PE, EPS, beta, dividend yield, and analyst consensus to Congress Trade."
  }
] as const;

export function serverKnobById(id: string): ServerKnobSpec | undefined {
  return SERVER_KNOBS_CATALOG.find((s) => s.id === id);
}

export const SERVER_KNOBS_SETTING_KEY = "server_knobs";
export const SERVER_KNOB_CACHE_TTL_MS = 15_000;

const TRUTHY = new Set(["1", "true", "on", "yes"]);
const FALSY = new Set(["0", "false", "off", "no"]);

type OverrideMap = Record<string, boolean | number>;

let cache: { at: number; map: OverrideMap } | null = null;

/** Cached DB override map.  Fail-open: any store error resolves to "no overrides" (env wins). */
function overridesMap(): OverrideMap {
  const now = Date.now();
  if (cache && now - cache.at < SERVER_KNOB_CACHE_TTL_MS) return cache.map;
  let map: OverrideMap = {};
  try {
    const stored = getInternalSetting<Record<string, unknown>>(SERVER_KNOBS_SETTING_KEY);
    if (stored && typeof stored === "object") {
      for (const [k, v] of Object.entries(stored)) {
        const spec = serverKnobById(k);
        if (!spec) continue; // stale id from a removed knob — ignore, never throw
        if (spec.type === "boolean" && typeof v === "boolean") map[k] = v;
        else if (spec.type === "number" && typeof v === "number" && Number.isFinite(v)) map[k] = v;
      }
    }
  } catch {
    map = {};
  }
  cache = { at: now, map };
  return map;
}

/** Drop the read cache so the next resolve re-reads the store.  Called on every write; exported for tests. */
export function invalidateServerKnobCache(): void {
  cache = null;
}

/** Raw DB override for a knob id, or undefined when none is set.  Never throws (fail-open read). */
export function serverKnobOverride(id: string): boolean | number | undefined {
  const map = overridesMap();
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
}

function envValueFor(spec: ServerKnobSpec): boolean | number | undefined {
  // Live Infisical settings cache first; boot-injected process.env before the cache
  // initializes (identical source — the runner populated it from Infisical).
  const raw = peekSetting(spec.id);
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "") return undefined;
  if (spec.type === "boolean") {
    if (TRUTHY.has(v)) return true;
    if (FALSY.has(v)) return false;
    return undefined; // unrecognized value -> catalog default (see module header)
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function clamp(spec: ServerKnobSpec, n: number): number {
  let v = n;
  if (typeof spec.min === "number") v = Math.max(spec.min, v);
  if (typeof spec.max === "number") v = Math.min(spec.max, v);
  return v;
}

/** Effective value for a catalogued knob: DB override > env > default.  Throws on unknown ids
 *  (a typo'd call site is a programmer error, not a runtime state). */
export function resolveServerKnob(id: string): boolean | number {
  const spec = serverKnobById(id);
  if (!spec) throw new Error(`Unknown server knob: ${id}`);
  const override = serverKnobOverride(id);
  if (spec.type === "boolean" && typeof override === "boolean") return override;
  if (spec.type === "number" && typeof override === "number") return clamp(spec, override);
  const env = envValueFor(spec);
  if (env !== undefined) return env;
  return spec.defaultValue;
}

/** Typed convenience for boolean knobs. */
export function serverKnobBool(id: string): boolean {
  return resolveServerKnob(id) === true;
}

/** Typed convenience for number knobs. */
export function serverKnobNumber(id: string): number {
  const v = resolveServerKnob(id);
  return typeof v === "number" ? v : Number(v);
}

/**
 * Write (value) or clear (null) a knob's DB override.  Reads the stored map directly — never the
 * cache — and invalidates the cache afterward so this process resolves the new value immediately.
 * Unlike reads, a store FAILURE here throws: a knob write the operator believes landed must never
 * silently no-op.
 */
export function setServerKnobOverride(id: string, value: boolean | number | null): void {
  const spec = serverKnobById(id);
  if (!spec) throw new Error(`Unknown server knob: ${id}`);
  if (value !== null) {
    if (spec.type === "boolean" && typeof value !== "boolean") throw new Error(`${id} expects a boolean`);
    if (spec.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${id} expects a finite number`);
  }
  const stored = getInternalSetting<Record<string, unknown>>(SERVER_KNOBS_SETTING_KEY) ?? {};
  const next: Record<string, unknown> = { ...stored };
  if (value === null) delete next[id];
  else next[id] = spec.type === "number" ? clamp(spec, value as number) : value;
  setInternalSetting(SERVER_KNOBS_SETTING_KEY, next);
  invalidateServerKnobCache();
}

/**
 * Write-through knob save (fleet SOT directive 2026-10-03): persists the value to the
 * Infisical app project FIRST, then updates the local settings cache, then the DB
 * override.  A failed Infisical write fails the whole save — the layers never diverge
 * silently.  Clearing (null) only clears the DB override and leaves the Infisical value
 * alone (clear = "fall back to Infisical/default").
 *
 * In production the app process holds no Infisical credentials (the secrets runner
 * scrubs them by design), so write-through is unavailable there: the save still lands
 * the DB override (today's behavior) and reports infisicalWriteThrough: false so the
 * admin surface can say so honestly.  See INFISICAL.md.
 */
export async function writeServerKnobThrough(
  id: string,
  value: boolean | number | null
): Promise<{ infisicalWriteThrough: boolean }> {
  const spec = serverKnobById(id);
  if (!spec) throw new Error(`Unknown server knob: ${id}`);
  if (value !== null) {
    if (spec.type === "boolean" && typeof value !== "boolean")
      throw new Error(`${id} expects a boolean`);
    if (spec.type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
      throw new Error(`${id} expects a finite number`);
  }
  let through = false;
  if (value !== null && infisicalSettingsStatus().credentialed) {
    const serialized = spec.type === "boolean" ? (value ? "true" : "false") : String(value);
    // Infisical FIRST — setSetting() throws InfisicalWriteError on failure and the
    // DB override below is never written, so the layers cannot diverge silently.
    await setSetting(id, serialized);
    through = true;
  }
  setServerKnobOverride(id, value);
  return { infisicalWriteThrough: through };
}

export interface EffectiveServerKnob {
  spec: ServerKnobSpec;
  value: boolean | number;
  /** "env" = the Infisical-backed layer (live settings cache, or boot env before init). */
  source: "override" | "env" | "default";
  /** What env alone would resolve to (env value, else default) — shown as the reset target. */
  envValue: boolean | number;
  override: boolean | number | null;
}

/** Effective values + provenance for the Admin > Operations panel. */
export function listEffectiveServerKnobs(): EffectiveServerKnob[] {
  return SERVER_KNOBS_CATALOG.map((spec) => {
    const override = serverKnobOverride(spec.id) ?? null;
    const env = envValueFor(spec);
    const envValue = env !== undefined ? env : spec.defaultValue;
    let source: EffectiveServerKnob["source"] = "default";
    let value: boolean | number = spec.defaultValue;
    if (override !== null) {
      source = "override";
      value = spec.type === "number" ? clamp(spec, override as number) : override;
    } else if (env !== undefined) {
      source = "env";
      value = env;
    }
    return { spec, value, source, envValue, override };
  });
}
