// Per-account broker-mutation serialization (oss-lessons §4/§7 slice 3 — the Alpaca-OMS
// discipline: buying-power validation is order-dependent, so ONE mutation sequence at a time
// per account). A thin, lane-aware wrapper over the durable operation-lease primitive.
//
// WHAT IS SERIALIZED: mutation SEQUENCES (a placement window, a cancel-then-place body, a
// stop-monitor read-decide-mutate pass) — never whole lanes. A strategy run deliberates with
// the LLM for minutes; holding a mutation lease across that would starve protective stops
// behind LLM latency, so lanes acquire around their broker-call windows only.
//
// CANCEL DOCTRINE (do not "fix" this by leasing cancels): a standalone cancel can only FREE
// buying power and reduce exposure — it is the emergency lever an operator reaches for when
// something is wedged, and it must never wait behind a lease (see withLivePreflight's cancel
// rationale in broker.ts). The only serialization a cancel ever needs is sequence membership
// when it is the first half of a cancel-then-place — and then the WINDOW holds the lease, not
// the cancel. The manual cancel route emits a receipt when it fires during someone else's
// window (broker_mutation_cancel_during_lease) so the interleave is visible, never blocked.
//
// LOCK HIERARCHY — only BLOCKING acquisitions order strictly downward:
//   1. acquireStrategyLock            (minutes; keyed userId+connectedAccountId)
//   2. broker-mutation lease (THIS)   (seconds; keyed userId+accountNumber)
//   3. row CAS claims                 (claimProposalForExecution / claimSyntheticStop /
//                                      order_replacements state machine — non-blocking
//                                      single-statement fail-fast transactions, DELIBERATELY
//                                      taken INSIDE the lease window: acquiring the lease
//                                      before the claim means a busy skip leaves no row
//                                      behind and burns no cooldown. EXCEPTION: the strategy
//                                      loop's autonomous placement lane (strategy.ts) inserts
//                                      its crash-recovery "placing" intent row BEFORE the lease
//                                      window on purpose — the run ledger records every
//                                      proposal it considered, so a busy exit there mints a
//                                      terminal not_placed row instead of leaving no row behind.
//                                      The approval lane (executeProposal) has no such row to
//                                      insert ahead of the lease and follows the rule as written.)
//   4. broker network calls
// Never take a BLOCKING acquisition (the strategy lock, or a waitMs>0 lease) while holding
// this lease — that is the only ordering that can deadlock.
//
// FAILURE SEMANTICS: busy is an ORDINARY outcome, not an error — periodic lanes skip and the
// next tick retries (their existing in-flight idiom); human-adjacent lanes wait briefly then
// surface an honest busy. Busy must NEVER be classified order_placement_uncertain or count
// toward the broker-health run suppressor: lease contention is not a broker fault and no
// money moved. Ownership lost AFTER the window's work resolved is audited, not thrown — the
// broker mutations happened and must not be booked as a failure.

import { audit } from "./db";
import { getDb } from "./db";
import { getSetting } from "./db-settings";
import {
  runWithOperationLease,
  type BrokerMutationLeaseGroup,
  type OperationLeaseBusy,
  type OperationLeaseClaim
} from "./operation-lease";
import { assertOperationLeaseOwnership } from "./operation-lease";

/** Settings-KV kill switch — flippable in production without a redeploy (the point of a
 *  rollback lever under auto-deploy). Default ON. */
export const ACCOUNT_MUTATION_SERIALIZATION_SETTING = "accountMutationSerialization";

const TTL_MS = 90_000; // > any single broker call window (BROKER_TIMEOUT_MS 15s × a few calls) but
// short enough that a crashed holder delays protective lanes at most ~1.5 scheduler ticks.
const HEARTBEAT_MS = 30_000; // TTL/3, matching the operation-lease default ratio.
const RETRY_POLL_MS = 250;

/** Per-lane bounded waits, exported as a mutable table so route tests can shrink them
 *  (mirrors the ttlMs/heartbeatMs test-override convention). The scheduler's stale-exit
 *  lane WAITS rather than skips: it is dispatched in the same tick pass as the stop
 *  monitor but only reaches its acquisition after a broker read, so a try-once would
 *  deterministically lose that phase race every tick and starve the replacement pump. */
export const LANE_WAITS = {
  /** Human click on /api/orders/replace-market. */
  manualReplace: 10_000,
  /** Scheduler + safety-maintenance stale-exit remediation (outlasts a monitor pass). */
  staleExit: 15_000,
  /** Human click on Approve — human-adjacent: a click may briefly wait. */
  approvalPlacement: 30_000,
  /** Autonomous strategy loop, one proposal — one BROKER_TIMEOUT_MS; the loop can afford
   *  one bounded wait per proposal. */
  strategyPlacement: 15_000
};

export type AccountMutationLane =
  | "stop-monitor"
  | "stale-exit-replacement"
  | "manual-replace"
  | "account-drain"
  | "strategy-placement"
  | "approval-placement";

export interface AccountMutationContext {
  /** Fail closed before a risk-CREATING broker call (a place). Cancels proceed on lease
   *  loss — they are risk-reducing. No-op when serialization is off or the key degenerate. */
  assertOwned(): void;
  /** Aborts when the heartbeat loses ownership mid-window. */
  signal: AbortSignal;
}

export type AccountMutationResult<T> =
  | { acquired: true; value: T; ownershipLostAfterRun?: boolean }
  | { acquired: false; busy: OperationLeaseBusy };

export interface AccountMutationOptions {
  userId: string;
  /** The broker-side account identity — the OMS's own serialization key, present in every
   *  mutation call and every mutation table. */
  accountNumber: string | null | undefined;
  /** Fallback key material when accountNumber is blank (still serialized, receipted). */
  connectedAccountId?: string | null;
  lane: AccountMutationLane;
  /** 0 (default) = try-once, skip-and-retry-next-tick. >0 = bounded wait for human-adjacent lanes. */
  waitMs?: number;
  /** Test-only clock/lease overrides. */
  ttlMs?: number;
  heartbeatMs?: number;
  /** Test-only retry-poll override (default 250ms). */
  pollMs?: number;
}

/** Resolve the lease group for an account. accountNumber is the primary key (see options doc);
 *  a blank accountNumber falls back to `cid:` keying — strictly safer than running unserialized,
 *  still receipted. Both absent ⇒ null (the caller cannot place orders anyway). */
export function brokerMutationLeaseGroup(
  userId: string,
  accountNumber: string | null | undefined,
  connectedAccountId?: string | null
): { group: BrokerMutationLeaseGroup; keyed: "account" | "cid" } | null {
  const acct = (accountNumber ?? "").trim();
  if (acct) return { group: `broker-mutation:${userId}:${acct}`, keyed: "account" };
  const cid = (connectedAccountId ?? "").trim();
  if (cid) return { group: `broker-mutation:${userId}:cid:${cid}`, keyed: "cid" };
  return null;
}

/** In-process registry of groups with a live local claim — powers the advisory backstop in
 *  broker.ts (an unleased placement is receipted, never blocked) and the cancel-route peek. */
const activeLocalClaims: Map<string, number> =
  ((globalThis as Record<string, unknown>).__accountMutationActiveClaims as Map<string, number>) ??
  (() => {
    const map = new Map<string, number>();
    (globalThis as Record<string, unknown>).__accountMutationActiveClaims = map;
    return map;
  })();

export function hasActiveLocalBrokerMutationClaim(
  userId: string,
  accountNumber: string | null | undefined,
  connectedAccountId?: string | null
): boolean {
  const acct = (accountNumber ?? "").trim();
  if (acct && (activeLocalClaims.get(`broker-mutation:${userId}:${acct}`) ?? 0) > 0) return true;
  const cid = (connectedAccountId ?? "").trim();
  if (cid && (activeLocalClaims.get(`broker-mutation:${userId}:cid:${cid}`) ?? 0) > 0) return true;
  return false;
}

/** Read (never acquire) the durable lease record for an account — the cancel-route peek. */
export function peekBrokerMutationLease(
  userId: string,
  accountNumber: string | null | undefined,
  connectedAccountId?: string | null
): { operation: string; expiresAt: string } | null {
  const key = brokerMutationLeaseGroup(userId, accountNumber, connectedAccountId);
  if (!key) return null;
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(`operation_lease:${key.group}`) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { operation?: string; expiresAt?: string };
    if (typeof parsed.expiresAt !== "string" || Date.parse(parsed.expiresAt) <= Date.now()) return null;
    return { operation: parsed.operation ?? "unknown", expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export function accountMutationSerializationEnabled(): boolean {
  return getSetting<boolean>(ACCOUNT_MUTATION_SERIALIZATION_SETTING, true) !== false;
}

const NOOP_CONTEXT: AccountMutationContext = {
  assertOwned: () => {},
  signal: new AbortController().signal
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run one broker-mutation SEQUENCE while holding the account's durable mutation lease.
 * Busy (after waitMs) returns `{acquired: false, busy}` — the caller's skip/409 idiom applies.
 * Serialization off (kill switch) or a fully unkeyed account runs the sequence unserialized
 * with a receipt — never a cage, always visible.
 */
export async function withAccountMutation<T>(
  options: AccountMutationOptions,
  run: (ctx: AccountMutationContext) => Promise<T>
): Promise<AccountMutationResult<T>> {
  const key = brokerMutationLeaseGroup(options.userId, options.accountNumber, options.connectedAccountId);

  if (!accountMutationSerializationEnabled()) {
    return { acquired: true, value: await run(NOOP_CONTEXT) };
  }
  if (!key) {
    audit(
      "account_mutation_unkeyed",
      { lane: options.lane, reason: "no accountNumber and no connectedAccountId — running unserialized" },
      options.userId,
      options.connectedAccountId ?? undefined
    );
    return { acquired: true, value: await run(NOOP_CONTEXT) };
  }
  if (key.keyed === "cid") {
    audit(
      "account_mutation_unkeyed",
      { lane: options.lane, reason: "blank accountNumber — serialized under cid fallback key" },
      options.userId,
      options.connectedAccountId ?? undefined
    );
  }

  const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
  const operation = `${options.lane}`;

  for (;;) {
    let runResolved = false;
    let runValue: T | undefined;
    let attempt: Awaited<ReturnType<typeof runWithOperationLease<T>>>;
    try {
      attempt = await runWithOperationLease<T>(
        { group: key.group, operation, ttlMs: options.ttlMs ?? TTL_MS, heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS },
        async (claim: OperationLeaseClaim, signal: AbortSignal) => {
          activeLocalClaims.set(key.group, (activeLocalClaims.get(key.group) ?? 0) + 1);
          try {
            const value = await run({
              assertOwned: () => assertOperationLeaseOwnership(claim),
              signal
            });
            runResolved = true;
            runValue = value;
            return value;
          } finally {
            const count = (activeLocalClaims.get(key.group) ?? 1) - 1;
            if (count <= 0) activeLocalClaims.delete(key.group);
            else activeLocalClaims.set(key.group, count);
          }
        }
      );
    } catch (error) {
      // The lease's success-boundary ownership assert throws AFTER `run` resolved when the
      // heartbeat lost the lease during a long await. The broker mutations in the window
      // HAPPENED — booking them as failure would be dishonest. Audit and return the value.
      if (runResolved) {
        audit(
          "account_mutation_lost",
          { lane: options.lane, group: key.group, phase: "post_success", reason: error instanceof Error ? error.message : String(error) },
          options.userId,
          options.connectedAccountId ?? undefined
        );
        return { acquired: true, value: runValue as T, ownershipLostAfterRun: true };
      }
      throw error;
    }

    if (attempt.acquired) {
      if (attempt.tookOverExpired) {
        // Crash/stall evidence: this acquisition displaced an EXPIRED holder's record — the
        // previous window died without releasing (process crash, event-loop stall past TTL).
        audit(
          "broker_mutation_takeover_expired",
          {
            lane: options.lane,
            group: key.group,
            expiredOperation: attempt.tookOverExpired.operation,
            expiredAt: attempt.tookOverExpired.expiresAt
          },
          options.userId,
          options.connectedAccountId ?? undefined
        );
      }
      return { acquired: true, value: attempt.value };
    }

    if (Date.now() >= deadline) {
      audit(
        "account_mutation_busy",
        {
          lane: options.lane,
          group: key.group,
          activeOperation: attempt.busy.activeOperation,
          retryAfterSeconds: attempt.busy.retryAfterSeconds,
          waitedMs: Math.max(0, options.waitMs ?? 0)
        },
        options.userId,
        options.connectedAccountId ?? undefined
      );
      return { acquired: false, busy: attempt.busy };
    }
    await sleep(Math.min(options.pollMs ?? RETRY_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}
