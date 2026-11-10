import { rateLimit, type RateLimitOptions } from "./rate-limit";
import { resolveRequestUserId } from "./request-user";
import { withTuningSingleFlight } from "./tuning-singleflight";
import { operationInFlightResponse, rateLimitedOperationResponse } from "./operation-guard-response";
import {
  OPERATION_LEASE_GROUPS,
  runWithOperationLease,
  type OperationLeaseClaim,
  type OperationLeaseGroup
} from "./operation-lease";

type ConcurrencyScope = "admin" | "manual-admin";

interface StandardAdminOperationLimit extends RateLimitOptions {
  /** Operations sharing a group cannot overlap within the configured scope. */
  concurrencyGroup: string;
  /** Across manual admin requests for shared work; per admin for user-scoped analysis or probes. */
  concurrencyScope: ConcurrencyScope;
}

interface SharedTuningOperationLimit extends RateLimitOptions {
  sharedSingleFlight: "tuning";
}

type AdminOperationLimit = StandardAdminOperationLimit | SharedTuningOperationLimit;

/**
 * Interactive-admin budgets: generous enough for normal retries, tight enough that a stuck UI,
 * script, or duplicate click cannot repeatedly fan out into paid providers or long DB scans.
 * Rate limits are per authenticated admin even when the in-flight exclusion is global.
 */
export const ADMIN_OPERATION_LIMITS = {
  "reindex-8k": { limit: 2, windowMs: 60 * 60_000, concurrencyGroup: "rag-reindex", concurrencyScope: "manual-admin" },
  "reindex-10k": { limit: 2, windowMs: 60 * 60_000, concurrencyGroup: "rag-reindex", concurrencyScope: "manual-admin" },
  "backtest-ic": { limit: 10, windowMs: 5 * 60_000, concurrencyGroup: "backtest-ic", concurrencyScope: "admin" },
  "tuning-dry-run": { limit: 6, windowMs: 10 * 60_000, sharedSingleFlight: "tuning" },
  "congress-score-eval": { limit: 6, windowMs: 10 * 60_000, concurrencyGroup: "congress-score-eval", concurrencyScope: "admin" },
  "congress-share": { limit: 2, windowMs: 60 * 60_000, concurrencyGroup: "congress-share", concurrencyScope: "manual-admin" },
  "refresh-websource": { limit: 4, windowMs: 10 * 60_000, concurrencyGroup: "refresh-websource", concurrencyScope: "manual-admin" },
  "robinhood-probe": { limit: 20, windowMs: 5 * 60_000, concurrencyGroup: "robinhood-probe", concurrencyScope: "admin" },
  "sec-ingest-seed": { limit: 6, windowMs: 60 * 60_000, concurrencyGroup: "sec-ingest-seed", concurrencyScope: "manual-admin" },
  // Shares the RAG_REINDEX durable group with the scheduled EarningsCalls pass (and every other
  // Voyage/Pinecone-spending producer) — a manual burst/probe/clear-block action must never race
  // the scheduler's own daily pass or another reindex job into duplicate embedding spend.
  "earningscalls": { limit: 10, windowMs: 10 * 60_000, concurrencyGroup: "earningscalls", concurrencyScope: "manual-admin" }
} as const satisfies Record<string, AdminOperationLimit>;

export type AdminOperationName = keyof typeof ADMIN_OPERATION_LIMITS;

export interface AdminOperationGuardOptions {
  /** Required for refresh-websource because Congress and SEC 8-K own distinct durable datasets. */
  durableGroup?: OperationLeaseGroup;
}

const FIXED_DURABLE_GROUPS: Partial<Record<AdminOperationName, OperationLeaseGroup>> = {
  "reindex-8k": OPERATION_LEASE_GROUPS.RAG_REINDEX,
  "reindex-10k": OPERATION_LEASE_GROUPS.RAG_REINDEX,
  "congress-share": OPERATION_LEASE_GROUPS.CONGRESS_SHARE,
  "sec-ingest-seed": OPERATION_LEASE_GROUPS.SEC_INGEST_SEED,
  "earningscalls": OPERATION_LEASE_GROUPS.RAG_REINDEX
};

type AdminOperationGuardHost = typeof globalThis & {
  __socraticAdminOperationsInFlight?: Map<string, { operation: AdminOperationName; token: symbol }>;
};

const guardHost = globalThis as AdminOperationGuardHost;
const inFlight = (guardHost.__socraticAdminOperationsInFlight ??= new Map());

/**
 * Only call this after `requireAdmin` succeeds. `resolveRequestUserId` consumes the trusted
 * middleware-established email header and ignores query/body/user-id hints. Token-only and local-dev
 * admin calls intentionally collapse to the stable primary-operator `local` identity.
 */
export function adminOperationIdentity(request: Request): string {
  return resolveRequestUserId(request);
}

function concurrencyKey(identity: string, operation: AdminOperationName): string {
  const config = ADMIN_OPERATION_LIMITS[operation];
  if (!("concurrencyGroup" in config)) throw new Error(`Admin operation ${operation} uses a shared single-flight guard.`);
  const scope = config.concurrencyScope === "manual-admin" ? "manual-admin" : `admin:${identity}`;
  return `${scope}:${config.concurrencyGroup}`;
}

/**
 * Apply the named per-admin budget and a process-wide single-flight guard around expensive work.
 * The in-flight entry is always released, including when the operation throws.
 */
export async function withAdminOperationGuard(
  request: Request,
  operation: AdminOperationName,
  run: (claim?: OperationLeaseClaim) => Promise<Response>,
  options: AdminOperationGuardOptions = {}
): Promise<Response> {
  const identity = adminOperationIdentity(request);
  const config = ADMIN_OPERATION_LIMITS[operation];

  if ("sharedSingleFlight" in config) {
    return withTuningSingleFlight(identity, "tuning-dry-run", async () => {
      const admission = rateLimit(`${identity}:admin:${operation}`, config);
      if (!admission.allowed) {
        return rateLimitedOperationResponse(
          operation,
          admission.retryAfterSeconds,
          `Rate limit exceeded for admin operation "${operation}". Please retry shortly.`
        );
      }
      return run();
    });
  }

  const durableGroup = options.durableGroup ?? FIXED_DURABLE_GROUPS[operation];
  if (durableGroup) {
    const guarded = await runWithOperationLease(
      { group: durableGroup, operation },
      async (claim) => {
        // The durable claim is the admission serialization point. Debit the per-admin budget only
        // after it succeeds, then pass the opaque capability into the underlying core boundary so
        // that boundary reuses (rather than conflicts with) the already-held lease.
        const admission = rateLimit(`${identity}:admin:${operation}`, config);
        if (!admission.allowed) {
          return rateLimitedOperationResponse(
            operation,
            admission.retryAfterSeconds,
            `Rate limit exceeded for admin operation "${operation}". Please retry shortly.`
          );
        }
        return run(claim);
      }
    );
    if (!guarded.acquired) {
      return operationInFlightResponse(
        operation,
        guarded.busy.activeOperation,
        `Admin operation "${operation}" conflicts with "${guarded.busy.activeOperation}", which is already running.`,
        { operationGroup: guarded.busy.group, retryAfterSeconds: guarded.busy.retryAfterSeconds }
      );
    }
    return guarded.value;
  }

  const flightKey = concurrencyKey(identity, operation);
  const active = inFlight.get(flightKey);
  if (active) {
    return operationInFlightResponse(
      operation,
      active.operation,
      `Admin operation "${operation}" conflicts with "${active.operation}", which is already running.`
    );
  }

  const token = Symbol(operation);
  inFlight.set(flightKey, { operation, token });
  try {
    // Claim before debiting quota: duplicate spam returns 409 without consuming the accepted
    // entrant's budget. Claim + admission are synchronous, so expensive work never starts before
    // both decisions are complete.
    const admission = rateLimit(`${identity}:admin:${operation}`, config);
    if (!admission.allowed) {
      return rateLimitedOperationResponse(
        operation,
        admission.retryAfterSeconds,
        `Rate limit exceeded for admin operation "${operation}". Please retry shortly.`
      );
    }
    return await run();
  } finally {
    // Owner-check the release so a test reset/hot-reload edge cannot let an old operation clear a
    // successor's claim on the same group.
    if (inFlight.get(flightKey)?.token === token) inFlight.delete(flightKey);
  }
}

/** Test/maintenance hook; does not reset the shared rate limiter. */
export function resetAdminOperationInFlight(): void {
  inFlight.clear();
}
