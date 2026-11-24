// In-process pub/sub for server→client dashboard PUSH (Server-Sent Events).
//
// Replaces the browser's 30s `/api/dashboard` poll: the server already knows when the
// dashboard-relevant state changes (a strategy run finished, an order was placed), so it
// pushes a small event and the client refreshes on demand instead of polling blindly.
//
// Scope/limits: this is a single-Node-process bus (the PM2 `next start`/`next dev` runtime
// that also hosts the scheduler). The scheduler/strategy code emits; the SSE route subscribes
// — they share this module instance. It is NOT durable and does NOT fan out across processes;
// for multi-process/multi-host later, back this with Redis pub/sub or Postgres LISTEN/NOTIFY.

export type DashboardEventType = "run-complete" | "proposal" | "order" | "market-data" | "dirty" | "pending-learned-change" | "chat-turn";

/**
 * Event types that are genuinely global when untagged (no `userId`): every subscriber may
 * receive them. Enumerated from the untagged emit sites - `dirty` (regime-watch macro flip,
 * admin emit-test) and `market-data` (shared-cache history fill in history.ts, whose detail
 * carries only kind/counts, no symbol or per-user data). Every other emit site tags `userId`;
 * an UNTAGGED event of any other type (e.g. a future order/proposal emitter that forgets the
 * tag) must never cross tenants, so it is dropped for everyone.
 */
export const GLOBAL_DASHBOARD_EVENT_TYPES: ReadonlySet<DashboardEventType> = new Set(["dirty", "market-data"]);

/** Server-side tenant filter for SSE fan-out: tagged events go only to their owner;
 * untagged events go only to everyone when their type is allowlisted above. */
export function shouldDeliverDashboardEvent(event: DashboardEvent, subscriberId: string): boolean {
  if (event.userId) return event.userId === subscriberId;
  return GLOBAL_DASHBOARD_EVENT_TYPES.has(event.type);
}

export interface DashboardEvent {
  type: DashboardEventType;
  /** Owner the event pertains to (so a client can ignore events for other users). */
  userId?: string;
  /** ISO timestamp set by the emitter. */
  at: string;
  /** Optional small payload (counts/ids) — never the full snapshot. */
  detail?: Record<string, unknown>;
}

type Listener = (event: DashboardEvent) => void;

// Plain Set (not an EventEmitter) so many open dashboard tabs don't trip the default
// max-listeners warning, and so a throwing subscriber can never break emit for the others.
//
// Pinned to globalThis: Next.js can bundle different route handlers into separate module
// instances within the same Node process, so a plain module-level `const` would give the SSE
// route and the emitting route DIFFERENT Sets (observed live: emit saw 0 subscribers). The
// globalThis singleton guarantees every importer shares one Set.
const globalForEvents = globalThis as unknown as { __dashboardListeners?: Set<Listener> };
const listeners: Set<Listener> = globalForEvents.__dashboardListeners ?? (globalForEvents.__dashboardListeners = new Set<Listener>());

export function subscribeDashboardEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitDashboardEvent(event: DashboardEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A bad subscriber must never break the emit loop for the rest.
    }
  }
}

export function dashboardSubscriberCount(): number {
  return listeners.size;
}
