import { createHash, randomUUID } from "crypto";
import { getDb } from "./db";
import { isLocalDbFaultMessage, noteLocalDbFault } from "./local-db-fault";
import { isIntentionalOffHealthService } from "./retired-direct-vendors";

// `stoppedWorking` is set for a few distinct reasons (see getServiceHealthSummaries). This one is the
// "5 consecutive failures" condition — the only one strong enough to act on automatically (e.g. the
// enrichment circuit breaker), as opposed to the softer "no success yet this hour" heuristics that a
// single cold failure can trip. Exported so consumers key off the condition, not a brittle string.
export const HEALTH_REASON_CONSECUTIVE_FAILURES = "Last 5 consecutive calls all failed";

/**
 * Prefix written into `error_text` when a failure is an *expected limit* (HTTP 429, daily quota
 * cap, proactive budget exhaustion) rather than a broken integration. No schema column is needed:
 * consecutive-failure STOPPED and the enrichment circuit breaker ignore these rows so a free-tier
 * 25/day provider (or a Yahoo 429 burst) cannot paint the lane red "STOPPED" forever until a
 * success sneaks through. Soft yellow "active this hour, no success" may still apply.
 */
export const HEALTH_SOFT_FAILURE_PREFIX = "[expected-limit] ";

/**
 * True when an api_health_log failure row is a soft/expected limit (rate limit, daily cap, …).
 * Matches both the explicit prefix logApiHealth stamps for `soft: true`, and common free-text
 * shapes from older rows / call sites that forget the flag but still say "HTTP 429".
 */
export function isSoftHealthFailure(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  if (errorText.startsWith(HEALTH_SOFT_FAILURE_PREFIX)) return true;
  // Legacy / free-text shapes that should never hard-STOP a lane on their own.
  return (
    /\bHTTP 429\b/i.test(errorText) ||
    /\brate limit(?:ed|ing)?\b/i.test(errorText) ||
    /\btoo many requests\b/i.test(errorText) ||
    /\bdaily (?:call )?budget exhausted\b/i.test(errorText) ||
    /\bkey pool exhausted\b/i.test(errorText) ||
    /\b25\/day cap\b/i.test(errorText) ||
    /\b25 requests per day\b/i.test(errorText) ||
    /\bproactive daily call budget\b/i.test(errorText)
  );
}

/**
 * FIFO retention for api_health_log: only the newest N rows per (service, key_source) lane survive
 * (enforced on every insert in logApiHealth). Exported because it is NOT just a storage detail — the
 * `callsLastHour`/`callsLast24h` window counts below are computed over this same capped table, so on
 * a busy lane they are a FLOOR, not a total, and any UI that prints them must say so (see
 * ServiceHealthSummary.laneLogCap). Note the equivalence that makes that cheap to detect: a window
 * count can only reach the cap when every retained row falls inside the window, which is exactly the
 * case where older rows may have been evicted out of it -- so `count === cap` is precisely the
 * "saturated" condition, no extra bookkeeping needed. (The residual ambiguity: a lane with exactly
 * `cap` calls and nothing evicted also reads as saturated. "500+" is still true there.)
 */
export const HEALTH_LOG_LANE_CAP = 500;

/**
 * Which condition set `stoppedWorking` (see getServiceHealthSummaries). "consecutive-failures" is
 * the HARD one — the only one strong enough to act on automatically (`app/api/health` fails
 * liveness on it, data-providers.ts trips the enrichment breaker on it). The two "no-success"
 * kinds are SOFT heuristics that a single cold-start failure can trip, and consumers that count or
 * alarm on stopped lanes must weight them below the hard one rather than lumping all three into one
 * number. Carried alongside `stoppedReason` so a client that cannot import this module (the admin
 * connections page is "use client") discriminates on the kind instead of string-matching the prose.
 */
// "expected-limit" is a fourth, ANNOTATION-ONLY kind: never derived from the log here, only
// stamped by surfaces that know a lane is inside a known quota window (e.g. the Pinecone
// monthly write-unit breaker in pinecone-wu-breaker.ts). Clients must render it as SOFT
// (yellow expected-limit), never hard STOPPED.
export type HealthStoppedReasonKind = "consecutive-failures" | "no-success-ever" | "no-success-this-hour" | "expected-limit";
// RAG services (Pinecone, embed, rerank) already get their OWN explicit, operation-scoped alert
// from vector-db.ts's withRagApiHealth -> alertRagConnectionFailure (richer message: which
// operation failed, usage-limit escalation via alertUsageLimitHit, its own 1h cooldown). Without
// this exclusion, logApiHealth's automatic alertConnectionFailure below ALSO fires for the same
// failure (generic "<service> connection failed" text, its own separate 6h cooldown clock) — two
// uncoordinated alerts, ~1s apart, for one underlying event (confirmed 2026-07-07T14:01Z and
// 22:01Z in prod). Keep the richer vector-db.ts alert as the single source of truth for these
// lanes; every OTHER provider (finnhub, tiingo, twelvedata, etc.) has no dedicated alerter, so it
// still needs this generic automatic path.
//
// "voyage"/"voyage-rerank" are the pre-2026-07-19 lane names (still written by
// recordMissingRagKey's missing-API-key path, and possibly present in historical rows/branches in
// flight elsewhere) — kept for back-compat. "rag-embed"/"rag-rerank" are the provider-generic lane
// names withRagApiHealth now uses for actual embed/rerank call failures, so an OpenRouter/
// SiliconFlow-served operation gets the same dedicated-alerting exclusion Voyage always had.
const RAG_SERVICES_WITH_OWN_ALERTING = new Set(["pinecone", "voyage", "voyage-rerank", "rag-embed", "rag-rerank"]);

/**
 * Per-credential-lane health for the API circuit breaker. A "lane" is (service, keySource) — the SAME
 * granularity `getServiceHealthSummaries` and the whole health store already use — NOT per-user, so a
 * globally-dead env key trips once (not per user) and a user's own bad key trips only that user's lane
 * without stopping the shared env lane. `stoppedWorking` reuses the exact predicate below (kept in sync
 * with getServiceHealthSummaries): the last 5 calls all failed, or active-this-hour with no recent
 * success. Read-only; never throws (returns a not-stopped default on any DB error).
 */
export function getLaneHealth(
  service: string,
  keySource: string | null,
  userId?: string | null
): { stoppedWorking: boolean; reason: string | null; lastFailureTs: string | null } {
  try {
    const db = getDb();
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // For a per-USER credential lane (keySource "user"), scope the failure streak to THIS user's own
    // history — otherwise one tenant's 5 failures would trip a provider-degraded alert for every other
    // user sharing the (service, "user") lane. Global/env/none lanes stay aggregate (no user predicate).
    const scopeUser = keySource === "user" && userId != null;
    const userClause = scopeUser ? " AND user_id IS ?" : "";
    const withUser = (params: unknown[]): unknown[] => (scopeUser ? [...params, userId] : params);
    // Pull error_text so expected-limit (soft) failures can be excluded from the HARD consecutive
    // streak — five 429s or a daily-cap row must not trip the enrichment circuit breaker.
    const last5 = db
      .prepare(
        `SELECT ok, error_text FROM api_health_log WHERE service = ? AND key_source IS ?${userClause} ORDER BY ts DESC, rowid DESC LIMIT 5`
      )
      .all(...withUser([service, keySource])) as Array<{ ok: number; error_text: string | null }>;
    const lastSuccess = db
      .prepare(`SELECT ts FROM api_health_log WHERE service = ? AND key_source IS ?${userClause} AND ok = 1 ORDER BY ts DESC, rowid DESC LIMIT 1`)
      .get(...withUser([service, keySource])) as { ts: string } | undefined;
    const lastFailure = db
      .prepare(`SELECT ts FROM api_health_log WHERE service = ? AND key_source IS ?${userClause} AND ok = 0 ORDER BY ts DESC, rowid DESC LIMIT 1`)
      .get(...withUser([service, keySource])) as { ts: string } | undefined;
    const callsLastHour = (
      db.prepare(`SELECT COUNT(*) as cnt FROM api_health_log WHERE service = ? AND key_source IS ?${userClause} AND ts >= ?`).get(...withUser([service, keySource]), hourAgo) as { cnt: number }
    ).cnt;

    let stoppedWorking = false;
    let reason: string | null = null;
    // HARD consecutive-failures: every one of the last 5 rows is a non-soft failure. Soft/expected
    // limits (429, daily cap) alone never set this reason — they may still surface as the softer
    // "no success this hour" heuristics below (yellow DEGRADED, not red STOPPED for circuit trips
    // that only key off HEALTH_REASON_CONSECUTIVE_FAILURES in the enrichment breaker).
    if (
      last5.length >= 5 &&
      last5.every((r) => r.ok === 0 && !isSoftHealthFailure(r.error_text))
    ) {
      stoppedWorking = true;
      reason = HEALTH_REASON_CONSECUTIVE_FAILURES;
    } else if (callsLastHour > 0 && !lastSuccess) {
      stoppedWorking = true;
      reason = "Active in past hour but no successful call ever";
    } else if (callsLastHour > 0 && lastSuccess && lastSuccess.ts < hourAgo) {
      stoppedWorking = true;
      reason = "Active in past hour but no success in 60 min";
    }
    return { stoppedWorking, reason, lastFailureTs: lastFailure?.ts ?? null };
  } catch {
    return { stoppedWorking: false, reason: null, lastFailureTs: null };
  }
}
// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServiceHealthSummary {
  service: string;
  keySource: string | null;
  lastSuccessTs: string | null;
  lastSuccessLatencyMs: number | null;
  lastFailureTs: string | null;
  lastFailureError: string | null;
  /** Calls in the trailing hour / 24h, counted over the CAPPED log (see HEALTH_LOG_LANE_CAP): a
   *  value equal to `laneLogCap` means "at least this many", not "exactly this many". */
  callsLastHour: number;
  callsLast24h: number;
  stoppedWorking: boolean;
  stoppedReason: string | null;
  /** Which condition set `stoppedWorking` — hard vs soft; null when not stopped. Optional so the
   *  admin connections route can keep synthesizing never-used placeholder lanes as plain object
   *  literals (they have no log and no stop state). */
  stoppedReasonKind?: HealthStoppedReasonKind | null;
  /** Row-retention cap the two window counts were computed against, so a caller can render the
   *  saturated case honestly ("500+") without importing this module. Optional for the same
   *  placeholder-lane reason; a lane with no rows cannot be saturated. */
  laneLogCap?: number;
  /**
   * Product-retired vendor lane (FMP / Quiver / UW). Admin Connections must render these as
   * muted OFF — not red STOPPED — and exclude them from the "N stopped" header. Set by the
   * connections-health route from `retired-direct-vendors`; not computed from the log.
   */
  intentionalOff?: boolean;
}

export interface HealthLogRow {
  id: string;
  service: string;
  ts: string;
  ok: number;
  latency_ms: number | null;
  error_text: string | null;
  key_source: string | null;
  user_id: string | null;
}

export interface ErrorPatternRow {
  id: string;
  service: string;
  fingerprint: string;
  error_text: string;
  first_seen: string;
  last_seen: string;
  count: number;
  key_source: string | null;
}

// ── Write ──────────────────────────────────────────────────────────────────────

export function logApiHealth(opts: {
  service: string;
  ok: boolean;
  latencyMs?: number;
  errorText?: string;
  keySource?: string;
  userId?: string;
  // Set ONLY by a caller that knows this failure is a daily-quota exhaustion which cannot
  // recover before a known instant (e.g. Alpha Vantage's 25/day cap resets at midnight
  // America/New_York) — an ISO timestamp of that reset. db-health never derives this itself
  // (no string-matching error text here); it just threads whatever the call site passes
  // through to alertConnectionFailure's cooldown. Omit for ordinary transient failures, which
  // keep the generic fixed-duration cooldown.
  quotaResetAt?: string;
  /**
   * Mark a failure as an *expected limit* (rate limit, daily cap, proactive budget). Soft
   * failures are still stored as ok=0 for forensics, but do not count toward the hard
   * consecutive-failure STOPPED / enrichment circuit trip. Prefer this over inventing a success
   * row for a call that did not succeed.
   */
  soft?: boolean;
}): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const id = randomUUID();
    const keySource = opts.keySource ?? null;
    const userId = opts.userId ?? null;
    // Stamp soft failures with a stable prefix so getLaneHealth / summaries can discriminate
    // without a schema column. Do not double-prefix if the caller already used the marker or
    // if auto-classification would match the free-text shape either way.
    let errorText = opts.errorText ?? null;
    if (!opts.ok && errorText && (opts.soft || isSoftHealthFailure(errorText))) {
      if (!errorText.startsWith(HEALTH_SOFT_FAILURE_PREFIX)) {
        errorText = `${HEALTH_SOFT_FAILURE_PREFIX}${errorText}`;
      }
    }

    db.transaction(() => {
      // Insert log row
      db.prepare(
        `INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, opts.service, now, opts.ok ? 1 : 0, opts.latencyMs ?? null, errorText, keySource, userId);
      // Enforce the FIFO cap of HEALTH_LOG_LANE_CAP rows per (service, key_source) credential lane.
      // The cap has NO user_id predicate, but getLaneHealth scopes its counts to one user on
      // keySource === "user" lanes — so on a multi-tenant user lane one tenant's traffic can evict
      // another tenant's rows and shrink that tenant's callsLastHour. Benign today (the only
      // consumer tests `callsLastHour > 0`, and eviction can only push it toward 0, i.e. the
      // breaker fails open) but do not build anything on those per-user counts being complete.
      // `LIMIT ${...}` interpolates a module constant, never user input.
      db.prepare(
        `DELETE FROM api_health_log
         WHERE service = ? AND key_source IS ?
           AND id NOT IN (
             SELECT id FROM api_health_log
             WHERE service = ? AND key_source IS ?
             ORDER BY ts DESC, rowid DESC
             LIMIT ${HEALTH_LOG_LANE_CAP}
           )`
      ).run(opts.service, keySource, opts.service, keySource);

      // Update error pattern if this is a failure.
      // Use "" (not NULL) as the key_source sentinel so UNIQUE(service,fingerprint,key_source)
      // deduplicates correctly — SQLite NULL values never collide in UNIQUE constraints.
      if (!opts.ok && errorText) {
        const normalized = errorText.trim().toLowerCase().replace(/\s+/g, " ");
        const fingerprint = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
        const patternId = randomUUID();
        const patternKeySource = keySource ?? "";

        db.prepare(
          `INSERT INTO api_health_error_patterns
             (id, service, fingerprint, error_text, first_seen, last_seen, count, key_source)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(service, fingerprint, key_source) DO UPDATE SET
             last_seen = excluded.last_seen,
             count = count + 1`
        ).run(patternId, opts.service, fingerprint, errorText, now, now, patternKeySource);
      }
    })();

    // `isIntentionalOffHealthService`: FMP / Quiver / Unusual Whales are PRODUCT-RETIRED direct
    // lanes (see retired-direct-vendors.ts). Admin Connections already renders them as muted OFF
    // rather than red STOPPED; a residual call site that still touches one must not additionally
    // page the operator about a vendor we deliberately stopped using.
    if (
      !opts.ok &&
      errorText &&
      !RAG_SERVICES_WITH_OWN_ALERTING.has(opts.service) &&
      !isIntentionalOffHealthService(opts.service)
    ) {
      const keySource = opts.keySource ?? null;
      // Soft/expected-limit failures (429 bursts, free-tier caps) normally do not page — they are
      // budget/rate behavior, not a broken integration. Exception: a caller that passes
      // `quotaResetAt` (Alpha Vantage daily-cap exhaustion) wants ONE operator heads-up pinned to
      // the known reset instant, so allow that path through even when the row is soft-stamped.
      // Hard failures still gate on lane health (the HARD consecutive-failure streak only).
      const isSoft = isSoftHealthFailure(errorText);
      if (isSoft && !opts.quotaResetAt) {
        // pure expected-limit with no known reset: no automatic alert
      } else {
        // Scope the streak that gates the alert to this user's own history for user-key lanes, so
        // tenant A's failures don't fire a provider-degraded alert to tenant B on the shared lane.
        const lane = getLaneHealth(opts.service, keySource, opts.userId ?? null);
        // quotaResetAt path: alert once even before a 5-hard streak (the single "pool exhausted"
        // row is enough signal). Otherwise require the HARD streak specifically.
        //
        // Why the hard kind and not bare `stoppedWorking` (the dominant Sentry-noise source,
        // 2026-08-12): `stoppedWorking` is also set by two SOFT heuristics — "active in past hour
        // but no successful call ever" and "…no success in 60 min". On a LOW-FREQUENCY lane (a
        // probe or a once-an-hour scheduled read) the very first transient failure satisfies one
        // of those the instant it lands — one call this hour, zero successes — so a single blip
        // minted a "<service> connection failed" Sentry issue with no streak required at all.
        // Requiring HEALTH_REASON_CONSECUTIVE_FAILURES means five consecutive HARD (non-soft)
        // failures must land first, which a genuine outage produces within minutes and a blip
        // never does. The soft heuristics are untouched — they still paint the lane in Admin
        // Connections; they just no longer page on their own.
        if (opts.quotaResetAt || lane.reason === HEALTH_REASON_CONSECUTIVE_FAILURES) {
          void alertConnectionFailure(opts.service, keySource, opts.userId ?? null, errorText, {
            // Soft/rate-limit-shaped text: skip Sentry (noise); hard outages still capture.
            skipSentry: isSoft || /429|rate limit/i.test(errorText),
            cooldownUntil: opts.quotaResetAt
          });
        }
      }
    }
  } catch {
    // Health logging must never throw — swallow all errors
  }
}
// ── Read ───────────────────────────────────────────────────────────────────────

interface ServiceKeyLane { service: string; key_source: string | null }

function listHealthLanes(): ServiceKeyLane[] {
  try {
    const db = getDb();
    return db
      .prepare(`SELECT DISTINCT service, key_source FROM api_health_log ORDER BY service, key_source`)
      .all() as ServiceKeyLane[];
  } catch {
    return [];
  }
}

export function listHealthServices(): string[] {
  try {
    const db = getDb();
    const rows = db
      .prepare(`SELECT DISTINCT service FROM api_health_log ORDER BY service`)
      .all() as Array<{ service: string }>;
    return rows.map((r) => r.service);
  } catch {
    return [];
  }
}

export function getServiceHealthSummaries(): ServiceHealthSummary[] {
  try {
    const db = getDb();
    const lanes = listHealthLanes();
    const now = Date.now();
    const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    return lanes.map(({ service, key_source: ks }) => {
      const lastSuccess = db
        .prepare(
          `SELECT ts, latency_ms FROM api_health_log
           WHERE service = ? AND key_source IS ? AND ok = 1
           ORDER BY ts DESC, rowid DESC LIMIT 1`
        )
        .get(service, ks) as { ts: string; latency_ms: number | null } | undefined;

      const lastFailure = db
        .prepare(
          `SELECT ts, error_text FROM api_health_log
           WHERE service = ? AND key_source IS ? AND ok = 0
           ORDER BY ts DESC, rowid DESC LIMIT 1`
        )
        .get(service, ks) as { ts: string; error_text: string | null } | undefined;

      const callsLastHour = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM api_health_log
             WHERE service = ? AND key_source IS ? AND ts >= ?`
          )
          .get(service, ks, hourAgo) as { cnt: number }
      ).cnt;

      const callsLast24h = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM api_health_log
             WHERE service = ? AND key_source IS ? AND ts >= ?`
          )
          .get(service, ks, dayAgo) as { cnt: number }
      ).cnt;

      // "Stopped working" detection — scoped per credential lane. Soft/expected-limit failures
      // (429, daily caps) do NOT count toward the hard consecutive-failures kind.
      const last5 = db
        .prepare(
          `SELECT ok, error_text FROM api_health_log
           WHERE service = ? AND key_source IS ?
           ORDER BY ts DESC, rowid DESC LIMIT 5`
        )
        .all(service, ks) as Array<{ ok: number; error_text: string | null }>;

      let stoppedWorking = false;
      let stoppedReason: string | null = null;
      let stoppedReasonKind: HealthStoppedReasonKind | null = null;

      if (
        last5.length >= 5 &&
        last5.every((r) => r.ok === 0 && !isSoftHealthFailure(r.error_text))
      ) {
        stoppedWorking = true;
        stoppedReason = HEALTH_REASON_CONSECUTIVE_FAILURES;
        stoppedReasonKind = "consecutive-failures";
      } else if (callsLastHour > 0 && !lastSuccess) {
        stoppedWorking = true;
        stoppedReason = "Active in past hour but no successful call ever";
        stoppedReasonKind = "no-success-ever";
      } else if (callsLastHour > 0 && lastSuccess && lastSuccess.ts < hourAgo) {
        stoppedWorking = true;
        stoppedReason = "Active in past hour but no success in 60 min";
        stoppedReasonKind = "no-success-this-hour";
      }

      return {
        service,
        keySource: ks,
        lastSuccessTs: lastSuccess?.ts ?? null,
        lastSuccessLatencyMs: lastSuccess?.latency_ms ?? null,
        lastFailureTs: lastFailure?.ts ?? null,
        lastFailureError: lastFailure?.error_text ?? null,
        callsLastHour,
        callsLast24h,
        stoppedWorking,
        stoppedReason,
        stoppedReasonKind,
        laneLogCap: HEALTH_LOG_LANE_CAP,
      };
    });
  } catch {
    return [];
  }
}

// NOTE: `rowid DESC` tiebreaker — `ts` is ms-resolution, so rows written in the same millisecond
// otherwise return in arbitrary order and "the newest row" reads become nondeterministic (bit
// test/data-providers.test.ts's newest-row assertion, 2026-07-10). It must be `rowid` (implicit
// monotonic insertion order; `id TEXT PRIMARY KEY` does not alias it): `id` is a randomUUID, so
// ordering by it is a per-run coin flip, not a tiebreak.
export function getServiceHealthLog(
  service: string,
  limit = 100,
  offset = 0,
  keySource?: string | null
): HealthLogRow[] {
  try {
    const db = getDb();
    if (keySource !== undefined) {
      return db
        .prepare(
          `SELECT id, service, ts, ok, latency_ms, error_text, key_source, user_id
           FROM api_health_log
           WHERE service = ? AND key_source IS ?
           ORDER BY ts DESC, rowid DESC
           LIMIT ? OFFSET ?`
        )
        .all(service, keySource ?? null, limit, offset) as HealthLogRow[];
    }
    return db
      .prepare(
        `SELECT id, service, ts, ok, latency_ms, error_text, key_source, user_id
         FROM api_health_log
         WHERE service = ?
         ORDER BY ts DESC, rowid DESC
         LIMIT ? OFFSET ?`
      )
      .all(service, limit, offset) as HealthLogRow[];
  } catch {
    return [];
  }
}

export function getServiceErrorPatterns(
  service: string,
  keySource?: string | null
): ErrorPatternRow[] {
  try {
    const db = getDb();
    if (keySource !== undefined) {
      // Error patterns use "" sentinel (not NULL) so UNIQUE dedup works; map null → ""
      return db
        .prepare(
          `SELECT id, service, fingerprint, error_text, first_seen, last_seen, count, key_source
           FROM api_health_error_patterns
           WHERE service = ? AND key_source = ?
           ORDER BY last_seen DESC`
        )
        .all(service, keySource ?? "") as ErrorPatternRow[];
    }
    return db
      .prepare(
        `SELECT id, service, fingerprint, error_text, first_seen, last_seen, count, key_source
         FROM api_health_error_patterns
         WHERE service = ?
         ORDER BY last_seen DESC`
      )
      .all(service) as ErrorPatternRow[];
  } catch {
    return [];
  }
}

export function getAllErrorPatterns(): Record<string, ErrorPatternRow[]> {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, service, fingerprint, error_text, first_seen, last_seen, count, key_source
         FROM api_health_error_patterns
         ORDER BY last_seen DESC`
      )
      .all() as ErrorPatternRow[];
    const result: Record<string, ErrorPatternRow[]> = {};
    for (const row of rows) {
      // key_source is "" for no-key services (sentinel), never NULL in error_patterns
      const lane = `${row.service}:${row.key_source ?? ""}`;
      if (!result[lane]) result[lane] = [];
      result[lane].push(row);
    }
    return result;
  } catch {
    return {};
  }
}

// ── Connection Health & Storage Alerts ────────────────────────────────────────

const HEALTH_ALERT_COOLDOWN_PREFIX = "healthAlertSent";
// Default cooldown for an ordinary transient failure. A caller that knows the failure is a
// daily-quota exhaustion (persists until a known reset instant, not just "some hours") overrides
// this per-call via alertConnectionFailure's `opts.cooldownUntil` — see its doc comment.
const HEALTH_ALERT_COOLDOWN_MS = 6 * 60 * 60_000; // 6 hours

const STORAGE_ALERT_COOLDOWN_PREFIX = "storageAlertSent";
const STORAGE_ALERT_COOLDOWN_MS = 12 * 60 * 60_000; // 12 hours

function operatorAlertEmail(): string | undefined {
  return (
    process.env.USAGE_LIMIT_ALERT_EMAIL?.trim() ||
    process.env.ADMIN_ALERT_EMAIL?.trim() ||
    process.env.PRIMARY_USER_EMAIL?.trim() ||
    undefined
  );
}

async function captureHealthSentryMessage(
  level: "warning" | "error",
  message: string,
  context: Record<string, string | number | boolean | null | undefined>
): Promise<void> {
  if (!process.env.SENTRY_DSN) return;
  try {
    const mod = (await import("@sentry/nextjs")) as typeof import("@sentry/nextjs") & {
      default?: typeof import("@sentry/nextjs");
    };
    const captureMessage = mod.captureMessage ?? mod.default?.captureMessage;
    const withScope = mod.withScope ?? mod.default?.withScope;
    if (typeof captureMessage !== "function" || typeof withScope !== "function") return;
    withScope((scope) => {
      scope.setLevel(level);
      scope.setTag("component", "api-health");
      if (context.service) scope.setTag("health.service", String(context.service));
      if (context.keySource) scope.setTag("health.key_source", String(context.keySource));
      // Group by the STABLE lane identifier, not by the rendered message. Sentry's default
      // fingerprint for captureMessage is the message text, and these messages embed a DISPLAY
      // name that drifts ("Voyage" vs "voyage", "OpenRouter" vs "OpenRouter embed") — one lane
      // fragmented into six issues that way. `service` is the health-log service id and never
      // drifts, so grouping survives any future title rewording.
      if (context.service) scope.setFingerprint(["api-health", String(context.service)]);
      scope.setContext("api-health", context);
      captureMessage(message);
    });
  } catch {
    // Observability must not affect trading control flow.
  }
}

/**
 * Raise the generic "<service> connection failed" provider-degraded alert for a lane.
 *
 * A failure whose text is one of OUR OWN SQLite fault shapes never gets here past the
 * isLocalDbFaultMessage guard in the body — defense in depth for every non-RAG lane; the
 * Pinecone/RAG lanes are classified earlier, at withRagApiHealth in vector-db.ts (prod bug
 * 2026-08-09, see docs/rollouts/2026-08-09-pinecone-lock-mislabel.md).
 */
export async function alertConnectionFailure(
  service: string,
  keySource: string | null,
  userId: string | null,
  errorText: string,
  // `cooldownUntil`: an ISO instant a caller passes when it KNOWS this failure won't clear
  // before then (e.g. Alpha Vantage's daily-quota exhaustion, cooldownUntil = next
  // America/New_York midnight reset) — the alert is suppressed until that instant instead of
  // the generic HEALTH_ALERT_COOLDOWN_MS window. Falls back to the generic window when absent,
  // unparsable, or already in the past, so a bad/stale value never shortens the cooldown to
  // "always re-alert" or silences alerts forever.
  opts?: { skipSentry?: boolean; cooldownUntil?: string }
): Promise<void> {
  try {
    const targetUserId = userId || "local";
    const actualKeySource = keySource || "none";
    // Local SQLite contention/misconfiguration incidental to a provider call is OUR fault, not the
    // vendor's. Never let it mint a "<service> connection failed" push; record it under its real
    // cause instead (audit row + threshold-gated "local database contention" advisory).
    if (isLocalDbFaultMessage(errorText)) {
      await noteLocalDbFault({ lane: service, operation: "connection health", message: errorText, userId: targetUserId });
      return;
    }
    // Cool down GLOBAL lanes (env/none) by service+source only — NOT per-user. In a multi-user outage
    // each tenant's failure hits the SAME global dependency, so a userId-scoped cooldown key would let
    // every tenant mint its own cooldown row and re-alert the admin every 6h for the one shared outage.
    // Only per-USER credential lanes ("user") key the cooldown by userId (each user's own key/alert).
    const key =
      actualKeySource === "user"
        ? `${HEALTH_ALERT_COOLDOWN_PREFIX}:${service}:${actualKeySource}:${targetUserId}`
        : `${HEALTH_ALERT_COOLDOWN_PREFIX}:${service}:${actualKeySource}`;

    // Cooldown check. The stored setting value is the "suppressed until" instant (not "last sent
    // at"): this lets a quota-exhaustion caller stretch the window arbitrarily far (to the
    // provider's actual daily reset) while an ordinary transient failure keeps the fixed 6h
    // window, using the exact same comparison. Audit + Sentry stay gated behind this SAME check
    // as the notification (not split into an always-fires audit path) — the per-request
    // api_health_log/error-pattern rows above already record every occurrence for forensics, so
    // an audit row per occurrence here would just duplicate that without adding signal; only the
    // repeat-alert noise is the target of this cooldown.
    const { getInternalSetting, setInternalSetting, audit } = await import("./db");
    const now = Date.now();
    const last = getInternalSetting<string>(key);
    if (last) {
      const suppressedUntilMs = Date.parse(last);
      if (Number.isFinite(suppressedUntilMs) && now < suppressedUntilMs) return;
    }
    const requestedCooldownMs = opts?.cooldownUntil ? Date.parse(opts.cooldownUntil) : NaN;
    const cooldownUntilMs =
      Number.isFinite(requestedCooldownMs) && requestedCooldownMs > now
        ? requestedCooldownMs
        : now + HEALTH_ALERT_COOLDOWN_MS;
    setInternalSetting(key, new Date(cooldownUntilMs).toISOString());

    const isGlobal = actualKeySource !== "user";
    const title = `${service} connection failed`;
    const body = `Connection to ${service} (${actualKeySource} lane) failed: ${errorText}`;

    const payload = {
      service,
      keySource: actualKeySource,
      userId: targetUserId,
      errorText,
      global: isGlobal
    };

    // Log audit event
    audit("connection_health_alert", payload, targetUserId);

    // Send Sentry event
    if (!opts?.skipSentry) {
      await captureHealthSentryMessage(isGlobal ? "error" : "warning", title, {
        service,
        keySource: actualKeySource,
        userSpecific: !isGlobal,
        reason: errorText
      });
    }

    if (isGlobal) {
      // Global failures: Route to admin email and health.
      const { getNotifyPrefs } = await import("./db");
      const prefs = getNotifyPrefs("local");
      const { loadNotifyConfig, notify } = await import("./notify");

      const fallbackEmail = operatorAlertEmail();
      const config = loadNotifyConfig();

      // The operator's own channels are delivered by sendNotification inside the enabled-event
      // gate. The fallback email remains an EXTRA lazy lane when the operator has no usable email
      // preference, so it cannot double-send or bypass that gate.
      const additionalDelivery =
        fallbackEmail && config.email.resendKey && config.email.from && (!prefs.channels.includes("email") || !prefs.email.trim())
          ? () =>
              notify(
                "local",
                { title, body, kind: "provider_degraded", data: payload },
                {
                  config,
                  prefs: {
                    ...prefs,
                    channels: ["email" as any],
                    email: fallbackEmail,
                    updatedAt: prefs.updatedAt
                  }
                }
              )
          : undefined;

      // Also send standard notification. enabledEvents gating is real (owner ruling
      // 2026-08-12: no toggle is silently overridden) — a persisted policy that predates
      // provider_degraded got it backfilled once by the db migration (see
      // backfillDefaultOnNotificationEvents in db.ts); an owner who has since unchecked it stays
      // unchecked.
      const { sendNotification } = await import("./notifications");
      const { getPolicy } = await import("./db");
      const policy = getPolicy("local");
      await sendNotification(
        { type: "provider_degraded", title, payload },
        { userId: "local", policy, directBody: body, notifyDeps: { config }, additionalDelivery }
      ).catch(() => {});
    } else {
      // User-key failures: Route to user notifications only
      const { sendNotification } = await import("./notifications");
      const { getPolicy } = await import("./db");
      const policy = getPolicy(targetUserId);
      await sendNotification(
        { type: "provider_degraded", title, payload },
        { userId: targetUserId, policy, directBody: body }
      ).catch(() => {});
    }
  } catch (err) {
    // Health alerts must never throw
    console.error("Health alert error:", err);
  }
}

export async function alertStorageWarning(warningType: string, message: string): Promise<void> {
  try {
    const key = `${STORAGE_ALERT_COOLDOWN_PREFIX}:${warningType}`;
    const { getInternalSetting, setInternalSetting, audit } = await import("./db");
    const last = getInternalSetting<string>(key);
    if (last && Date.now() - Date.parse(last) < STORAGE_ALERT_COOLDOWN_MS) return;
    setInternalSetting(key, new Date().toISOString());

    const title = `Storage Warning: ${warningType.replace(/_/g, " ")}`;
    const body = message;
    const payload = { warningType, message };

    audit("storage_warning_alert", payload, "local");

    // Route to admin email
    const { getNotifyPrefs } = await import("./db");
    const prefs = getNotifyPrefs("local");
    const { loadNotifyConfig, notify } = await import("./notify");

    const fallbackEmail = operatorAlertEmail();
    const config = loadNotifyConfig();

    const additionalDelivery =
      fallbackEmail && config.email.resendKey && config.email.from && (!prefs.channels.includes("email") || !prefs.email.trim())
        ? () =>
            notify(
              "local",
              { title, body, kind: "storage_warning", data: payload },
              {
                config,
                prefs: {
                  ...prefs,
                  channels: ["email" as any],
                  email: fallbackEmail,
                  updatedAt: prefs.updatedAt
                }
              }
            )
        : undefined;

    // Also send standard notification. enabledEvents gating is real (see the provider_degraded
    // comment above) — storage_warning was likewise backfilled once, not force-included per send.
    const { sendNotification } = await import("./notifications");
    const { getPolicy } = await import("./db");
    const policy = getPolicy("local");
    await sendNotification(
      { type: "storage_warning", title, payload },
      { userId: "local", policy, directBody: body, notifyDeps: { config }, additionalDelivery }
    ).catch(() => {});
  } catch {
    // never throw on warnings
  }
}
