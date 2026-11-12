/**
 * Sentry warning threshold for the oldest granted proxy-gate slot.
 * Lives outside `proxy-fetch.ts` so `sentry-metrics.ts` can share it
 * without loading undici. The hold clock starts when the slot is granted,
 * before headers, so a stuck header wait can pass this even though a
 * post-header body is capped at PROXY_SLOT_MAX_HOLD_MS.
 */
export const PROXY_GATE_HOLD_ALERT_MS = 60_000;
