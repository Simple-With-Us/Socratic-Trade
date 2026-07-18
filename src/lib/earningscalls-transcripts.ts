// earningscalls-transcripts.ts — EarningsCalls.dev as an alternate earnings-call-transcript
// SOURCE feeding the same rights-gated RAG boundary as the FMP producer (storeDocument with
// doc_type "earnings-transcript"), designed around the owner's FREE plan: $0/mo with a HARD
// provider-side limit of 200 requests/month (plus 1000 requests/hour rate limit, 10 GB/mo
// bandwidth — both far above what this module can generate).
//
// ── API ground truth (researched 2026-07-16; record of what was verified vs. assumed) ──────
// VERIFIED against https://earningscalls.dev (live probes + /openapi.json + /docs):
//   - Host: https://earningscalls.dev, base path /api/v1 (openapi.json `servers` confirms; this
//     is a first-party API — the docs make NO reference to the unrelated `earningscall` python
//     library or earningscall.biz. The same API is also resold via RapidAPI under host
//     earnings-call-transcripts1.p.rapidapi.com with X-RapidAPI-Key headers; this module uses
//     the DIRECT host + key only).
//   - Auth: `X-API-Key: <key>` header OR `api_key` query param. Verified via a live
//     unauthenticated probe returning HTTP 401 {"error":"Unauthorized","message":"API key
//     required. Pass via X-API-Key header or api_key query parameter.","docs":"/docs"}.
//     This module always uses the header (never the query param, so keys can't leak into URLs).
//   - Endpoints used (both GET, confirmed in /openapi.json):
//       /api/v1/companies/ticker/{ticker}/latest   — latest earnings call for a ticker
//       /api/v1/transcripts/{earningsId}?format=full — full transcript by earnings-call id
//   - Request accounting: the docs do not define it beyond "requests/month", so this module
//     conservatively counts EVERY HTTP call it dispatches (metadata and transcript alike)
//     against the monthly budget.
//   - No published caching/storage restriction was found in the public docs (checked /docs and
//     the pricing content). Fetch-once-forever local caching is therefore assumed permitted for
//     this internal, non-republished use; transcript content stays in prompts/RAG/evidence and
//     is NEVER shown on user-facing pages (same public-display boundary as FMP transcripts).
// ASSUMED (response bodies are not publicly documented; parsers below are shape-tolerant and
// unit-tested against these recorded expectations — correct them against real responses once
// the key is installed):
//   - Responses may arrive bare or wrapped in a top-level `data` object/array.
//   - Latest-call metadata fields: an id (`earnings_call_id` | `earningsId` | `id`), an event
//     timestamp (`event_date_time` | `event_date` | `date`), optional `fiscal_year`/`year` and
//     `fiscal_quarter`/`quarter`, `ticker`/`company_ticker`, `company_name`.
//   - Transcript payload: `full_text` (landing page names this field) | `transcript` | `text` |
//     `content`, and/or speaker segments (`speakers`/`components`/`segments` arrays of
//     {speaker_name, speaker_type, text_content, component_order} — field names from the
//     provider's own docs for /speakers/{earningsId}).
//   - When fiscal year/quarter are absent, the CALENDAR year/quarter of the event date key the
//     cache row (documented as such in source_meta; a call is uniquely identified either way).
//
// ── Budget design (the core constraint) ───────────────────────────────────────────────────
// The 200/month limit is a hard provider-side stop, so the app must never approach it blind:
//   - Durable calendar-month (UTC) counter persisted in the settings table, mirroring the
//     Alpha Vantage proactive daily budget (alpha-vantage-key-pool.ts, PR #1656): reserve
//     BEFORE dispatch via the synchronous tryReserve/refund pair — better-sqlite3 is
//     synchronous, so a reserve is atomic at the JS level and concurrent reserves cannot
//     overspend; the persisted row survives restarts/redeploys mid-month.
//   - Default budget 180 (EARNINGSCALLS_MONTHLY_BUDGET) — 20 requests of headroom under the
//     hard 200 for manual/diagnostic use and accounting drift.
//   - Every HTTP call reserves exactly 1 unit first (retries are disabled on the transport so
//     one reservation can never become two provider-side requests). A CircuitOpenError skip
//     (thrown before any network dispatch) refunds; a dispatched-but-failed call does NOT
//     (it still consumed provider quota).
//   - Exhaustion is a quiet skip with at most ONE audit event per UTC day — never a retry storm.
//   - The durable-budget lane here is intentionally NOT db-provider-dispatch (that push lane is
//     quota-only by invariant and built for cost-capped paid providers); request telemetry to
//     the usage monitor flows through the established recordProviderCall path inside
//     fetchWithRetry (service "earningscalls", $0 cost — this plan is free, only quota matters).
//
// ── Selection policy (~6 requests/day sustainable at 180/month) ────────────────────────────
// Once per UTC day (scheduler cadence, same watermark pattern as economic-calendar.ts):
//   (a) HOLDINGS FIRST: symbols with a non-zero position in any connected account's latest
//       portfolio snapshot (broker-call-free read), that reported earnings within
//       EARNINGSCALLS_RECENT_DAYS (default 7);
//   (b) then, budget permitting, up to EARNINGSCALLS_TOP_CANDIDATES (default 3) of the most
//       recent scan's top candidates (the technical watchlist — the last scan's candidate set)
//       that reported within the window.
// Earnings recency comes from data the app already has when possible: with FMP_API_KEY set,
// one FMP earnings-calendar read (FMP's quota, not this budget) prefilters to symbols that
// actually reported in the window. Without it, recency is discovered by the latest-call probe
// itself, bounded by the per-symbol negative-TTL watermark so a symbol costs at most one
// ANSWERED probe (success or definitive 404 — failed probes stay retryable) per
// EARNINGSCALLS_NEGATIVE_TTL_DAYS. Each pass is additionally capped at
// EARNINGSCALLS_MAX_REQUESTS_PER_PASS (default 6; hard ceiling 6 — see
// earningsCallsMaxRequestsPerPass for the provider-window derivation) HTTP calls. The whole
// pass runs under the shared durable RAG_REINDEX operation lease, like every other producer
// that spends shared Voyage/Pinecone capacity.
//
// ── Cache + downstream ─────────────────────────────────────────────────────────────────────
// Transcripts are immutable once published: fetch-once-forever cache keyed
// (symbol, fiscal_year, fiscal_quarter) in earningscalls_transcripts (db-earningscalls.ts,
// migration 46). A content hit NEVER re-fetches; an empty (not-yet-available) result is
// negative-cached for EARNINGSCALLS_NEGATIVE_TTL_DAYS. Cached-but-unindexed rows retry RAG
// ingest for free. Downstream is the #1586 boundary: vector-db.storeDocument with doc_type
// "earnings-transcript" and source EARNINGSCALLS_TRANSCRIPT_SOURCE (managed namespace), plus
// the generic ingested_accessions ledger. INGEST FLAG DISCIPLINE: where FMP required an
// explicit default-off flag pair, this source FOLLOWS THE KEY — EARNINGSCALLS_API_KEY present
// = the owner opted in (they signed up for exactly this data); EARNINGSCALLS_DISABLED=1 is the
// kill-switch. Retrieval gating for this source (vector-db buildExtraFilters /
// filterMatchesForTranscriptRights, strategy doc-type request, chat sanitizer) keys on the
// same earningsCallsTranscriptsEnabled() predicate from earningscalls-gate.ts.

import { CircuitOpenError } from "./api-circuit-breaker";
import { fetchWithRetry } from "./data-providers";
import { audit, getDb } from "./db";
import {
  getEarningsCallsSymbolCheck,
  getEarningsCallsTranscript,
  listUningestedEarningsCallsTranscripts,
  markEarningsCallsTranscriptIngested,
  recordEarningsCallsSymbolCheck,
  upsertEarningsCallsTranscript,
  type EarningsCallsTranscriptRow
} from "./db-earningscalls";
import { listRecentlyHeldSymbolsAllUsers } from "./db-fills";
import { getInternalSetting, setInternalSetting } from "./db-settings";
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

export const EARNINGSCALLS_BASE = "https://earningscalls.dev/api/v1";
// RapidAPI marketplace channel (where the free 200/month plan lives — the owner's channel).
// Same vendor, same /api/v1 path family behind RapidAPI's proxy; auth moves to x-rapidapi-*
// headers. NOTE 2026-07-16: pre-subscription probes of this host returned HTTP 405
// {"message":"The API provider has disabled request access to the API."} on every path —
// expected to clear once the free-plan subscription is completed on the listing
// (rapidapi.com/earningscallsdev/api/earnings-call-transcripts1); re-verify response shapes
// against the shape-tolerant parsers below on first live pass.
export const EARNINGSCALLS_RAPIDAPI_HOST = "earnings-call-transcripts1.p.rapidapi.com";
export const EARNINGSCALLS_RAPIDAPI_BASE = `https://${EARNINGSCALLS_RAPIDAPI_HOST}/api/v1`;

const BUDGET_SETTING_KEY = "earningscalls_monthly_request_budget";
const PASS_WATERMARK_KEY = "earningscalls:lastPassDay";
const EXHAUSTED_AUDIT_DAY_KEY = "earningscalls:budgetExhaustedAuditDay";

const DEFAULT_MONTHLY_BUDGET = 180; // headroom under the plan's HARD 200/month
const DEFAULT_RECENT_DAYS = 7;
const DEFAULT_TOP_CANDIDATES = 3;
const DEFAULT_NEGATIVE_TTL_DAYS = 3;
const DEFAULT_MAX_REQUESTS_PER_PASS = 6; // ~180/30
const REQUEST_TIMEOUT_MS = 20_000;
const MIN_TRANSCRIPT_CHARS = 100; // same floor as the FMP producer — a stub is not a transcript
const MAX_INGEST_RETRIES_PER_PASS = 3;
// The documented pre-subscription response on the RapidAPI channel (see the EARNINGSCALLS_RAPIDAPI_BASE
// comment above) — every call 405s until the owner completes the free-plan subscription. That is a
// known, permanent-until-manual-action state, not a provider outage, so it must not feed the generic
// api_health_log/Sentry "connection failed" alert path (db-health.ts's alertConnectionFailure fires
// after 5 consecutive logged failures). Suppressing it here mirrors the same precedent used for FMP's
// own known plan-restriction statuses (fmp-common.ts/fmp-transcripts.ts suppress 402/403 on their
// entitlement-capability probes) — only this one documented status is excluded; any OTHER failure
// (500s, timeouts, a genuine 401/403 after subscribing) still logs and can still trip the real alert.
const PRE_SUBSCRIPTION_STATUS = 405;

function intEnv(raw: string | undefined, fallback: number, min = 0, max = 100_000): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** Env-overridable monthly request budget. 0 is a valid override (block all calls without
 *  removing the key). Default 180 — deliberate headroom under the provider's hard 200/month. */
export function earningsCallsMonthlyBudget(): number {
  return intEnv(process.env.EARNINGSCALLS_MONTHLY_BUDGET, DEFAULT_MONTHLY_BUDGET);
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

/** Provider-quota-safe ceiling for the per-pass request cap. The plan's HARD 200/month resets
 *  on the SUBSCRIPTION anniversary (a rolling ~31-day window), while the durable budget above
 *  counts UTC calendar months — the two windows can misalign, so the calendar budget alone
 *  cannot bound an arbitrary 31-day span. The pass cadence is once per UTC day
 *  (PASS_WATERMARK_KEY), and a rolling 31-day window intersects at most 32 distinct UTC days
 *  (partial first + last day), so a per-pass cap of 6 keeps ANY such window at
 *  <= 32 * 6 = 192 <= 200 requests; 7 would allow 224. */
const MAX_SAFE_REQUESTS_PER_PASS = 6;

/** Per-pass HTTP request cap. The env override can LOWER the cap, never raise it past the
 *  provider-safe ceiling (an out-of-range value falls back to the default 6) — see
 *  MAX_SAFE_REQUESTS_PER_PASS for the 31-day-window derivation (Codex review, PR #1680). */
export function earningsCallsMaxRequestsPerPass(): number {
  return intEnv(
    process.env.EARNINGSCALLS_MAX_REQUESTS_PER_PASS,
    DEFAULT_MAX_REQUESTS_PER_PASS,
    0,
    MAX_SAFE_REQUESTS_PER_PASS
  );
}

// ── Durable calendar-month (UTC) request budget ────────────────────────────────

interface PersistedMonthlyBudget {
  monthKey: string; // "YYYY-MM" in UTC
  used: number;
}

/** UTC calendar-month key — the provider's stated quota window is monthly. */
export function earningsCallsMonthKey(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

function loadPersistedBudget(): PersistedMonthlyBudget {
  try {
    return getInternalSetting<PersistedMonthlyBudget>(BUDGET_SETTING_KEY) ?? { monthKey: "", used: 0 };
  } catch {
    // A settings read must never break the producer — worst case one under-counted call,
    // re-derived from the persisted row on the next reserve.
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

/**
 * Reserve up to `n` requests against the current UTC month's budget, returning how many were
 * admitted (0..n). RESERVE-BEFORE-CALL: callers reserve, then dispatch at most that many HTTP
 * requests. Synchronous read-modify-write on the settings row — better-sqlite3 executes it
 * atomically w.r.t. any other JS-level reserve, so concurrent reserves cannot jointly exceed
 * the budget. Rolls to 0 automatically when the month key changes; persisted immediately so a
 * restart mid-month can never forget spent requests.
 */
export function tryReserveEarningsCallsRequests(n: number, nowMs: number = Date.now()): number {
  if (n <= 0) return 0;
  const budget = earningsCallsMonthlyBudget();
  if (budget <= 0) return 0;
  const monthKey = earningsCallsMonthKey(nowMs);
  const persisted = loadPersistedBudget();
  const used = persisted.monthKey === monthKey ? persisted.used : 0;
  const admitted = Math.min(n, Math.max(0, budget - used));
  if (admitted <= 0) return 0;
  savePersistedBudget({ monthKey, used: used + admitted });
  return admitted;
}

/** Return reserved-but-never-dispatched requests (e.g. a circuit-open skip thrown before any
 *  network I/O). A dispatched call that failed is NOT refunded — it consumed provider quota.
 *  No-op across a month rollover. */
export function refundEarningsCallsRequests(n: number, nowMs: number = Date.now()): void {
  if (n <= 0) return;
  const monthKey = earningsCallsMonthKey(nowMs);
  const persisted = loadPersistedBudget();
  if (persisted.monthKey !== monthKey) return;
  savePersistedBudget({ monthKey, used: Math.max(0, persisted.used - n) });
}

export function remainingEarningsCallsBudget(nowMs: number = Date.now()): number {
  const budget = earningsCallsMonthlyBudget();
  const persisted = loadPersistedBudget();
  const used = persisted.monthKey === earningsCallsMonthKey(nowMs) ? persisted.used : 0;
  return Math.max(0, budget - used);
}

/** Quiet-exhaustion discipline: audited at most once per UTC day. */
function auditBudgetExhaustedOncePerDay(nowMs: number, context: Record<string, unknown>): void {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  try {
    if (getInternalSetting<string>(EXHAUSTED_AUDIT_DAY_KEY) === day) return;
    setInternalSetting(EXHAUSTED_AUDIT_DAY_KEY, day);
    audit("earningscalls_budget_exhausted", {
      monthKey: earningsCallsMonthKey(nowMs),
      budget: earningsCallsMonthlyBudget(),
      ...context
    });
  } catch {
    // Auditing must never break the skip path.
  }
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
 * full-text field; falls back to joining speaker segments as "Name (type): text" lines (the
 * speaker-tagged form documented for /speakers/{earningsId}). Returns undefined when no
 * meaningful text exists — the caller negative-caches that outcome.
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
    response = await fetchWithRetry(
      `${base}${path}`,
      {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      },
      {
        // retries: 0 is load-bearing — one reservation must never become two provider-side
        // requests. fetchWithRetry still provides the per-lane circuit breaker, api_health_log
        // rows, key scrubbing, and recordProviderCall usage telemetry (the established
        // usage-monitor path; this plan costs $0 so only request counts are reported).
        retries: 0,
        service: "earningscalls",
        apiKey,
        keySource: "env",
        // See PRE_SUBSCRIPTION_STATUS above: don't let the known pre-subscription 405 feed
        // api_health_log and trip the automatic Sentry connection-failed alert.
        suppressHealthStatuses: [PRE_SUBSCRIPTION_STATUS]
      }
    );
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      // Thrown BEFORE any network dispatch — the provider never saw this request.
      refundEarningsCallsRequests(1, nowMs);
      return { ok: false, kind: "circuit" };
    }
    // Transport error after dispatch started: the request may have reached the provider.
    // Conservatively keep it spent.
    return { ok: false, kind: "transient" };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, kind: "auth" };
  if (response.status === 404) return { ok: false, kind: "not_found" };
  if (response.status === 402 || response.status === 429) return { ok: false, kind: "rate_limited" };
  // The known pre-subscription 405 is a CHANNEL-WIDE terminal state (every symbol 405s until the
  // owner subscribes), not a per-symbol miss. Classify it distinctly so the pass stops after the
  // first one (see runEarningsCallsPass) instead of burning up to perPassCap budget units/day on
  // the same guaranteed answer — matching how auth/rate_limited already break the pass. Health
  // suppression above still spares the Sentry alert. Any OTHER 405 (would be surprising) is not
  // this documented state; only the pre-subscription status maps here.
  if (response.status === PRE_SUBSCRIPTION_STATUS) return { ok: false, kind: "not_subscribed" };
  if (!response.ok) return { ok: false, kind: "transient" };
  try {
    return { ok: true, payload: await response.json() };
  } catch {
    return { ok: false, kind: "transient" };
  }
}

// ── Cadence ─────────────────────────────────────────────────────────────────────

/** Once per UTC day, mirroring economic-calendar.ts's persisted watermark. */
export function isEarningsCallsRefreshDue(nowMs: number = Date.now()): boolean {
  if (!earningsCallsTranscriptsEnabled()) return false;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return getInternalSetting<string>(PASS_WATERMARK_KEY) !== day;
}

// ── Downstream ingest (the #1586 storeDocument boundary) ───────────────────────

function accessionFor(row: { symbol: string; fiscalYear: number; fiscalQuarter: number }): string {
  return `earningscalls:${normalizeSymbol(row.symbol)}:${row.fiscalYear}Q${row.fiscalQuarter}`;
}

function recordIngestedLedgerRow(accession: string, ticker: string, chunkCount: number, indexedAt: string): void {
  // Generic ingestion ledger only (matches the FMP producer's non-SEC discipline): never a
  // synthetic sec_filings row.
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

/**
 * Push one cached transcript through storeDocument (managed namespace; source
 * "earningscalls-dev"). Returns true only when the document committed completely — partial or
 * budget-skipped stores leave the row un-marked so a later pass retries for FREE (the provider
 * fetch is already cached; only Voyage/Pinecone work re-runs, deduped by content hash).
 */
async function ingestCachedTranscript(
  row: EarningsCallsTranscriptRow,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<boolean> {
  if (!row.content) return false;
  const accession = accessionFor(row);
  const { storeDocument } = await import("./vector-db");
  const stored = await storeDocument(
    {
      text: row.content,
      doc_id: accession,
      ticker: row.symbol,
      title: `${row.symbol} earnings call ${row.fiscalYear} Q${row.fiscalQuarter}`,
      doc_type: EARNINGSCALLS_TRANSCRIPT_DOC_TYPE,
      // The call date is event metadata; first fetch time is the honest availability anchor.
      published_at: row.eventDate ?? row.fetchedAt,
      acceptance_datetime: row.fetchedAt,
      source: EARNINGSCALLS_TRANSCRIPT_SOURCE,
      // Key-free provider locator (metadata only, never logged).
      url: row.eventId ? `${EARNINGSCALLS_BASE}/transcripts/${row.eventId}` : `${EARNINGSCALLS_BASE}/search/by_ticker`
    },
    "local",
    { parserRevision: "earningscalls-transcript-v1", documentKey: accession, leaseGuard }
  );
  // Complete = storeDocument's full receipt: documentComplete === true plus either exact
  // indexed === attempted cardinality or an exact reusedCommitted receipt (reusedCommitted
  // stores have indexed=0 but documentComplete=true) — the contract StoreContextsResult
  // documents for source-level completion ledgers. indexed > 0 alone can be a PARTIAL
  // multi-chunk write (documentComplete=false); marking that ingested would permanently drop
  // the row from the free retry queue (Codex review, PR #1680). Budget-skips/unconfigured keys
  // leave the row pending for a free retry, mirroring sec-filings' "never record a partial
  // ingest" discipline.
  const reusedCommitted =
    stored.reusedCommitted === true && stored.documentComplete === true && stored.attempted > 0;
  const complete = !stored.error && !stored.unconfigured &&
    stored.documentComplete === true &&
    (reusedCommitted || stored.indexed === stored.attempted);
  if (!complete) return false;
  const at = new Date().toISOString();
  // `attempted` is the complete document chunk count (a reusedCommitted store indexes 0 this
  // run but proves the full cardinality), so it is what the coverage ledger must record.
  recordIngestedLedgerRow(accession, normalizeSymbol(row.symbol), stored.attempted, at);
  markEarningsCallsTranscriptIngested(row.symbol, row.fiscalYear, row.fiscalQuarter, at);
  return true;
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
}

export interface EarningsCallsRefreshDeps {
  /** Test seam: replaces the real HTTP layer. NOTE: only the default transport reserves budget
   *  internally; an injected fetcher bypasses reserve/refund (the pass's remaining-budget and
   *  per-pass-cap checks still apply, which is what the selection tests exercise). */
  http?: (path: string, nowMs: number) => Promise<EarningsCallsHttpResult>;
  heldSymbols?: () => string[];
  candidateSymbols?: () => string[];
  /** Symbols that reported earnings inside the recency window, when known from data the app
   *  already has (FMP earnings calendar). undefined = unknown → probe-with-watermark mode. */
  recentlyReported?: () => Promise<Set<string> | undefined>;
  ingest?: (row: EarningsCallsTranscriptRow) => Promise<boolean>;
  force?: boolean;
}

/** FMP earnings-calendar prefilter (spends FMP quota, not this budget). undefined on any
 *  failure or when FMP is unconfigured/unentitled — callers then fall back to probe mode.
 *  Deliberately calls requestFmp directly instead of fmp-gamma's getEarningsCalendar: that
 *  wrapper normalizes the null requestFmp returns for a 402/403 (key configured but the
 *  /earnings-calendar endpoint unentitled) into [], which is indistinguishable from a REAL
 *  empty calendar — and an empty Set here is authoritative, so it would remove every symbol
 *  instead of engaging the documented latest-call-probe fallback (Codex review, PR #1680). */
async function fmpRecentlyReportedSymbols(nowMs: number): Promise<Set<string> | undefined> {
  if (!process.env.FMP_API_KEY) return undefined;
  try {
    const { requestFmp } = await import("./fmp-common");
    const to = new Date(nowMs).toISOString().slice(0, 10);
    const from = new Date(nowMs - earningsCallsRecentDays() * 86_400_000).toISOString().slice(0, 10);
    const rows = await requestFmp<unknown>("/earnings-calendar", { from, to });
    // null = the calendar is UNAVAILABLE (402/403 unentitled), and a non-array body is an
    // unknown shape. Neither is a real "nothing reported" answer — keep unavailability
    // undefined so the probe fallback engages. Only a real array (even an empty one) is an
    // authoritative calendar.
    if (!Array.isArray(rows)) return undefined;
    const reported = new Set<string>();
    for (const row of rows) {
      const symbol = normalizeSymbol(String((row as { symbol?: unknown } | null)?.symbol ?? ""));
      if (symbol) reported.add(symbol);
    }
    return reported;
  } catch {
    return undefined;
  }
}

/** UTC-safe event-date parse. A timezone-less date-time string parses as LOCAL time per
 *  ECMA-262, which would skew the recency window and — worse — the calendar (year, quarter)
 *  CACHE KEY fallback by the host's UTC offset near boundaries. Provider datetimes are treated
 *  as UTC unless they carry an explicit offset (adversarial-review finding, 2026-07-16). */
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

/**
 * The daily pass. Dormant (zero calls, zero writes) without EARNINGSCALLS_API_KEY or with
 * EARNINGSCALLS_DISABLED=1. The pass BODY is self-guarded (a pass failure becomes an errors
 * entry, never a throw); like the neighboring filings/FMP producers, a lost RAG_REINDEX lease
 * ownership at the success boundary is the one condition allowed to propagate — the
 * scheduler's catch handles it.
 */
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

  // Serialize with every other producer that spends shared Voyage/Pinecone capacity — filings,
  // FMP transcripts, 8-K reindex, managed-vector reconciliation all take the durable
  // RAG_REINDEX lease before embedding, and this producer's storeDocument ingest (fresh
  // fetches AND the free cached-ingest retries) must join that single-flight (Codex review,
  // PR #1680). A busy lease is a benign deferred pass: the daily watermark is only written
  // INSIDE the lease, so a later scheduler tick simply retries.
  const guarded = await runWithOperationLease(
    { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "scheduled-earningscalls-transcripts" },
    async (claim, signal) => runEarningsCallsPass(nowMs, deps, result, claim, signal)
  );
  if (!guarded.acquired) return { ...result, operationLease: guarded.busy };
  return result;
}

/** The leased pass body. Mutates `result` in place; self-guarded (never throws). */
async function runEarningsCallsPass(
  nowMs: number,
  deps: EarningsCallsRefreshDeps,
  result: EarningsCallsRefreshResult,
  claim: OperationLeaseClaim,
  signal: AbortSignal
): Promise<void> {
  // Recheck after durable acquisition so a delayed process cannot repeat a pass another owner
  // completed and watermarked in the meantime (same idiom as the FMP transcript producer).
  if (!deps.force && !isEarningsCallsRefreshDue(nowMs)) return;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  setInternalSetting(PASS_WATERMARK_KEY, day);

  // Lease fence (same idiom as the FMP producer's purge/refresh paths): assert cancellation +
  // durable ownership before every provider call and thread the guard into storeDocument, so a
  // lost/expired lease stops this pass instead of racing the next owner's corpus writes and
  // duplicating shared Voyage/Pinecone spend (Codex review round 2, PR #1680). A throw here is
  // swallowed into result.errors by the pass's self-guard — the point is stopping the work,
  // and runWithOperationLease independently re-asserts ownership at the success boundary.
  const assertLease = () => {
    throwIfOperationLeaseCancelled(signal);
    assertOperationLeaseOwnership(claim);
  };
  const leaseGuard: VectorStoreLeaseGuard = { signal, assertOwnership: assertLease };

  const http = deps.http ?? earningsCallsGet;
  const ingest = deps.ingest ?? ((row: EarningsCallsTranscriptRow) => ingestCachedTranscript(row, leaseGuard));
  const perPassCap = earningsCallsMaxRequestsPerPass();
  const negativeTtlMs = earningsCallsNegativeTtlDays() * 86_400_000;

  try {
    // 0) Free work first: retry RAG ingest for transcripts already cached (no provider spend).
    for (const pending of listUningestedEarningsCallsTranscripts(MAX_INGEST_RETRIES_PER_PASS)) {
      assertLease();
      try {
        if (await ingest(pending)) result.ingested += 1;
      } catch (error) {
        result.errors.push(`ingest:${pending.symbol}:${error instanceof Error ? error.name : "error"}`);
      }
    }

    // 1) Candidates: holdings first, then bounded top scan candidates.
    const held = (deps.heldSymbols ?? listRecentlyHeldSymbolsAllUsers)().map(normalizeSymbol).filter(Boolean);
    const heldSet = new Set(held);
    const candidates = (deps.candidateSymbols ?? getTechnicalWatchlist)()
      .map(normalizeSymbol)
      .filter((symbol) => symbol && !heldSet.has(symbol))
      .slice(0, earningsCallsTopCandidates());
    let queue = [...new Set([...held, ...candidates])];

    // 2) Recency prefilter from data the app already has (FMP calendar), when available.
    const reported = await (deps.recentlyReported ?? (() => fmpRecentlyReportedSymbols(nowMs)))();
    if (reported) queue = queue.filter((symbol) => reported.has(symbol));

    for (const symbol of queue) {
      assertLease();
      if (result.requests >= perPassCap) break;

      // Per-symbol probe watermark: a symbol costs at most one probe per negative-TTL window.
      const check = getEarningsCallsSymbolCheck(symbol);
      if (check && nowMs - Date.parse(check.checkedAt) < negativeTtlMs) continue;

      if (remainingEarningsCallsBudget(nowMs) <= 0) {
        result.skippedBudget += 1;
        auditBudgetExhaustedOncePerDay(nowMs, { at: "probe", symbol });
        break;
      }
      const probe = await http(`/companies/ticker/${encodeURIComponent(symbol)}/latest`, nowMs);
      if (!probe.ok && probe.kind === "budget") {
        result.skippedBudget += 1;
        auditBudgetExhaustedOncePerDay(nowMs, { at: "probe", symbol });
        break;
      }
      if (!probe.ok && probe.kind === "circuit") break; // refunded; lane is cooling off
      result.requests += 1;
      result.probed += 1;
      if (!probe.ok) {
        // Watermark only the DEFINITIVE miss (404 = ticker unknown upstream): re-probing that
        // within the TTL would spend budget on the same answer. A FAILED request — auth,
        // rate-limit, or transient (incl. the documented pre-subscription RapidAPI 405,
        // classified transient) — proves nothing about the symbol; watermarking it delayed the
        // first usable ingest by the whole negative TTL, so failures stay retryable on the
        // next pass (Codex review, PR #1680). Auth/rate-limit still stop the pass early: more
        // calls would waste budget on the same outcome.
        if (probe.kind === "not_found") {
          recordEarningsCallsSymbolCheck({ symbol, checkedAt: new Date(nowMs).toISOString() });
          continue;
        }
        // auth/rate_limited/not_subscribed are all channel-wide terminal states this pass —
        // every remaining symbol would return the same answer, so stop rather than spend more
        // budget. not_subscribed additionally has its Sentry alert suppressed at the transport
        // (it's the documented, expected pre-subscription 405), so it only records a pass error.
        if (probe.kind === "auth" || probe.kind === "rate_limited" || probe.kind === "not_subscribed") {
          result.errors.push(`probe:${symbol}:${probe.kind}`);
          break;
        }
        continue;
      }
      const latest = parseEarningsCallsLatestCall(probe.payload);
      recordEarningsCallsSymbolCheck({
        symbol,
        checkedAt: new Date(nowMs).toISOString(),
        latestEventId: latest?.eventId,
        latestEventDate: latest?.eventDate
      });
      audit("earningscalls_request", {
        kind: "latest",
        symbol,
        remainingBudget: remainingEarningsCallsBudget(nowMs)
      });
      if (!latest || !withinRecentWindow(latest.eventDate, nowMs)) continue;

      const period = latest.fiscalYear && latest.fiscalQuarter
        ? { year: latest.fiscalYear, quarter: latest.fiscalQuarter }
        : calendarPeriodFor(latest.eventDate, nowMs);
      const cached = getEarningsCallsTranscript(symbol, period.year, period.quarter);
      if (cached?.content) {
        // FETCH-ONCE-FOREVER: a content hit never re-fetches. Retry ingest only if pending.
        if (!cached.ingestedAt) {
          try {
            if (await ingest(cached)) result.ingested += 1;
          } catch (error) {
            result.errors.push(`ingest:${symbol}:${error instanceof Error ? error.name : "error"}`);
          }
        }
        continue;
      }
      if (cached && nowMs - Date.parse(cached.fetchedAt) < negativeTtlMs) continue; // negative TTL holds

      if (result.requests >= perPassCap) break;
      if (remainingEarningsCallsBudget(nowMs) <= 0) {
        result.skippedBudget += 1;
        auditBudgetExhaustedOncePerDay(nowMs, { at: "transcript", symbol });
        break;
      }
      assertLease(); // awaits since the iteration-top fence — re-prove before the second dispatch
      const body = await http(`/transcripts/${latest.eventId}?format=full`, nowMs);
      if (!body.ok && body.kind === "budget") {
        result.skippedBudget += 1;
        auditBudgetExhaustedOncePerDay(nowMs, { at: "transcript", symbol });
        break;
      }
      if (!body.ok && body.kind === "circuit") break;
      result.requests += 1;
      audit("earningscalls_request", {
        kind: "transcript",
        symbol,
        eventId: latest.eventId,
        remainingBudget: remainingEarningsCallsBudget(nowMs)
      });
      // Negative-cache ONLY what the provider actually ANSWERED: a successful response with no
      // usable text, or a definitive 404 (call id known, transcript not published). A FAILED
      // request (auth/rate-limit/transient) proves nothing about the transcript — persisting a
      // negative row for it suppressed the re-fetch for the whole negative TTL, so failures
      // now leave no cache row and stay retryable (Codex review, PR #1680).
      if (!body.ok && body.kind !== "not_found") {
        if (body.kind === "auth" || body.kind === "rate_limited" || body.kind === "not_subscribed") {
          result.errors.push(`transcript:${symbol}:${body.kind}`);
          break;
        }
        continue;
      }
      const content = body.ok ? parseEarningsCallsTranscript(body.payload) : undefined;
      upsertEarningsCallsTranscript({
        symbol,
        fiscalYear: period.year,
        fiscalQuarter: period.quarter,
        eventId: latest.eventId,
        eventDate: latest.eventDate,
        content, // undefined => negative-cache row; re-fetch allowed after the negative TTL
        fetchedAt: new Date(nowMs).toISOString(),
        sourceMeta: JSON.stringify({
          source: EARNINGSCALLS_TRANSCRIPT_SOURCE,
          periodBasis: latest.fiscalYear && latest.fiscalQuarter ? "fiscal" : "calendar-from-event-date"
        })
      });
      if (!content) continue;
      result.fetched += 1;
      const row = getEarningsCallsTranscript(symbol, period.year, period.quarter);
      if (row?.content) {
        try {
          if (await ingest(row)) result.ingested += 1;
        } catch (error) {
          result.errors.push(`ingest:${symbol}:${error instanceof Error ? error.name : "error"}`);
        }
      }
    }
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
      remainingBudget: remainingEarningsCallsBudget(nowMs),
      errors: result.errors.slice(0, 10)
    });
  } catch {
    // Best-effort audit.
  }
}
