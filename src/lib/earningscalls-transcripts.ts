// earningscalls-transcripts.ts — EarningsCalls.dev as an alternate earnings-call-transcript
// SOURCE feeding the same rights-gated RAG boundary as the FMP producer (storeDocument with
// doc_type "earnings-transcript"), designed around the owner's plan: a hard provider-side limit
// of 200 requests/month (RapidAPI free channel) or more on paid tiers, and a burst-then-smart-daily
// cadence (docs/rollouts/2026-07-19-earningscalls-burst-smart-daily.md, recon memo
// earningscalls-api-truth.md): 25 transcripts once, then 5/day with smart candidate selection.
//
// ── API ground truth (researched 2026-07-16, re-verified 2026-07-19 against the live openapi.json) ──
//   - Host: https://earningscalls.dev, base path /api/v1. Also resold via RapidAPI (same /api/v1
//     path family) under earnings-call-transcripts1.p.rapidapi.com — the owner's free-tier channel.
//   - Auth: `X-API-Key` header (direct) or `x-rapidapi-key`/`x-rapidapi-host` (RapidAPI).
//   - THERE IS NO symbol+fiscal_year+fiscal_quarter direct-fetch endpoint. Full transcript text is
//     served ONLY by GET /transcripts/{earningsId}?format=full, where earningsId is a
//     provider-internal integer. Every id must be RESOLVED first, via one of:
//       - GET /transcripts/recent (cursor listing, `after_id`/`next_after_id`, ALL tickers,
//         metadata only) — the amortized id-resolution engine, ~1 request/day for up to 100 ids.
//       - GET /companies/ticker/{ticker}/latest — single-symbol latest-call probe (1 request per
//         symbol; DEMOTED to a fallback for symbols the listing engine hasn't covered yet).
//       - GET /companies/ticker/{ticker} — full call history for one symbol (1 request resolves
//         EVERY quarter that symbol has ever reported); used for burst historical backfill.
//       - GET /me — auth + tier details; the entitlement probe (see below).
//   - Request accounting is undefined in the docs beyond "requests/month" — this module
//     conservatively counts EVERY dispatched HTTP call (metadata and transcript alike).
//
// ── Entitlement risk (CRITICAL — read before touching the fetch path) ──────────────────────────
// The first-party pricing page gates FULL transcript text to paid tiers; the Free tier ($0) returns
// "transcript previews (250 chars)" only. Whether the owner's RapidAPI free-tier subscription
// entitles full text or also serves previews was UNVERIFIED as of the 2026-07-19 recon (subscription
// too new to probe live). Ingesting a 250-char preview as if it were a real transcript would
// permanently poison the fetch-once-forever cache (a content hit never re-fetches) — the risk is
// not "briefly wrong," it's "wrong forever until an operator notices and manually purges rows."
// Two independent guards defend against this:
//   1. ENTITLEMENT PROBE: before the first-ever burst or daily pass (persisted state starts
//      "unknown"), the pass calls GET /me (best-effort tier-text sniff) and inspects the length of
//      the first real transcript body it fetches. A body shorter than
//      EARNINGSCALLS_PREVIEW_GUARD_MIN_CHARS flips a durable "preview_blocked" state, REFUSES every
//      further burst/daily fetch (not just this pass — every future pass, until an operator acts),
//      and emits exactly ONE operator notification (earningscalls_entitlement_blocked). No retry
//      storm: the block persists until POST /api/admin/earningscalls clears or re-probes it.
//   2. PREVIEW GUARD EVERYWHERE: the SAME length check runs on every subsequent fetch too (not just
//      the first), so a plan that degrades mid-flight trips the same block immediately. A
//      preview-length body is NEVER cached as fetched-forever content and NEVER ingested — no row
//      is written to earningscalls_transcripts at all (leaving it retryable once the plan is fixed),
//      distinct from the negative-cache (content NULL = "provider says not yet available", a real
//      different semantic the memo warned not to overload).
//
// ── Budget design ───────────────────────────────────────────────────────────────────────────────
// Dual-bound durable ledger (replaces the old fixed 6-requests-per-pass safety invariant, which
// only worked because it capped requests/day low enough that 32 UTC days (a rolling ~31-day
// provider window can span parts of 32 calendar days) could never exceed 200. A single 27-request
// burst day broke that invariant outright, so the ceiling itself is no longer the safety mechanism):
//   - Monthly SOFT budget (UTC calendar month, default 180) — unchanged mechanism.
//   - Rolling 31-day dispatch ledger (default 195, 5 under the hard 200 for drift) — a compact
//     per-UTC-day counter, pruned to the trailing 31 days on every write.
//   - tryReserveEarningsCallsRequests admits min(n, monthly-remaining, rolling-remaining). Both
//     bounds are checked BEFORE every dispatch (reserve-before-call, unchanged discipline) so ANY
//     sequence of daily + burst passes can never jointly exceed either bound, regardless of the
//     per-pass request count. The per-pass ceiling (earningsCallsMaxRequestsPerPass) is now purely
//     an anti-runaway breaker, not a quota-safety invariant.
//
// ── Selection: smart picker (holdings > recency > scan rank > watchlist > manifest tail) ────────
// scoreEarningsCallsCandidates ranks symbols into 5 priority tiers (see its doc comment). The daily
// pass targets EARNINGSCALLS_DAILY_TARGET_TRANSCRIPTS (default 5, ~6 requests including the
// amortized listing call); an armed burst targets up to EARNINGSCALLS_BURST_MAX_TRANSCRIPTS (default
// 25) in one pass, favoring recency, with a small targeted-historical step (GET
// /companies/ticker/{t} full history) for top holdings that have zero cached coverage at all. Every
// id the listing/history/probe steps discover is persisted into earningscalls_event_index
// (db-earningscalls.ts) — a (symbol, fiscal_year, fiscal_quarter) -> eventId map, kept deliberately
// SEPARATE from earningscalls_transcripts' negative-cache semantics (a known id is not a fetch
// outcome). Id-resolution cost trends toward zero over time as this map fills in.
//
// ── Cache + downstream (unchanged) ──────────────────────────────────────────────────────────────
// Transcripts are immutable once published: fetch-once-forever cache keyed (symbol, fiscal_year,
// fiscal_quarter) in earningscalls_transcripts. A content hit NEVER re-fetches; an empty
// (not-yet-available) ANSWERED result is negative-cached for EARNINGSCALLS_NEGATIVE_TTL_DAYS.
// Downstream is the #1586 boundary: vector-db.storeDocument with doc_type "earnings-transcript" and
// source EARNINGSCALLS_TRANSCRIPT_SOURCE. INGEST FLAG DISCIPLINE follows the key (EARNINGSCALLS_
// API_KEY/RAPIDAPI_KEY present = opt-in; EARNINGSCALLS_DISABLED=1 = kill-switch) — see
// earningscalls-gate.ts, unchanged.

import { CircuitOpenError } from "./api-circuit-breaker";
import { fetchWithRetry } from "./data-providers";
import { withSentrySpan } from "./sentry-gen-ai";
import { audit, getDb } from "./db";
import { resolveSourceNumber } from "./source-settings";
import {
  getEarningsCallsSymbolCheck,
  getEarningsCallsTranscript,
  getLatestEarningsCallsEventForSymbol,
  hasAnyEarningsCallsEventForSymbol,
  listUningestedEarningsCallsTranscripts,
  markEarningsCallsTranscriptIngested,
  recordEarningsCallsSymbolCheck,
  upsertEarningsCallsEventIndex,
  upsertEarningsCallsTranscript,
  type EarningsCallsTranscriptRow
} from "./db-earningscalls";
import { listRecentlyHeldSymbolsAllUsers, listRecentlyHeldSymbolValuesAllUsers } from "./db-fills";
import { listUsers, listWatchlistSymbols } from "./db-api-keys";
import { deleteInternalSetting, getInternalSetting, setInternalSetting } from "./db-settings";
import {
  EARNINGSCALLS_TRANSCRIPT_DOC_TYPE,
  EARNINGSCALLS_TRANSCRIPT_SOURCE,
  earningsCallsCredential,
  earningsCallsTranscriptsEnabled
} from "./earningscalls-gate";
import { normalizeSymbol } from "./money";
import {
  assertOperationLeaseOwnership,
  OPERATION_LEASE_GROUPS,
  runWithOperationLease,
  throwIfOperationLeaseCancelled,
  type OperationLeaseAware,
  type OperationLeaseClaim
} from "./operation-lease";
import type { VectorStoreLeaseGuard } from "./vector-db";
import { getTechnicalWatchlist } from "./web-sources/technical";
import { chunkDocument, hashContent } from "./rag/chunk";
import { writesFullBodyToPinecone } from "./rag/pinecone-write-class";
import { persistLocalComplete } from "./rag/persist-local-complete";
import { storeSignalSectionDocuments } from "./rag/processed-corpus-write";
import fs from "fs";
import path from "path";

export const EARNINGSCALLS_BASE = "https://earningscalls.dev/api/v1";
export const EARNINGSCALLS_RAPIDAPI_HOST = "earnings-call-transcripts1.p.rapidapi.com";
export const EARNINGSCALLS_RAPIDAPI_BASE = `https://${EARNINGSCALLS_RAPIDAPI_HOST}/api/v1`;

const BUDGET_SETTING_KEY = "earningscalls_monthly_request_budget";
const ROLLING_LEDGER_KEY = "earningscalls:rollingDispatchLedger";
const PASS_WATERMARK_KEY = "earningscalls:lastPassDay";
const EXHAUSTED_AUDIT_DAY_KEY = "earningscalls:budgetExhaustedAuditDay";
const ENTITLEMENT_STATE_KEY = "earningscalls:entitlementState";
const LISTING_CURSOR_KEY = "earningscalls:recentListingCursor";
const BURST_PENDING_KEY = "earningscalls_burst_pending";
const LAST_PICKS_AUDIT_KEY = "earningscalls:lastPicksAudit";

const DEFAULT_MONTHLY_BUDGET = 180; // headroom under the plan's HARD 200/month
const ROLLING_WINDOW_DAYS = 31;
const DEFAULT_ROLLING_WINDOW_BUDGET = 195; // 5 under the hard 200, for accounting drift
const DEFAULT_RECENT_DAYS = 7;
const DEFAULT_TOP_CANDIDATES = 3;
const DEFAULT_NEGATIVE_TTL_DAYS = 3;
const DEFAULT_DAILY_TARGET_TRANSCRIPTS = 12;
const DEFAULT_BURST_MAX_TRANSCRIPTS = 25;
// Anti-runaway breaker only — see the header comment: the ACTUAL safety bound is the rolling
// ledger dual-bound in tryReserveEarningsCallsRequests, not this number. Sized generously enough
// that a legitimate 25-transcript burst (worst case ~2 requests/transcript: a fallback probe or
// historical resolver plus the fetch itself) is never artificially throttled.
const MAX_SAFE_REQUESTS_PER_PASS = 70;
const DEFAULT_MAX_REQUESTS_PER_PASS = 16;
const REQUEST_TIMEOUT_MS = 20_000;
// Base parser floor: "is there any real text at all" (distinguishes a stub/empty body from real
// content). Deliberately UNCHANGED and UNRELATED to plan-tier detection — see
// EARNINGSCALLS_PREVIEW_GUARD_MIN_CHARS below for the actual anti-preview floor, which sits well
// above this and is what protects the cache from a 250-char preview (recon memo finding #1).
const MIN_TRANSCRIPT_CHARS = 100;
const DEFAULT_PREVIEW_GUARD_MIN_CHARS = 1200;
const MAX_INGEST_RETRIES_PER_PASS = 3;
const MAX_HISTORICAL_BACKFILL_SYMBOLS_PER_BURST = 5;
const DEFAULT_LISTING_PAGE_LIMIT = 100;
// The documented pre-subscription response on the RapidAPI channel — every call 405s until the
// owner completes the free-plan subscription. Excluded from the generic connection-failure alert
// path the same way FMP suppresses its own known plan-restriction statuses.
const PRE_SUBSCRIPTION_STATUS = 405;

function intEnv(raw: string | undefined, fallback: number, min = 0, max = 100_000): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** Settings/env monthly soft request budget. 0 is a valid override (block all calls without
 *  removing the key). Default 180 — deliberate headroom under the provider's hard 200/month. */
export function earningsCallsMonthlyBudget(): number {
  const n = resolveSourceNumber("EARNINGSCALLS_MONTHLY_BUDGET");
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : DEFAULT_MONTHLY_BUDGET;
}

/** Settings/env rolling-31-day request budget (the bound that actually maps to the provider's
 *  hard 200, since its window resets on the subscription anniversary, not the UTC calendar
 *  month). Default 195 — 5 under 200 for accounting drift. */
export function earningsCallsRollingWindowBudget(): number {
  const n = resolveSourceNumber("EARNINGSCALLS_ROLLING_WINDOW_BUDGET");
  if (!Number.isFinite(n)) return DEFAULT_ROLLING_WINDOW_BUDGET;
  return Math.max(0, Math.min(10_000, Math.floor(n)));
}

export function earningsCallsRecentDays(): number {
  return intEnv(process.env.EARNINGSCALLS_RECENT_DAYS, DEFAULT_RECENT_DAYS, 1, 90);
}

export function earningsCallsTopCandidates(): number {
  return intEnv(process.env.EARNINGSCALLS_TOP_CANDIDATES, DEFAULT_TOP_CANDIDATES, 0, 50);
}

export function earningsCallsNegativeTtlDays(): number {
  return intEnv(process.env.EARNINGSCALLS_NEGATIVE_TTL_DAYS, DEFAULT_NEGATIVE_TTL_DAYS, 1, 90);
}

/** How many NEW transcripts an ordinary (non-burst) daily pass targets. Settings override, then env. */
export function earningsCallsDailyTargetTranscripts(): number {
  const n = resolveSourceNumber("EARNINGSCALLS_DAILY_TARGET_TRANSCRIPTS");
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.floor(n))) : DEFAULT_DAILY_TARGET_TRANSCRIPTS;
}

/** Ceiling on a single one-shot burst arm — the coordinator's "burst 25" cap. */
export function earningsCallsBurstMaxTranscripts(): number {
  const n = resolveSourceNumber("EARNINGSCALLS_BURST_MAX_TRANSCRIPTS");
  return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n))) : DEFAULT_BURST_MAX_TRANSCRIPTS;
}

/** Anti-preview cache/ingest floor (recon memo finding #1): a fetched body shorter than this is
 *  treated as a plan-restricted preview, never cached as fetched-forever content, never ingested,
 *  and trips the durable entitlement block. Default 1200 — comfortably above the documented
 *  250-char preview length, env-overridable but never allowed to sink back near 250. */
export function earningsCallsPreviewGuardMinChars(): number {
  return intEnv(process.env.EARNINGSCALLS_PREVIEW_GUARD_MIN_CHARS, DEFAULT_PREVIEW_GUARD_MIN_CHARS, 250, 20_000);
}

/** Anti-runaway per-pass HTTP request ceiling (NOT the quota-safety mechanism — see the header
 *  comment). The env override can only lower it, never raise it past MAX_SAFE_REQUESTS_PER_PASS. */
export function earningsCallsMaxRequestsPerPass(): number {
  return intEnv(
    process.env.EARNINGSCALLS_MAX_REQUESTS_PER_PASS,
    DEFAULT_MAX_REQUESTS_PER_PASS,
    0,
    MAX_SAFE_REQUESTS_PER_PASS
  );
}

/** The effective per-pass request ceiling for a given transcript target: generous enough to cover
 *  a worst-case ~2 requests/transcript (a fallback probe or historical resolver plus the fetch),
 *  never below the configured floor, capped at the anti-runaway ceiling. */
function effectivePassRequestCeiling(targetTranscripts: number): number {
  return Math.max(earningsCallsMaxRequestsPerPass(), Math.min(MAX_SAFE_REQUESTS_PER_PASS, targetTranscripts * 2 + 6));
}

// ── Durable calendar-month (UTC) + rolling-31-day dual-bound request budget ────────────────────

interface PersistedMonthlyBudget {
  monthKey: string; // "YYYY-MM" in UTC
  used: number;
}

interface RollingDispatchLedger {
  /** UTC day ("YYYY-MM-DD") -> requests dispatched that day. Pruned to the trailing
   *  ROLLING_WINDOW_DAYS on every write — stays compact indefinitely. */
  days: Record<string, number>;
}

/** UTC calendar-month key — the provider's stated quota window is monthly. */
export function earningsCallsMonthKey(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function loadPersistedBudget(): PersistedMonthlyBudget {
  try {
    return getInternalSetting<PersistedMonthlyBudget>(BUDGET_SETTING_KEY) ?? { monthKey: "", used: 0 };
  } catch {
    return { monthKey: "", used: 0 };
  }
}

function savePersistedBudget(usage: PersistedMonthlyBudget): void {
  try {
    setInternalSetting(BUDGET_SETTING_KEY, usage);
  } catch {
    // Best-effort — the reservation still holds for this process's lifetime.
  }
}

function loadRollingLedger(): RollingDispatchLedger {
  try {
    return getInternalSetting<RollingDispatchLedger>(ROLLING_LEDGER_KEY) ?? { days: {} };
  } catch {
    return { days: {} };
  }
}

function saveRollingLedger(ledger: RollingDispatchLedger): void {
  try {
    setInternalSetting(ROLLING_LEDGER_KEY, ledger);
  } catch {
    // Best-effort.
  }
}

/** Drop any day outside the trailing ROLLING_WINDOW_DAYS (and any zeroed-out day), keeping the
 *  persisted ledger compact forever. */
function pruneRollingLedger(ledger: RollingDispatchLedger, nowMs: number): RollingDispatchLedger {
  const cutoffMs = nowMs - ROLLING_WINDOW_DAYS * 86_400_000;
  const days: Record<string, number> = {};
  for (const [day, count] of Object.entries(ledger.days)) {
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    if (Number.isFinite(dayMs) && dayMs >= cutoffMs && count > 0) days[day] = count;
  }
  return { days };
}

function rollingLedgerTotal(ledger: RollingDispatchLedger): number {
  return Object.values(ledger.days).reduce((sum, n) => sum + n, 0);
}

/** Remaining admission under the rolling-31-day bound alone (for the admin GET / diagnostics). */
export function remainingEarningsCallsRollingBudget(nowMs: number = Date.now()): number {
  const pruned = pruneRollingLedger(loadRollingLedger(), nowMs);
  return Math.max(0, earningsCallsRollingWindowBudget() - rollingLedgerTotal(pruned));
}

/**
 * Reserve up to `n` requests against BOTH the current UTC month's soft budget AND the rolling
 * 31-day ledger, returning how many were admitted (0..n) — the tighter of the two bounds wins.
 * RESERVE-BEFORE-CALL: callers reserve, then dispatch at most that many HTTP requests.
 * Synchronous read-modify-write on settings rows — better-sqlite3 executes each call atomically
 * w.r.t. any other JS-level reserve, so concurrent reserves cannot jointly exceed either bound.
 * Persisted immediately so a restart mid-month/mid-window can never forget spent requests.
 */
export function tryReserveEarningsCallsRequests(n: number, nowMs: number = Date.now()): number {
  if (n <= 0) return 0;
  const monthlyBudget = earningsCallsMonthlyBudget();
  const rollingBudget = earningsCallsRollingWindowBudget();
  if (monthlyBudget <= 0 || rollingBudget <= 0) return 0;

  const monthKey = earningsCallsMonthKey(nowMs);
  const persistedMonth = loadPersistedBudget();
  const usedMonth = persistedMonth.monthKey === monthKey ? persistedMonth.used : 0;
  const monthlyAdmit = Math.max(0, monthlyBudget - usedMonth);

  const ledger = pruneRollingLedger(loadRollingLedger(), nowMs);
  const usedRolling = rollingLedgerTotal(ledger);
  const rollingAdmit = Math.max(0, rollingBudget - usedRolling);

  const admitted = Math.min(n, monthlyAdmit, rollingAdmit);
  if (admitted <= 0) return 0;

  savePersistedBudget({ monthKey, used: usedMonth + admitted });
  const day = utcDayKey(nowMs);
  ledger.days[day] = (ledger.days[day] ?? 0) + admitted;
  saveRollingLedger(ledger);
  return admitted;
}

/** Return reserved-but-never-dispatched requests (e.g. a circuit-open skip thrown before any
 *  network I/O) against BOTH ledgers. A dispatched call that failed is NOT refunded — it consumed
 *  provider quota. No-op across a month/window rollover for the corresponding ledger. */
export function refundEarningsCallsRequests(n: number, nowMs: number = Date.now()): void {
  if (n <= 0) return;
  const monthKey = earningsCallsMonthKey(nowMs);
  const persistedMonth = loadPersistedBudget();
  if (persistedMonth.monthKey === monthKey) {
    savePersistedBudget({ monthKey, used: Math.max(0, persistedMonth.used - n) });
  }
  const ledger = pruneRollingLedger(loadRollingLedger(), nowMs);
  const day = utcDayKey(nowMs);
  if (ledger.days[day] !== undefined) {
    ledger.days[day] = Math.max(0, ledger.days[day] - n);
    saveRollingLedger(ledger);
  }
}

/** Effective remaining admission — the TIGHTER of the monthly-soft and rolling-31-day bounds, so
 *  every existing caller (which only ever checked "the" remaining budget) automatically gets the
 *  dual-bound-safe answer. */
export function remainingEarningsCallsBudget(nowMs: number = Date.now()): number {
  const monthlyBudget = earningsCallsMonthlyBudget();
  const persistedMonth = loadPersistedBudget();
  const usedMonth = persistedMonth.monthKey === earningsCallsMonthKey(nowMs) ? persistedMonth.used : 0;
  const monthlyRemaining = Math.max(0, monthlyBudget - usedMonth);
  return Math.min(monthlyRemaining, remainingEarningsCallsRollingBudget(nowMs));
}

export interface EarningsCallsBudgetUsage {
  monthKey: string;
  monthlyBudget: number;
  monthlyUsed: number;
  monthlyRemaining: number;
  rollingWindowDays: number;
  rollingBudget: number;
  rollingUsed: number;
  rollingRemaining: number;
}

/** Full dual-bound usage snapshot (admin GET / diagnostics) — the pieces remainingEarningsCallsBudget
 *  collapses into a single number, spelled out for observability. */
export function earningsCallsBudgetUsage(nowMs: number = Date.now()): EarningsCallsBudgetUsage {
  const monthlyBudget = earningsCallsMonthlyBudget();
  const monthKey = earningsCallsMonthKey(nowMs);
  const persistedMonth = loadPersistedBudget();
  const monthlyUsed = persistedMonth.monthKey === monthKey ? persistedMonth.used : 0;
  const rollingBudget = earningsCallsRollingWindowBudget();
  const rollingLedger = pruneRollingLedger(loadRollingLedger(), nowMs);
  const rollingUsed = rollingLedgerTotal(rollingLedger);
  return {
    monthKey,
    monthlyBudget,
    monthlyUsed,
    monthlyRemaining: Math.max(0, monthlyBudget - monthlyUsed),
    rollingWindowDays: ROLLING_WINDOW_DAYS,
    rollingBudget,
    rollingUsed,
    rollingRemaining: Math.max(0, rollingBudget - rollingUsed)
  };
}

/** Quiet-exhaustion discipline: audited at most once per UTC day. */
function auditBudgetExhaustedOncePerDay(nowMs: number, context: Record<string, unknown>): void {
  const day = utcDayKey(nowMs);
  try {
    if (getInternalSetting<string>(EXHAUSTED_AUDIT_DAY_KEY) === day) return;
    setInternalSetting(EXHAUSTED_AUDIT_DAY_KEY, day);
    audit("earningscalls_budget_exhausted", {
      monthKey: earningsCallsMonthKey(nowMs),
      budget: earningsCallsMonthlyBudget(),
      rollingBudget: earningsCallsRollingWindowBudget(),
      ...context
    });
  } catch {
    // Auditing must never break the skip path.
  }
}

// ── Entitlement state (durable — see the header comment for the full risk/guard design) ───────

export type EarningsCallsEntitlementStatus = "unknown" | "confirmed_full" | "preview_blocked";

export interface EarningsCallsEntitlementState {
  status: EarningsCallsEntitlementStatus;
  checkedAt?: string;
  /** Length of the body that triggered the block (undefined when tripped by the /me tier-text
   *  sniff rather than a transcript body). */
  previewLength?: number;
  /** Set once, on the FIRST block — never advanced by a later repeat trip, so callers can tell a
   *  fresh block from a persisting one without a second notification. */
  notifiedAt?: string;
}

function loadEntitlementState(): EarningsCallsEntitlementState {
  try {
    return getInternalSetting<EarningsCallsEntitlementState>(ENTITLEMENT_STATE_KEY) ?? { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

function saveEntitlementState(state: EarningsCallsEntitlementState): void {
  try {
    setInternalSetting(ENTITLEMENT_STATE_KEY, state);
  } catch {
    // Best-effort — worst case a later pass re-derives it from the next fetch.
  }
}

/** Current durable entitlement state (admin GET / diagnostics). */
export function earningsCallsEntitlementState(): EarningsCallsEntitlementState {
  return loadEntitlementState();
}

/** Reset to "unknown" without spending any requests — the next scheduled pass (or a manual
 *  probe-entitlement admin action) re-determines it from scratch. Does NOT itself confirm
 *  anything is fixed; it just re-arms automatic detection. */
export function clearEarningsCallsEntitlementBlock(): EarningsCallsEntitlementState {
  const cleared: EarningsCallsEntitlementState = { status: "unknown" };
  saveEntitlementState(cleared);
  audit("earningscalls_entitlement_block_cleared", {});
  return cleared;
}

function classifyFetchedContent(content: string | undefined): "empty" | "preview" | "full" {
  if (!content) return "empty";
  return content.length < earningsCallsPreviewGuardMinChars() ? "preview" : "full";
}

/** Best-effort tier-text sniff on the /me payload (schema undocumented — "Default Response" only
 *  in openapi.json). A clear paid-tier mention short-circuits false; a free/preview/trial mention
 *  is a signal (not proof) that the transcript-length check below should be treated as expected to
 *  trip. Never the SOLE basis for a block on its own — only the fetched-body length does that. */
function meResponseLooksLimited(payload: unknown): boolean {
  try {
    const text = JSON.stringify(payload).toLowerCase();
    if (/\bultra\b|\bpro\b|\bpaid\b|\benterprise\b/.test(text)) return false;
    return /\bfree\b|\bpreview\b|\btrial\b/.test(text);
  } catch {
    return false;
  }
}

/**
 * Trip the durable entitlement block (idempotent — repeat trips update the length/timestamp but
 * notify only ONCE, per the coordinator's no-retry-storm requirement). Best-effort operator
 * notification via the existing notify machinery. Delivery honors the user's real enabledEvents
 * toggle (owner ruling 2026-08-12, "ALL toggles must be real" — no force-include). A legacy
 * stored enabledEvents array predating this event type was backfilled once by migration 78
 * (db.ts); after that the toggle is genuinely the user's.
 */
async function tripEntitlementBlock(nowMs: number, previewLength: number | undefined, context: Record<string, unknown>): Promise<void> {
  const existing = loadEntitlementState();
  const alreadyBlocked = existing.status === "preview_blocked";
  const nowIso = new Date(nowMs).toISOString();
  saveEntitlementState({
    status: "preview_blocked",
    checkedAt: nowIso,
    previewLength,
    notifiedAt: alreadyBlocked ? existing.notifiedAt : nowIso
  });
  try {
    audit("earningscalls_entitlement_blocked", { previewLength, ...context });
  } catch {
    // Best-effort.
  }
  if (alreadyBlocked) return; // already notified once — no retry storm
  try {
    const { getPolicy } = await import("./db");
    const { sendNotification } = await import("./notifications");
    const policy = getPolicy("local");
    const title = "EarningsCalls program paused: plan returns previews, not full transcripts";
    const lengthNote = previewLength !== undefined ? ` (observed body length: ${previewLength} chars)` : "";
    const body =
      `EarningsCalls.dev is returning short transcript previews instead of full text${lengthNote}. ` +
      "The burst/daily transcript program has been paused so no stub content is permanently cached. " +
      'Upgrade the plan for full-text access, then POST /api/admin/earningscalls {"action":"clear-entitlement-block"} ' +
      '(or {"action":"probe-entitlement"} to re-verify immediately).';
    await sendNotification(
      { type: "earningscalls_entitlement_blocked", title, payload: { previewLength, ...context } },
      { userId: "local", policy, directBody: body }
    );
  } catch {
    // Best-effort — the persisted block + audit row are the durable record either way.
  }
}

// ── Burst arming (one-shot settings counter) ────────────────────────────────────────────────────

/** Arm a one-shot burst: the NEXT daily pass (scheduled or admin-triggered) consumes up to this
 *  many transcripts, then the flag clears itself. Clamped to [0, earningsCallsBurstMaxTranscripts()].
 *  Idempotent consume happens inside the pass BEFORE any work starts (see runEarningsCallsPass), so
 *  a crash mid-burst can never re-arm and repeat it on the next tick. */
export function armEarningsCallsBurst(maxTranscripts: number = earningsCallsBurstMaxTranscripts()): number {
  const clamped = Math.max(0, Math.min(Math.round(maxTranscripts), earningsCallsBurstMaxTranscripts()));
  setInternalSetting(BURST_PENDING_KEY, clamped);
  audit("earningscalls_burst_armed", { maxTranscripts: clamped });
  return clamped;
}

export function earningsCallsBurstPending(): number {
  try {
    return getInternalSetting<number>(BURST_PENDING_KEY) ?? 0;
  } catch {
    return 0;
  }
}

// ── Test seams (exported ONLY for test/earningscalls-transcripts.test.ts isolation) ────────────

/** Directly set the durable entitlement state, bypassing the probe flow — lets tests exercise
 *  "already confirmed_full" (skip the /me step) or "already preview_blocked" (refuse everything)
 *  without dispatching real requests to get there. */
export function setEarningsCallsEntitlementStateForTest(state: EarningsCallsEntitlementState): void {
  saveEntitlementState(state);
}

/** Reset every piece of cross-test persistent state this module owns (entitlement, burst
 *  arming, listing cursor) back to a clean slate — call at the top of a test that needs
 *  isolation from whatever an earlier test in the same shared temp DB left behind. */
export function resetEarningsCallsStateForTest(): void {
  saveEntitlementState({ status: "unknown" });
  try {
    setInternalSetting(BURST_PENDING_KEY, 0);
  } catch {
    // Best-effort.
  }
  try {
    deleteInternalSetting(LISTING_CURSOR_KEY);
  } catch {
    // Best-effort.
  }
  try {
    deleteInternalSetting(BUDGET_SETTING_KEY);
  } catch {
    // Best-effort.
  }
  try {
    deleteInternalSetting(ROLLING_LEDGER_KEY);
  } catch {
    // Best-effort.
  }
}

/** Idempotent one-shot consume: clears the pending counter BEFORE the pass does any work, so a
 *  crash mid-burst cannot re-arm and re-run the same burst on a later tick. */
function consumeEarningsCallsBurstPending(): number {
  const pending = earningsCallsBurstPending();
  if (pending > 0) setInternalSetting(BURST_PENDING_KEY, 0);
  return pending;
}

// ── Response parsers (shape-tolerant; fixtures in test/earningscalls-transcripts.test.ts) ──

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Unwrap the optional top-level `data` envelope (object or single-element array). */
function unwrapData(payload: unknown): Record<string, unknown> | undefined {
  const record = asRecord(payload);
  if (!record) return asRecord(Array.isArray(payload) ? payload[0] : undefined);
  if ("data" in record) {
    const data = record.data;
    if (Array.isArray(data)) return asRecord(data[0]);
    const inner = asRecord(data);
    if (inner) return inner;
  }
  return record;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export interface EarningsCallsLatestCall {
  eventId: number;
  eventDate?: string;
  fiscalYear?: number;
  fiscalQuarter?: number;
  ticker?: string;
}

/** Parse /companies/ticker/{ticker}/latest. Returns undefined when no usable call id exists. */
export function parseEarningsCallsLatestCall(payload: unknown): EarningsCallsLatestCall | undefined {
  const record = unwrapData(payload);
  if (!record) return undefined;
  // Some shapes nest the call under `latest_call` / `earnings_call` / `call`.
  const call = asRecord(record.latest_call) ?? asRecord(record.earnings_call) ?? asRecord(record.call) ?? record;
  const eventId = firstNumber(call, ["earnings_call_id", "earningsId", "earnings_id", "id"]);
  if (eventId === undefined || eventId <= 0 || !Number.isInteger(eventId)) return undefined;
  return {
    eventId,
    eventDate: firstString(call, ["event_date_time", "event_date", "date", "event_datetime"]),
    fiscalYear: firstNumber(call, ["fiscal_year", "year"]),
    fiscalQuarter: firstNumber(call, ["fiscal_quarter", "quarter"]),
    ticker: firstString(call, ["ticker", "company_ticker", "symbol"])
  };
}

interface SpeakerSegment {
  speakerName?: string;
  speakerType?: string;
  text: string;
  order: number;
}

function parseSpeakerSegments(value: unknown): SpeakerSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: SpeakerSegment[] = [];
  for (const [index, entry] of value.entries()) {
    const record = asRecord(entry);
    if (!record) continue;
    const text = firstString(record, ["text_content", "text", "content"]);
    if (!text) continue;
    segments.push({
      speakerName: firstString(record, ["speaker_name", "speaker"]),
      speakerType: firstString(record, ["speaker_type", "role"]),
      text,
      order: firstNumber(record, ["component_order", "order", "sequence"]) ?? index
    });
  }
  return segments.sort((a, b) => a.order - b.order);
}

/**
 * Parse /transcripts/{earningsId}?format=full into plain transcript text. Prefers the flat
 * full-text field; falls back to joining speaker segments as "Name (type): text" lines. Returns
 * undefined when there's no real text at all (MIN_TRANSCRIPT_CHARS=100 floor — a stub is
 * negative-cache material). This is NOT the anti-preview check: a 250-char preview PASSES this
 * floor by design and is caught separately by classifyFetchedContent/earningsCallsPreviewGuardMinChars
 * before anything gets cached or ingested (see the header comment).
 */
export function parseEarningsCallsTranscript(payload: unknown): string | undefined {
  const record = unwrapData(payload);
  if (!record) return undefined;
  const flat = firstString(record, ["full_text", "transcript", "text", "content"]);
  if (flat && flat.length >= MIN_TRANSCRIPT_CHARS) return flat;
  const segments = parseSpeakerSegments(record.speakers ?? record.components ?? record.segments);
  if (segments.length > 0) {
    const joined = segments
      .map((segment) => {
        const speaker = segment.speakerName
          ? segment.speakerType
            ? `${segment.speakerName} (${segment.speakerType})`
            : segment.speakerName
          : segment.speakerType ?? "Speaker";
        return `${speaker}: ${segment.text}`;
      })
      .join("\n\n");
    if (joined.length >= MIN_TRANSCRIPT_CHARS) return joined;
  }
  return undefined;
}

export interface EarningsCallsListingItem {
  eventId: number;
  eventDate?: string;
  fiscalYear?: number;
  fiscalQuarter?: number;
  ticker?: string;
}

export interface EarningsCallsListingPage {
  items: EarningsCallsListingItem[];
  /** Cursor for the next page (GET /transcripts/recent's `next_after_id`). Absent on the
   *  /companies/ticker/{t} full-history shape, which has no pagination. */
  nextAfterId?: number;
}

const LIST_ARRAY_KEYS = ["data", "items", "results", "calls", "earnings_calls", "transcripts"] as const;

function extractListItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of LIST_ARRAY_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    const nested = asRecord(value);
    if (nested) {
      for (const nestedKey of LIST_ARRAY_KEYS) {
        const nestedValue = nested[nestedKey];
        if (Array.isArray(nestedValue)) return nestedValue;
      }
    }
  }
  return [];
}

function parseListingItem(entry: unknown): EarningsCallsListingItem | undefined {
  const record = asRecord(entry);
  if (!record) return undefined;
  const eventId = firstNumber(record, ["earnings_call_id", "earningsId", "earnings_id", "id"]);
  if (eventId === undefined || eventId <= 0 || !Number.isInteger(eventId)) return undefined;
  return {
    eventId,
    eventDate: firstString(record, ["event_date_time", "event_date", "date", "event_datetime"]),
    fiscalYear: firstNumber(record, ["fiscal_year", "year"]),
    fiscalQuarter: firstNumber(record, ["fiscal_quarter", "quarter"]),
    ticker: firstString(record, ["ticker", "company_ticker", "symbol"])
  };
}

function extractNextAfterId(payload: unknown): number | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  const direct = firstNumber(record, ["next_after_id", "nextAfterId", "after_id", "cursor"]);
  if (direct !== undefined) return direct;
  const data = asRecord(record.data);
  return data ? firstNumber(data, ["next_after_id", "nextAfterId", "after_id", "cursor"]) : undefined;
}

/** Parse GET /transcripts/recent (cursor listing, all tickers) or GET /companies/ticker/{t} (full
 *  call history, one ticker) into a flat, shape-tolerant item list plus the next-page cursor when
 *  present (listing only). Both endpoints' response schemas are undocumented in openapi.json
 *  ("Default Response") — kept tolerant of bare arrays, `data`-envelopes, and named array keys. */
export function parseEarningsCallsListingPage(payload: unknown): EarningsCallsListingPage {
  const items = extractListItems(payload)
    .map(parseListingItem)
    .filter((item): item is EarningsCallsListingItem => item !== undefined);
  return { items, nextAfterId: extractNextAfterId(payload) };
}

// ── HTTP (reserve-before-call; every dispatch is one budget unit) ───────────────

export type EarningsCallsHttpResult =
  | { ok: true; payload: unknown }
  | { ok: false; kind: "budget" | "circuit" | "auth" | "not_found" | "rate_limited" | "transient" | "not_subscribed" };

async function earningsCallsGet(path: string, nowMs: number): Promise<EarningsCallsHttpResult> {
  const credential = earningsCallsCredential();
  if (!credential) return { ok: false, kind: "auth" };
  const apiKey = credential.key;
  const base = credential.channel === "rapidapi" ? EARNINGSCALLS_RAPIDAPI_BASE : EARNINGSCALLS_BASE;
  const headers: Record<string, string> =
    credential.channel === "rapidapi"
      ? { "x-rapidapi-key": apiKey, "x-rapidapi-host": EARNINGSCALLS_RAPIDAPI_HOST, Accept: "application/json" }
      : { "X-API-Key": apiKey, Accept: "application/json" };
  if (tryReserveEarningsCallsRequests(1, nowMs) < 1) return { ok: false, kind: "budget" };
  let response: Response;
  try {
    response = await withSentrySpan(
      "earningscalls.get",
      "gen_ai.chat",
      () =>
        fetchWithRetry(
          `${base}${path}`,
          {
            headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          },
          {
            // retries: 0 is load-bearing — one reservation must never become two provider-side
            // requests.
            retries: 0,
            service: "earningscalls",
            apiKey,
            keySource: "env",
            suppressHealthStatuses: [PRE_SUBSCRIPTION_STATUS]
          }
        ),
      { "gen_ai.system": "earningscalls", "gen_ai.operation.name": "transcript" }
    );
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      refundEarningsCallsRequests(1, nowMs);
      return { ok: false, kind: "circuit" };
    }
    return { ok: false, kind: "transient" };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, kind: "auth" };
  if (response.status === 404) return { ok: false, kind: "not_found" };
  if (response.status === 402 || response.status === 429) return { ok: false, kind: "rate_limited" };
  if (response.status === PRE_SUBSCRIPTION_STATUS) return { ok: false, kind: "not_subscribed" };
  if (!response.ok) return { ok: false, kind: "transient" };
  try {
    return { ok: true, payload: await response.json() };
  } catch {
    return { ok: false, kind: "transient" };
  }
}

// ── Cadence ─────────────────────────────────────────────────────────────────────

/** Once per UTC day, mirroring economic-calendar.ts's persisted watermark. Deliberately NOT
 *  entitlement-aware: a blocked state still runs the pass body once/day so result.entitlementBlocked
 *  stays inspectable (admin GET, tests) instead of silently freezing at whatever day the block
 *  happened — the actual refusal-of-work lives inside runEarningsCallsPass. */
export function isEarningsCallsRefreshDue(nowMs: number = Date.now()): boolean {
  if (!earningsCallsTranscriptsEnabled()) return false;
  const day = utcDayKey(nowMs);
  return getInternalSetting<string>(PASS_WATERMARK_KEY) !== day;
}

// ── Downstream ingest (the #1586 storeDocument boundary) ───────────────────────

export function accessionFor(row: { symbol: string; fiscalYear: number; fiscalQuarter: number }): string {
  return `earningscalls:${normalizeSymbol(row.symbol)}:${row.fiscalYear}Q${row.fiscalQuarter}`;
}

/** Map a speaker / section label to the ROIC-compatible role codes selectSignalChunks expects. */
function roleOfEarningsCallsLabel(label: string): string {
  const s = label.toLowerCase().trim();
  if (!s) return "qa";
  if (/\boperator\b/.test(s)) return "operator";
  if (/\b(q\s*&\s*a|questions?\s*(?:and|&)\s*answers?)\b/.test(s)) return "qa";
  if (/\banalyst\b/.test(s) && !/\b(ceo|cfo|coo|officer|president)\b/.test(s)) return "analyst";
  if (/\b(ceo|cfo|coo|cto|chief|officer|president|director|management|prepared)\b/.test(s)) {
    return "management";
  }
  return "qa";
}

/**
 * Split a cached EarningsCalls body into management + Q&A role sections for signal writes.
 * Prefers `Speaker:` / Operator / Analyst / Q&A markers when present; otherwise first half
 * is management remarks and the rest is Q&A (pinned by tests).
 */
export function earningsCallsSpeakerSections(
  content: string
): Array<{ itemCode: string; itemTitle: string; text: string }> {
  const trimmed = String(content ?? "").trim();
  if (!trimmed) return [];

  const turnRe = /^([A-Za-z][^\n:]{0,78}):\s*([\s\S]*)$/;
  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const turns: Array<{ label: string; text: string }> = [];
  let labeled = 0;
  for (const para of paragraphs) {
    const match = para.match(turnRe);
    if (match) {
      labeled += 1;
      turns.push({ label: match[1]!.trim(), text: match[2]!.trim() });
    } else if (turns.length > 0) {
      turns[turns.length - 1]!.text += `\n\n${para}`;
    } else {
      turns.push({ label: "Management", text: para });
    }
  }

  if (labeled >= 2) {
    return turns
      .filter((turn) => turn.text.trim().length > 0)
      .map((turn) => ({
        itemCode: roleOfEarningsCallsLabel(turn.label),
        itemTitle: turn.label,
        text: turn.text
      }));
  }

  const qaHeaderRe = /\n(?:Questions?(?:\s+and\s+|&\s*)Answers?|Q\s*&\s*A)\s*\n/i;
  const qaParts = trimmed.split(qaHeaderRe);
  if (qaParts.length >= 2) {
    const management = qaParts[0]!.trim();
    const qa = qaParts.slice(1).join("\n\n").trim();
    const out: Array<{ itemCode: string; itemTitle: string; text: string }> = [];
    if (management) out.push({ itemCode: "management", itemTitle: "Management remarks", text: management });
    if (qa) out.push({ itemCode: "qa", itemTitle: "Q&A", text: qa });
    if (out.length > 0) return out;
  }

  const mid = Math.floor(trimmed.length / 2);
  let splitAt = trimmed.indexOf("\n\n", mid);
  if (splitAt < 0) splitAt = mid;
  const first = trimmed.slice(0, splitAt).trim();
  const rest = trimmed.slice(splitAt).trim();
  const fallback: Array<{ itemCode: string; itemTitle: string; text: string }> = [];
  if (first) fallback.push({ itemCode: "management", itemTitle: "Management remarks", text: first });
  if (rest) fallback.push({ itemCode: "qa", itemTitle: "Q&A", text: rest });
  return fallback.length > 0
    ? fallback
    : [{ itemCode: "management", itemTitle: "Management remarks", text: trimmed }];
}

function recordIngestedLedgerRow(accession: string, ticker: string, chunkCount: number, indexedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(accession, doc_type) DO UPDATE SET
         ticker = excluded.ticker,
         indexed_at = excluded.indexed_at,
         chunk_count = excluded.chunk_count`
    )
    .run(accession, EARNINGSCALLS_TRANSCRIPT_DOC_TYPE, ticker, indexedAt, chunkCount);
}

async function ingestCachedTranscript(
  row: EarningsCallsTranscriptRow,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<boolean> {
  if (!row.content) return false;
  const accession = accessionFor(row);
  const title = `${row.symbol} earnings call ${row.fiscalYear} Q${row.fiscalQuarter}`;
  const publishedAt = row.eventDate ?? row.fetchedAt;
  const url = row.eventId
    ? `${EARNINGSCALLS_BASE}/transcripts/${row.eventId}`
    : `${EARNINGSCALLS_BASE}/search/by_ticker`;
  const sections = earningsCallsSpeakerSections(row.content);
  const writeFullBody = writesFullBodyToPinecone();
  const { storeDocument } = await import("./vector-db");
  let attempted = 0;
  if (writeFullBody) {
    const stored = await storeDocument(
      {
        text: row.content,
        doc_id: accession,
        ticker: row.symbol,
        title,
        doc_type: EARNINGSCALLS_TRANSCRIPT_DOC_TYPE,
        published_at: publishedAt,
        acceptance_datetime: row.fetchedAt,
        source: EARNINGSCALLS_TRANSCRIPT_SOURCE,
        url,
        sections
      },
      "local",
      { parserRevision: "earningscalls-transcript-v1", documentKey: accession, leaseGuard }
    );
    const reusedCommitted =
      stored.reusedCommitted === true && stored.documentComplete === true && stored.attempted > 0;
    const complete = !stored.error && !stored.unconfigured &&
      stored.documentComplete === true &&
      (reusedCommitted || stored.indexed === stored.attempted);
    if (!complete) return false;
    attempted = stored.attempted;
  }
  // Non-full-body write-class: row.content stays in earningscalls_transcripts (local).
  // Do not dump the full transcript into Pinecone.  Default write-class is still
  // full-body, so this branch is inert until the post-PR-B Infisical flip.
  const at = new Date().toISOString();
  recordIngestedLedgerRow(accession, normalizeSymbol(row.symbol), attempted, at);
  markEarningsCallsTranscriptIngested(row.symbol, row.fiscalYear, row.fiscalQuarter, at);

  // Compact earnings-summary for LLM trade use (full earnings-transcript stays in the corpus).
  try {
    const { generateAndStoreDocumentAbstract, tradeHighlightChunksFromText } = await import(
      "./rag/document-summarizer"
    );
    await generateAndStoreDocumentAbstract({
      ticker: row.symbol,
      accessionOrEventId: accession,
      sourceType: "earnings-summary",
      headline: `${row.symbol} earnings call highlights ${row.fiscalYear} Q${row.fiscalQuarter}`,
      chunks: tradeHighlightChunksFromText(row.content, {
        maxChunks: 8,
        formHint: "earnings",
        sections
      }),
      publishedAt,
      acceptanceDatetime: row.fetchedAt
    });
  } catch (err) {
    console.warn(
      `[earningscalls] abstract failed for ${accession}:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  // Keep-set extras: management + first 8 Q&A turns as complete storeDocuments (ROIC mirror).
  const signalChunks = chunkDocument(
    {
      doc_id: `${accession}:signal`,
      title,
      doc_type: EARNINGSCALLS_TRANSCRIPT_DOC_TYPE,
      source: EARNINGSCALLS_TRANSCRIPT_SOURCE,
      text: row.content,
      ticker: row.symbol,
      published_at: publishedAt,
      acceptance_datetime: row.fetchedAt,
      url,
      sections
    },
    {}
  );
  try {
    await storeSignalSectionDocuments(
      {
        ticker: row.symbol,
        accession,
        form: "earnings-transcript",
        title,
        publishedAt,
        acceptanceDatetime: row.fetchedAt,
        source: EARNINGSCALLS_TRANSCRIPT_SOURCE,
        url,
        chunks: signalChunks,
        userId: "local",
        ...(leaseGuard ? { leaseGuard } : {})
      },
      storeDocument
    );
  } catch (err) {
    console.warn(
      `[earningscalls] signal sections failed for ${accession}:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  // Local FTS so hydrate can recover without dumping the full call into Pinecone.
  // recordLedger false: ingest already wrote ingested_accessions above.
  try {
    await persistLocalComplete({
      ticker: row.symbol,
      accession,
      docType: EARNINGSCALLS_TRANSCRIPT_DOC_TYPE,
      source: EARNINGSCALLS_TRANSCRIPT_SOURCE,
      chunks: signalChunks.map((chunk) => ({
        content_hash: chunk.content_hash || hashContent(chunk.text),
        text: chunk.text
      })),
      recordLedger: false
    });
  } catch (err) {
    console.warn(
      `[earningscalls] local FTS persist failed for ${accession}:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  return true;
}

/** UTC-safe event-date parse. A timezone-less date-time string parses as LOCAL time per
 *  ECMA-262, which would skew the recency window and the calendar (year, quarter) cache-key
 *  fallback by the host's UTC offset near boundaries. */
function parseEventDateUtcMs(eventDate: string): number {
  const trimmed = eventDate.trim();
  if (!trimmed.includes("T") && !trimmed.includes(" ")) return Date.parse(`${trimmed}T00:00:00Z`);
  const isoish = trimmed.replace(" ", "T");
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(isoish);
  return Date.parse(hasExplicitOffset ? isoish : `${isoish}Z`);
}

function withinRecentWindow(eventDate: string | undefined, nowMs: number): boolean {
  if (!eventDate) return false;
  const parsed = parseEventDateUtcMs(eventDate);
  if (!Number.isFinite(parsed)) return false;
  const age = nowMs - parsed;
  return age >= -86_400_000 && age <= earningsCallsRecentDays() * 86_400_000;
}

function calendarPeriodFor(eventDate: string | undefined, nowMs: number): { year: number; quarter: number } {
  const parsed = eventDate ? parseEventDateUtcMs(eventDate) : Number.NaN;
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date(nowMs);
  return { year: date.getUTCFullYear(), quarter: Math.floor(date.getUTCMonth() / 3) + 1 };
}

/** Test-only view of the calendar-period fallback (UTC-parse regression coverage). */
export const calendarPeriodForTest = calendarPeriodFor;

// ── Smart picker (holdings > earnings recency > scan rank > watchlist > manifest tail) ────────

export type EarningsCallsCandidateTier = 1 | 2 | 3 | 4 | 5;

export interface EarningsCallsScoredCandidate {
  symbol: string;
  tier: EarningsCallsCandidateTier;
  tierLabel: "holdings" | "earnings-recency" | "scan-rank" | "watchlist" | "manifest-tail";
  /** Higher = better, comparable only WITHIN the same tier (tiers are strictly ordered first). */
  score: number;
  rationale: string;
}

export interface EarningsCallsCandidateInputs {
  /** symbol -> summed |position value| across every connected account (tier 1). */
  holdingsValue: Map<string, number>;
  /** Injected earnings-calendar membership within the recency window — boolean recency signal (tier 2). */
  recentlyReportedSymbols?: Set<string>;
  /** symbol -> most recent known event_date (from the event index / listing engine) — finer
   *  recency ordering within tier 2 when available. */
  recentEventDates?: Map<string, string>;
  /** The latest technical scan's candidate set, already rank-ordered (index 0 = best) (tier 3). */
  scanCandidates: string[];
  /** Union of every user's personal watchlist (tier 4). */
  watchlistSymbols: string[];
  /** symbol -> frozen universe manifest rank (ascending = better) (tier 5, tail-fill only). */
  manifestRank: Map<string, number>;
}

/**
 * Priority-order candidate symbols into 5 tiers (owner-specified, locked): current holdings
 * (weighted by |position value|, largest first) > earnings recency (most-recently-reported first)
 * > latest scan's candidate rank > any user's watchlist > frozen universe manifest rank (tail-fill
 * only, used when nothing else fills the pass's target). A symbol appears exactly once, at its
 * BEST (lowest-numbered) tier — pure and side-effect-free so it's independently unit-testable.
 */
export function scoreEarningsCallsCandidates(inputs: EarningsCallsCandidateInputs): EarningsCallsScoredCandidate[] {
  const seen = new Set<string>();
  const out: EarningsCallsScoredCandidate[] = [];

  const holdings = [...inputs.holdingsValue.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [symbol, value] of holdings) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      tier: 1,
      tierLabel: "holdings",
      score: value,
      rationale: `Held position worth ~$${Math.round(value).toLocaleString("en-US")} across connected accounts.`
    });
  }

  const recencySet = new Set<string>([
    ...(inputs.recentlyReportedSymbols ?? []),
    ...(inputs.recentEventDates?.keys() ?? [])
  ]);
  const recencyList = [...recencySet].filter((symbol) => !seen.has(symbol));
  recencyList.sort((a, b) => {
    const dateA = inputs.recentEventDates?.get(a);
    const dateB = inputs.recentEventDates?.get(b);
    if (dateA && dateB) return Date.parse(dateB) - Date.parse(dateA);
    if (dateA) return -1;
    if (dateB) return 1;
    return a.localeCompare(b);
  });
  for (const symbol of recencyList) {
    seen.add(symbol);
    const date = inputs.recentEventDates?.get(symbol);
    out.push({
      symbol,
      tier: 2,
      tierLabel: "earnings-recency",
      score: date ? Date.parse(date) : 0,
      rationale: date
        ? `Reported earnings ${date} (within the recency window).`
        : "Reported earnings within the recency window (earnings calendar)."
    });
  }

  inputs.scanCandidates.forEach((symbol, index) => {
    if (seen.has(symbol)) return;
    seen.add(symbol);
    out.push({
      symbol,
      tier: 3,
      tierLabel: "scan-rank",
      score: -index,
      rationale: `Rank #${index + 1} in the latest technical scan's candidate set.`
    });
  });

  for (const symbol of inputs.watchlistSymbols) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, tier: 4, tierLabel: "watchlist", score: 0, rationale: "On a user's watchlist." });
  }

  const manifestEntries = [...inputs.manifestRank.entries()]
    .filter(([symbol]) => !seen.has(symbol))
    .sort((a, b) => a[1] - b[1]);
  for (const [symbol, rank] of manifestEntries) {
    seen.add(symbol);
    out.push({
      symbol,
      tier: 5,
      tierLabel: "manifest-tail",
      score: -rank,
      rationale: `Universe manifest rank #${rank} (tail-fill).`
    });
  }

  return out;
}

/** Lenient, best-effort read of data/rag-universe-manifest.json's ticker ranks for the scorer's
 *  tail-fill tier. Missing/corrupt manifest is non-fatal — that tier is simply empty. Deliberately
 *  NOT using rag/universe-manifest.ts's stricter validateSecUniverseManifest: this is a low-priority
 *  tail-fill signal, not a correctness-critical ingestion boundary. */
function loadManifestRank(manifestPath: string = path.resolve("data/rag-universe-manifest.json")): Map<string, number> {
  const rank = new Map<string, number>();
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { issuers?: Array<{ ticker?: unknown; rank?: unknown }> };
    for (const issuer of parsed.issuers ?? []) {
      const ticker = typeof issuer.ticker === "string" ? normalizeSymbol(issuer.ticker) : "";
      const r = typeof issuer.rank === "number" ? issuer.rank : undefined;
      if (ticker && r !== undefined && !rank.has(ticker)) rank.set(ticker, r);
    }
  } catch {
    // Non-fatal.
  }
  return rank;
}

function allWatchlistSymbols(): string[] {
  const symbols = new Set<string>();
  for (const userId of listUsers()) {
    try {
      for (const item of listWatchlistSymbols(userId)) {
        const symbol = normalizeSymbol(item.symbol);
        if (symbol) symbols.add(symbol);
      }
    } catch {
      // A single user's DB error must not block the others.
    }
  }
  return [...symbols];
}

// ── Picks audit (persisted per-pass — admin GET reads this) ────────────────────────────────────

export type EarningsCallsPickAction =
  | "fetched"
  | "already_cached"
  | "resolved_no_content_yet"
  | "preview_blocked"
  | "skipped_negative_ttl"
  | "skipped_no_id"
  | "skipped_not_recent"
  | "skipped_out_of_budget";

export interface EarningsCallsPickAuditEntry {
  symbol: string;
  tier: EarningsCallsCandidateTier;
  tierLabel: string;
  rationale: string;
  action: EarningsCallsPickAction;
  fiscalYear?: number;
  fiscalQuarter?: number;
}

export interface EarningsCallsPicksAudit {
  day: string;
  isBurst: boolean;
  targetTranscripts: number;
  requests: number;
  fetched: number;
  picks: EarningsCallsPickAuditEntry[];
  recordedAt: string;
}

function saveLastPicksAudit(picksAudit: EarningsCallsPicksAudit): void {
  try {
    setInternalSetting(LAST_PICKS_AUDIT_KEY, picksAudit);
  } catch {
    // Best-effort — the per-pick audit() rows below are the durable fallback record.
  }
}

/** Most recent pass's scored picks + one-line rationale (admin GET). */
export function earningsCallsLastPicksAudit(): EarningsCallsPicksAudit | undefined {
  try {
    return getInternalSetting<EarningsCallsPicksAudit>(LAST_PICKS_AUDIT_KEY);
  } catch {
    return undefined;
  }
}

// ── Selection + refresh pass ───────────────────────────────────────────────────

export interface EarningsCallsRefreshResult {
  enabled: boolean;
  due: boolean;
  /** HTTP requests dispatched (== budget spent, minus circuit refunds). */
  requests: number;
  probed: number;
  fetched: number;
  ingested: number;
  skippedBudget: number;
  errors: string[];
  /** True when this pass refused to do any provider work because the entitlement state is
   *  preview_blocked, OR tripped that block mid-pass (some fetch happened before the trip). */
  entitlementBlocked?: boolean;
  isBurst?: boolean;
}

export interface EarningsCallsRefreshDeps {
  http?: (path: string, nowMs: number) => Promise<EarningsCallsHttpResult>;
  heldSymbols?: () => string[];
  /** symbol -> summed |position value| across accounts, for the scorer's holdings tier. Defaults
   *  to listRecentlyHeldSymbolValuesAllUsers. */
  heldSymbolValues?: () => Map<string, number>;
  candidateSymbols?: () => string[];
  recentlyReported?: () => Promise<Set<string> | undefined>;
  watchlistSymbols?: () => string[];
  manifestRank?: () => Map<string, number>;
  ingest?: (row: EarningsCallsTranscriptRow) => Promise<boolean>;
  force?: boolean;
  /** force-mode override for the burst target (bypasses the one-shot settings counter — test
   *  seam / admin manual trigger). */
  burstTranscripts?: number;
}

/** Once per UTC day. Dormant (zero calls, zero writes) without EARNINGSCALLS_API_KEY/RAPIDAPI_KEY
 *  or with EARNINGSCALLS_DISABLED=1. Self-guarded (a pass failure becomes an errors entry, never a
 *  throw); a lost RAG_REINDEX lease ownership at the success boundary is the one condition allowed
 *  to propagate — the scheduler's catch handles it. */
export async function refreshEarningsCallsTranscriptsIfDue(
  nowMs: number = Date.now(),
  deps: EarningsCallsRefreshDeps = {}
): Promise<OperationLeaseAware<EarningsCallsRefreshResult>> {
  const result: EarningsCallsRefreshResult = {
    enabled: false,
    due: false,
    requests: 0,
    probed: 0,
    fetched: 0,
    ingested: 0,
    skippedBudget: 0,
    errors: []
  };
  if (!earningsCallsTranscriptsEnabled()) return result;
  result.enabled = true;
  if (!deps.force && !isEarningsCallsRefreshDue(nowMs)) return result;
  result.due = true;

  const guarded = await runWithOperationLease(
    { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "scheduled-earningscalls-transcripts" },
    async (claim, signal) => runEarningsCallsPass(nowMs, deps, result, claim, signal)
  );
  if (!guarded.acquired) return { ...result, operationLease: guarded.busy };
  return result;
}

type EarningsCallsDispatchOutcome = EarningsCallsHttpResult | { ok: false; kind: "ceiling" };

/** Shared reserve+dispatch+account+audit wrapper used by every call site (the /me probe, the
 *  daily listing call, per-symbol fallback probes, transcript fetches, and the burst's
 *  company-history resolver) — one place to keep the request-ceiling check, budget-exhaustion
 *  audit, and per-call audit row consistent. */
async function dispatchEarningsCallsRequest(
  http: (path: string, nowMs: number) => Promise<EarningsCallsHttpResult>,
  requestPath: string,
  nowMs: number,
  result: EarningsCallsRefreshResult,
  requestCeiling: number,
  auditKind: string,
  auditExtra: Record<string, unknown> = {}
): Promise<EarningsCallsDispatchOutcome> {
  if (result.requests >= requestCeiling) return { ok: false, kind: "ceiling" };
  if (remainingEarningsCallsBudget(nowMs) <= 0) {
    result.skippedBudget += 1;
    auditBudgetExhaustedOncePerDay(nowMs, { at: auditKind, ...auditExtra });
    return { ok: false, kind: "budget" };
  }
  const response = await http(requestPath, nowMs);
  if (!response.ok && response.kind === "budget") {
    result.skippedBudget += 1;
    auditBudgetExhaustedOncePerDay(nowMs, { at: auditKind, ...auditExtra });
    return response;
  }
  if (!response.ok && response.kind === "circuit") return response; // refunded internally
  result.requests += 1;
  try {
    audit("earningscalls_request", { kind: auditKind, remainingBudget: remainingEarningsCallsBudget(nowMs), ...auditExtra });
  } catch {
    // Best-effort.
  }
  return response;
}

/** Amortized id-resolution engine: GET /transcripts/recent, cursor-paginated via the persisted
 *  next_after_id watermark (crash-safe: the cursor is a settings row, so a restart resumes exactly
 *  where the last successful page left off — no re-scan, no gap). Persists EVERY discovered id
 *  into the event index regardless of whether today's candidates need it, so id-resolution cost
 *  trends toward zero over time. Returns true if it dispatched (successfully or not); false if it
 *  skipped (ceiling/budget already exhausted before any call). */
async function runEarningsCallsListingDiscovery(
  http: (path: string, nowMs: number) => Promise<EarningsCallsHttpResult>,
  nowMs: number,
  result: EarningsCallsRefreshResult,
  requestCeiling: number,
  limit: number = DEFAULT_LISTING_PAGE_LIMIT
): Promise<void> {
  let cursor: number | undefined;
  try {
    cursor = getInternalSetting<number>(LISTING_CURSOR_KEY) ?? undefined;
  } catch {
    cursor = undefined;
  }
  const query = cursor !== undefined ? `after_id=${encodeURIComponent(String(cursor))}&limit=${limit}` : `limit=${limit}`;
  const page = await dispatchEarningsCallsRequest(
    http,
    `/transcripts/recent?${query}`,
    nowMs,
    result,
    requestCeiling,
    "listing",
    { cursor }
  );
  if (!page.ok) return;
  const parsed = parseEarningsCallsListingPage(page.payload);
  const nowIso = new Date(nowMs).toISOString();
  for (const item of parsed.items) {
    if (!item.ticker) continue;
    const period = item.fiscalYear && item.fiscalQuarter
      ? { year: item.fiscalYear, quarter: item.fiscalQuarter }
      : calendarPeriodFor(item.eventDate, nowMs);
    upsertEarningsCallsEventIndex({
      symbol: item.ticker,
      fiscalYear: period.year,
      fiscalQuarter: period.quarter,
      eventId: item.eventId,
      eventDate: item.eventDate,
      source: "listing",
      discoveredAt: nowIso
    });
  }
  if (parsed.nextAfterId !== undefined) {
    try {
      setInternalSetting(LISTING_CURSOR_KEY, parsed.nextAfterId);
    } catch {
      // Best-effort — worst case the next pass re-fetches an overlapping page (idempotent upserts).
    }
  }
}

interface ResolvedEarningsCallsTarget {
  fiscalYear: number;
  fiscalQuarter: number;
  eventId: number;
  eventDate?: string;
}

type ResolveOutcome =
  | { kind: "resolved"; target: ResolvedEarningsCallsTarget }
  | { kind: "not_found" }
  | { kind: "stop" } // channel-wide terminal state (auth/rate_limited/not_subscribed/ceiling/budget/circuit)
  | { kind: "no_id" };

/** Resolve a symbol's most recent known call: the FREE event-index lookup first, falling back to
 *  a live per-symbol probe (GET /companies/ticker/{t}/latest, 1 request) only when the index has
 *  nothing for it yet — the memo's "demote to fallback" design. A successful fallback probe is
 *  itself persisted into the index (source: "probe") so it's free on every later pass. */
async function resolveEarningsCallsTarget(
  http: (path: string, nowMs: number) => Promise<EarningsCallsHttpResult>,
  symbol: string,
  nowMs: number,
  result: EarningsCallsRefreshResult,
  requestCeiling: number,
  negativeTtlMs: number
): Promise<ResolveOutcome> {
  const known = getLatestEarningsCallsEventForSymbol(symbol);
  if (known) {
    return {
      kind: "resolved",
      target: { fiscalYear: known.fiscalYear, fiscalQuarter: known.fiscalQuarter, eventId: known.eventId, eventDate: known.eventDate }
    };
  }

  const check = getEarningsCallsSymbolCheck(symbol);
  if (check && nowMs - Date.parse(check.checkedAt) < negativeTtlMs) return { kind: "no_id" };

  const probe = await dispatchEarningsCallsRequest(
    http,
    `/companies/ticker/${encodeURIComponent(symbol)}/latest`,
    nowMs,
    result,
    requestCeiling,
    "probe",
    { symbol }
  );
  if (!probe.ok && (probe.kind === "ceiling" || probe.kind === "budget" || probe.kind === "circuit")) {
    return { kind: "stop" }; // never reached the network — not a "probed" attempt
  }
  // A real dispatch happened (success or a classified failure like not_found/auth/rate_limited) —
  // counts as "probed" regardless of outcome, matching the pre-redesign semantics.
  result.probed += 1;
  if (!probe.ok) {
    if (probe.kind === "not_found") {
      recordEarningsCallsSymbolCheck({ symbol, checkedAt: new Date(nowMs).toISOString() });
      return { kind: "not_found" };
    }
    // auth/rate_limited/not_subscribed are channel-wide terminal states — stop the whole pass.
    result.errors.push(`probe:${symbol}:${probe.kind}`);
    return { kind: "stop" };
  }
  const latest = parseEarningsCallsLatestCall(probe.payload);
  recordEarningsCallsSymbolCheck({
    symbol,
    checkedAt: new Date(nowMs).toISOString(),
    latestEventId: latest?.eventId,
    latestEventDate: latest?.eventDate
  });
  if (!latest) return { kind: "no_id" };
  const period = latest.fiscalYear && latest.fiscalQuarter
    ? { year: latest.fiscalYear, quarter: latest.fiscalQuarter }
    : calendarPeriodFor(latest.eventDate, nowMs);
  upsertEarningsCallsEventIndex({
    symbol,
    fiscalYear: period.year,
    fiscalQuarter: period.quarter,
    eventId: latest.eventId,
    eventDate: latest.eventDate,
    source: "probe",
    discoveredAt: new Date(nowMs).toISOString()
  });
  return {
    kind: "resolved",
    target: { fiscalYear: period.year, fiscalQuarter: period.quarter, eventId: latest.eventId, eventDate: latest.eventDate }
  };
}

interface FetchTranscriptOutcome {
  /** true when a NEW transcript was fetched and cached this call (counts toward the pass target). */
  fetchedNew: boolean;
  /** true when the pass must stop entirely (entitlement tripped, or a channel-wide terminal state). */
  stopPass: boolean;
  action: EarningsCallsPickAction;
}

/** Fetch, classify (preview guard), cache, and ingest ONE resolved target. Shared by the ordinary
 *  candidate loop and the burst's targeted-historical step. `entitlementUnknownAtPassStart` lets
 *  the FIRST full body of a pass flip entitlement to confirmed_full; every fetch (first or not)
 *  gets the SAME preview-guard check ("preview guard everywhere" — a plan that degrades mid-flight
 *  trips the block immediately, not just on the first call). */
async function fetchAndCacheEarningsCallsTranscript(
  http: (path: string, nowMs: number) => Promise<EarningsCallsHttpResult>,
  symbol: string,
  target: ResolvedEarningsCallsTarget,
  nowMs: number,
  result: EarningsCallsRefreshResult,
  requestCeiling: number,
  ingest: (row: EarningsCallsTranscriptRow) => Promise<boolean>,
  entitlementUnknownAtPassStart: boolean
): Promise<FetchTranscriptOutcome> {
  const body = await dispatchEarningsCallsRequest(
    http,
    `/transcripts/${target.eventId}?format=full`,
    nowMs,
    result,
    requestCeiling,
    "transcript",
    { symbol }
  );
  if (!body.ok) {
    if (body.kind === "ceiling" || body.kind === "budget" || body.kind === "circuit") {
      return { fetchedNew: false, stopPass: true, action: "skipped_out_of_budget" };
    }
    if (body.kind === "not_found") {
      // Definitive: call id known, transcript not yet published — negative-cache it.
      upsertEarningsCallsTranscript({
        symbol,
        fiscalYear: target.fiscalYear,
        fiscalQuarter: target.fiscalQuarter,
        eventId: target.eventId,
        eventDate: target.eventDate,
        content: undefined,
        fetchedAt: new Date(nowMs).toISOString(),
        sourceMeta: JSON.stringify({ source: EARNINGSCALLS_TRANSCRIPT_SOURCE })
      });
      return { fetchedNew: false, stopPass: false, action: "resolved_no_content_yet" };
    }
    // auth/rate_limited/not_subscribed are channel-wide terminal states this pass.
    result.errors.push(`transcript:${symbol}:${body.kind}`);
    return { fetchedNew: false, stopPass: true, action: "skipped_out_of_budget" };
  }

  const content = parseEarningsCallsTranscript(body.payload);
  const classification = classifyFetchedContent(content);

  if (classification === "preview") {
    await tripEntitlementBlock(nowMs, content!.length, { symbol, fiscalYear: target.fiscalYear, fiscalQuarter: target.fiscalQuarter, eventId: target.eventId });
    return { fetchedNew: false, stopPass: true, action: "preview_blocked" };
  }
  if (classification === "full" && entitlementUnknownAtPassStart) {
    saveEntitlementState({ status: "confirmed_full", checkedAt: new Date(nowMs).toISOString() });
  }

  upsertEarningsCallsTranscript({
    symbol,
    fiscalYear: target.fiscalYear,
    fiscalQuarter: target.fiscalQuarter,
    eventId: target.eventId,
    eventDate: target.eventDate,
    content: classification === "full" ? content : undefined,
    fetchedAt: new Date(nowMs).toISOString(),
    sourceMeta: JSON.stringify({ source: EARNINGSCALLS_TRANSCRIPT_SOURCE })
  });
  if (classification !== "full") return { fetchedNew: false, stopPass: false, action: "resolved_no_content_yet" };

  const row = getEarningsCallsTranscript(symbol, target.fiscalYear, target.fiscalQuarter);
  if (row?.content) {
    try {
      await ingest(row);
    } catch (error) {
      result.errors.push(`ingest:${symbol}:${error instanceof Error ? error.name : "error"}`);
    }
  }
  return { fetchedNew: true, stopPass: false, action: "fetched" };
}

/** The leased pass body. Mutates `result` in place; self-guarded (never throws). */
async function runEarningsCallsPass(
  nowMs: number,
  deps: EarningsCallsRefreshDeps,
  result: EarningsCallsRefreshResult,
  claim: OperationLeaseClaim,
  signal: AbortSignal
): Promise<void> {
  if (!deps.force && !isEarningsCallsRefreshDue(nowMs)) return;
  const day = utcDayKey(nowMs);
  setInternalSetting(PASS_WATERMARK_KEY, day);

  const assertLease = () => {
    throwIfOperationLeaseCancelled(signal);
    assertOperationLeaseOwnership(claim);
  };
  const leaseGuard: VectorStoreLeaseGuard = { signal, assertOwnership: assertLease };

  const http = deps.http ?? earningsCallsGet;
  const ingest = deps.ingest ?? ((row: EarningsCallsTranscriptRow) => ingestCachedTranscript(row, leaseGuard));
  const negativeTtlMs = earningsCallsNegativeTtlDays() * 86_400_000;

  try {
    // 0) Entitlement gate: a durable block refuses EVERYTHING (no ingest retries, no listing, no
    //    fetches) — the coordinator's "REFUSE the burst and daily fetches" requirement. No
    //    re-probe here (no retry storm); only an explicit admin action clears/re-probes it.
    const entitlementAtStart = loadEntitlementState();
    if (entitlementAtStart.status === "preview_blocked") {
      result.entitlementBlocked = true;
      return;
    }
    const entitlementUnknownAtPassStart = entitlementAtStart.status === "unknown";

    // 1) Free work first: retry RAG ingest for transcripts already cached (no provider spend).
    for (const pending of listUningestedEarningsCallsTranscripts(MAX_INGEST_RETRIES_PER_PASS)) {
      assertLease();
      try {
        if (await ingest(pending)) result.ingested += 1;
      } catch (error) {
        result.errors.push(`ingest:${pending.symbol}:${error instanceof Error ? error.name : "error"}`);
      }
    }

    // 2) Burst arming: idempotent one-shot consume (force mode / admin manual trigger can
    //    override the target directly, bypassing the settings counter — a test/admin seam).
    const burstTarget = deps.force && deps.burstTranscripts !== undefined
      ? deps.burstTranscripts
      : consumeEarningsCallsBurstPending();
    const isBurst = burstTarget > 0;
    result.isBurst = isBurst;
    const targetTranscripts = isBurst
      ? Math.min(burstTarget, earningsCallsBurstMaxTranscripts())
      : earningsCallsDailyTargetTranscripts();
    const requestCeiling = effectivePassRequestCeiling(targetTranscripts);
    if (targetTranscripts <= 0) return;

    // 3) Recency signal (injected earnings calendar; none in production, FMP is never used) — also gates the daily listing call on a confirmed-quiet
    //    day (memo: "0 requests" when nothing tracked reported). A burst always proceeds
    //    regardless: it explicitly reaches for a batch NOW, not just what reported today.
    const reported = deps.recentlyReported ? await deps.recentlyReported() : undefined;
    if (!isBurst && reported !== undefined && reported.size === 0) return; // quiet day, 0 requests

    // 4) Entitlement /me probe (only while status is genuinely unknown) — a best-effort tier-text
    //    sniff. The DEFINITIVE check is still the length of the first real transcript body
    //    fetched below; this just adds a second, cheaper signal per the coordinator's "2-request
    //    entitlement probe" (/me + one full fetch — the "one full fetch" is this pass's first
    //    natural fetch, not a dedicated extra call, so the only incremental cost is this /me).
    if (entitlementUnknownAtPassStart) {
      assertLease();
      const me = await dispatchEarningsCallsRequest(http, "/me", nowMs, result, requestCeiling, "me");
      if (me.ok && meResponseLooksLimited(me.payload)) {
        await tripEntitlementBlock(nowMs, undefined, { source: "me" });
        result.entitlementBlocked = true;
        return;
      }
    }

    // 5) Id-resolution listing engine: ~1 amortized request/day, populates the event index for
    //    every ticker the provider just published, not just today's candidates.
    if (result.requests < requestCeiling && remainingEarningsCallsBudget(nowMs) > 0) {
      assertLease();
      await runEarningsCallsListingDiscovery(http, nowMs, result, requestCeiling);
      if (result.entitlementBlocked) return;
    }

    // 6) Smart picker: score every candidate symbol into priority order.
    const heldValues = (deps.heldSymbolValues ?? (() => listRecentlyHeldSymbolValuesAllUsers(earningsCallsRecentDays(), nowMs)))();
    const heldSymbolsForCoverage = deps.heldSymbols
      ? deps.heldSymbols()
      : listRecentlyHeldSymbolsAllUsers(earningsCallsRecentDays(), nowMs);
    const scanCandidates = (deps.candidateSymbols ?? getTechnicalWatchlist)()
      .map(normalizeSymbol)
      .filter(Boolean)
      .slice(0, Math.max(earningsCallsTopCandidates(), 50)); // scorer itself dedupes/tiers; keep a generous pool
    const watchlistSymbols = (deps.watchlistSymbols ?? allWatchlistSymbols)();
    const manifestRank = (deps.manifestRank ?? loadManifestRank)();
    const recentEventDates = new Map<string, string>();
    for (const symbol of [...heldValues.keys(), ...heldSymbolsForCoverage]) {
      const known = getLatestEarningsCallsEventForSymbol(symbol);
      if (known?.eventDate && withinRecentWindow(known.eventDate, nowMs)) recentEventDates.set(symbol, known.eventDate);
    }

    const scored = scoreEarningsCallsCandidates({
      holdingsValue: heldValues,
      recentlyReportedSymbols: reported,
      recentEventDates,
      scanCandidates,
      watchlistSymbols,
      manifestRank
    });

    const picks: EarningsCallsPickAuditEntry[] = [];
    let transcriptsThisPass = 0;

    for (const candidate of scored) {
      if (transcriptsThisPass >= targetTranscripts) break;
      assertLease();
      if (result.requests >= requestCeiling) break;
      if (remainingEarningsCallsBudget(nowMs) <= 0) {
        result.skippedBudget += 1;
        auditBudgetExhaustedOncePerDay(nowMs, { at: "candidate", symbol: candidate.symbol });
        break;
      }

      const resolved = await resolveEarningsCallsTarget(http, candidate.symbol, nowMs, result, requestCeiling, negativeTtlMs);
      if (resolved.kind === "stop") break;
      if (resolved.kind === "no_id" || resolved.kind === "not_found") {
        picks.push({ symbol: candidate.symbol, tier: candidate.tier, tierLabel: candidate.tierLabel, rationale: candidate.rationale, action: "skipped_no_id" });
        continue;
      }

      const target = resolved.target;
      if (!isBurst && !withinRecentWindow(target.eventDate, nowMs)) {
        picks.push({ symbol: candidate.symbol, tier: candidate.tier, tierLabel: candidate.tierLabel, rationale: candidate.rationale, action: "skipped_not_recent", fiscalYear: target.fiscalYear, fiscalQuarter: target.fiscalQuarter });
        continue;
      }

      const cached = getEarningsCallsTranscript(candidate.symbol, target.fiscalYear, target.fiscalQuarter);
      if (cached?.content) {
        picks.push({ symbol: candidate.symbol, tier: candidate.tier, tierLabel: candidate.tierLabel, rationale: candidate.rationale, action: "already_cached", fiscalYear: target.fiscalYear, fiscalQuarter: target.fiscalQuarter });
        if (!cached.ingestedAt) {
          try {
            if (await ingest(cached)) result.ingested += 1;
          } catch (error) {
            result.errors.push(`ingest:${candidate.symbol}:${error instanceof Error ? error.name : "error"}`);
          }
        }
        continue;
      }
      if (cached && nowMs - Date.parse(cached.fetchedAt) < negativeTtlMs) {
        picks.push({ symbol: candidate.symbol, tier: candidate.tier, tierLabel: candidate.tierLabel, rationale: candidate.rationale, action: "skipped_negative_ttl", fiscalYear: target.fiscalYear, fiscalQuarter: target.fiscalQuarter });
        continue;
      }

      assertLease();
      const outcome = await fetchAndCacheEarningsCallsTranscript(
        http, candidate.symbol, target, nowMs, result, requestCeiling, ingest, entitlementUnknownAtPassStart
      );
      picks.push({ symbol: candidate.symbol, tier: candidate.tier, tierLabel: candidate.tierLabel, rationale: candidate.rationale, action: outcome.action, fiscalYear: target.fiscalYear, fiscalQuarter: target.fiscalQuarter });
      if (outcome.fetchedNew) {
        result.fetched += 1;
        transcriptsThisPass += 1;
      }
      if (outcome.action === "preview_blocked") result.entitlementBlocked = true;
      if (outcome.stopPass) break;
    }

    // 7) Burst-only targeted historical backfill: top holdings with ZERO cached coverage at all
    //    get a full call-history resolve (1 request -> every quarter's id), then the most recent
    //    resolved quarter is fetched if still budget/target permits.
    if (isBurst && !result.entitlementBlocked && transcriptsThisPass < targetTranscripts && result.requests < requestCeiling) {
      const lackingCoverage = [...heldValues.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([symbol]) => symbol)
        .filter((symbol) => !hasAnyEarningsCallsEventForSymbol(symbol))
        .slice(0, MAX_HISTORICAL_BACKFILL_SYMBOLS_PER_BURST);

      for (const symbol of lackingCoverage) {
        if (transcriptsThisPass >= targetTranscripts || result.requests >= requestCeiling) break;
        if (remainingEarningsCallsBudget(nowMs) <= 0) {
          result.skippedBudget += 1;
          auditBudgetExhaustedOncePerDay(nowMs, { at: "history", symbol });
          break;
        }
        assertLease();
        const history = await dispatchEarningsCallsRequest(
          http, `/companies/ticker/${encodeURIComponent(symbol)}`, nowMs, result, requestCeiling, "history", { symbol }
        );
        if (!history.ok) {
          if (history.kind === "ceiling" || history.kind === "budget" || history.kind === "circuit") break;
          continue; // not_found/auth/rate_limited/transient for one symbol's history: try the next
        }
        const parsed = parseEarningsCallsListingPage(history.payload);
        const nowIso = new Date(nowMs).toISOString();
        for (const item of parsed.items) {
          const period = item.fiscalYear && item.fiscalQuarter
            ? { year: item.fiscalYear, quarter: item.fiscalQuarter }
            : calendarPeriodFor(item.eventDate, nowMs);
          upsertEarningsCallsEventIndex({
            symbol,
            fiscalYear: period.year,
            fiscalQuarter: period.quarter,
            eventId: item.eventId,
            eventDate: item.eventDate,
            source: "company-history",
            discoveredAt: nowIso
          });
        }
        const mostRecent = getLatestEarningsCallsEventForSymbol(symbol);
        if (!mostRecent) continue;
        const cached = getEarningsCallsTranscript(symbol, mostRecent.fiscalYear, mostRecent.fiscalQuarter);
        if (cached?.content) continue;
        if (result.requests >= requestCeiling) break;
        assertLease();
        const outcome = await fetchAndCacheEarningsCallsTranscript(
          http, symbol,
          { fiscalYear: mostRecent.fiscalYear, fiscalQuarter: mostRecent.fiscalQuarter, eventId: mostRecent.eventId, eventDate: mostRecent.eventDate },
          nowMs, result, requestCeiling, ingest, entitlementUnknownAtPassStart
        );
        picks.push({ symbol, tier: 1, tierLabel: "holdings", rationale: "Held position with zero cached transcript coverage (burst historical backfill).", action: outcome.action, fiscalYear: mostRecent.fiscalYear, fiscalQuarter: mostRecent.fiscalQuarter });
        if (outcome.fetchedNew) {
          result.fetched += 1;
          transcriptsThisPass += 1;
        }
        if (outcome.action === "preview_blocked") result.entitlementBlocked = true;
        if (outcome.stopPass) break;
      }
    }

    saveLastPicksAudit({
      day,
      isBurst,
      targetTranscripts,
      requests: result.requests,
      fetched: result.fetched,
      picks,
      recordedAt: new Date(nowMs).toISOString()
    });
  } catch (error) {
    // Self-guarded: a pass failure is an audit row, never a thrown error into the scheduler.
    result.errors.push(error instanceof Error ? error.name : "error");
  }

  try {
    audit("earningscalls_refresh", {
      day,
      requests: result.requests,
      probed: result.probed,
      fetched: result.fetched,
      ingested: result.ingested,
      skippedBudget: result.skippedBudget,
      isBurst: result.isBurst,
      entitlementBlocked: result.entitlementBlocked,
      remainingBudget: remainingEarningsCallsBudget(nowMs),
      remainingRollingBudget: remainingEarningsCallsRollingBudget(nowMs),
      errors: result.errors.slice(0, 10)
    });
  } catch {
    // Best-effort audit.
  }
}

// ── Manual entitlement probe (admin action — outside the daily/burst cadence) ──────────────────

/**
 * Admin-triggered entitlement re-check: /me + one real transcript fetch, OUTSIDE the once/day
 * watermark (so an operator can re-verify immediately after upgrading a plan). Resolves a target
 * via the same free event-index-or-fallback-probe path the ordinary pass uses, preferring the
 * highest-value held symbol; falls back to a fixed anchor symbol when nothing is held/resolvable.
 * Runs under the same RAG_REINDEX lease discipline as the ordinary pass (caller passes the claim).
 */
export async function manuallyProbeEarningsCallsEntitlement(
  nowMs: number,
  claim: OperationLeaseClaim,
  signal: AbortSignal | undefined,
  deps: Pick<EarningsCallsRefreshDeps, "http" | "heldSymbolValues" | "ingest"> = {}
): Promise<{ state: EarningsCallsEntitlementState; requests: number; errors: string[] }> {
  const assertLease = () => {
    if (signal) throwIfOperationLeaseCancelled(signal);
    assertOperationLeaseOwnership(claim);
  };
  const leaseGuard: VectorStoreLeaseGuard = { signal, assertOwnership: assertLease };
  const http = deps.http ?? earningsCallsGet;
  const ingest = deps.ingest ?? ((row: EarningsCallsTranscriptRow) => ingestCachedTranscript(row, leaseGuard));
  const result: EarningsCallsRefreshResult = {
    enabled: true, due: true, requests: 0, probed: 0, fetched: 0, ingested: 0, skippedBudget: 0, errors: []
  };
  const requestCeiling = effectivePassRequestCeiling(1);
  const errors: string[] = [];

  if (!earningsCallsTranscriptsEnabled()) {
    return { state: loadEntitlementState(), requests: 0, errors: ["disabled_or_no_key"] };
  }

  assertLease();
  const me = await dispatchEarningsCallsRequest(http, "/me", nowMs, result, requestCeiling, "me-manual");
  if (me.ok && meResponseLooksLimited(me.payload)) {
    await tripEntitlementBlock(nowMs, undefined, { source: "me-manual" });
    return { state: loadEntitlementState(), requests: result.requests, errors };
  }

  const heldValues = (deps.heldSymbolValues ?? (() => listRecentlyHeldSymbolValuesAllUsers(earningsCallsRecentDays(), nowMs)))();
  const candidateSymbols = [...heldValues.entries()].sort((a, b) => b[1] - a[1]).map(([symbol]) => symbol);
  const anchor = process.env.EARNINGSCALLS_ENTITLEMENT_PROBE_ANCHOR?.trim().toUpperCase() || "AAPL";
  if (candidateSymbols.length === 0) candidateSymbols.push(anchor);

  for (const symbol of candidateSymbols) {
    assertLease();
    const resolved = await resolveEarningsCallsTarget(http, symbol, nowMs, result, requestCeiling, earningsCallsNegativeTtlDays() * 86_400_000);
    if (resolved.kind === "stop") {
      errors.push(`probe:${symbol}:stopped`);
      break;
    }
    if (resolved.kind !== "resolved") continue;
    const cached = getEarningsCallsTranscript(symbol, resolved.target.fiscalYear, resolved.target.fiscalQuarter);
    if (cached?.content) {
      // Already have real content cached — that alone proves full-text entitlement.
      saveEntitlementState({ status: "confirmed_full", checkedAt: new Date(nowMs).toISOString() });
      break;
    }
    const outcome = await fetchAndCacheEarningsCallsTranscript(http, symbol, resolved.target, nowMs, result, requestCeiling, ingest, true);
    if (outcome.action === "preview_blocked" || outcome.action === "fetched") break; // definitive answer either way
  }

  try {
    audit("earningscalls_entitlement_probe_manual", { requests: result.requests, state: loadEntitlementState().status });
  } catch {
    // Best-effort.
  }
  return { state: loadEntitlementState(), requests: result.requests, errors };
}
