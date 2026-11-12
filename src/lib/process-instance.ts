// Stable per-process instance id.  Pinned to globalThis so Next.js HMR re-evaluating this
// module does NOT mint a new id and silently orphan a scheduler lease this process holds.
//
// Shared by the scheduler lease (`LEASE_OWNER`) and `strategy_runs.owner_instance`.  Kept free
// of a `db` import so `db-execution` can stamp runs without a db -> scheduler-lease -> db cycle.
// `globalThis.crypto.randomUUID` is the Web Crypto API (Node 19+ and browsers).  Do not import
// node `crypto` here: `db-execution` is reachable from the browser bundle.

const ownerHost = globalThis as unknown as { __schedulerLeaseOwner?: string };

function mintProcessInstanceId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const pid = typeof process !== "undefined" && typeof process.pid === "number" ? process.pid : 0;
  return `${pid}:${uuid}`;
}

export const PROCESS_INSTANCE_ID: string =
  ownerHost.__schedulerLeaseOwner ?? (ownerHost.__schedulerLeaseOwner = mintProcessInstanceId());
