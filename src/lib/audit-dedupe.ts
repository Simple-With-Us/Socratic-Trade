// audit-dedupe.ts — write-amplification guard for steady-state audit events.
//
// Production finding (2026-08-01): steady-state "skipped/no-op" audits fired
// once per scheduler tick per position — `broker_protective_stop_skipped`
// ~14k/day (the SAME "no uncovered whole shares" note for the same 5 symbols,
// every 60s for weeks) and `fill_reconciliation_pending_price` ~4.5k/day.
// 97k+31k identical-in-substance rows per week is pure write amplification:
// it bloats audit_events (718 MB, half the DB), drives WAL churn into the R2
// backup stream, and buries the events that actually changed.
//
// `auditDeduped` logs the FIRST occurrence of a signature immediately, then at
// most once per `minIntervalMs` while the same condition persists. A condition
// ENDING (signature absent) is free — nothing to log (the lane's recovery
// events already cover state changes). Watermark lives in the settings KV, so
// it survives restarts; it is deliberately NOT exact-on-crash (a crash may
// re-log once — acceptable, still ~1000x quieter).

import { audit } from "./db";
import { getInternalSetting, setInternalSetting } from "./db-settings";

const KEY_PREFIX = "auditdedupe:";
export const DEFAULT_DEDUPE_INTERVAL_MS = 6 * 3600_000; // 6h

export interface AuditDedupeDeps {
  now?: number;
  auditImpl?: typeof audit;
  getWatermark?: (key: string) => string | undefined;
  setWatermark?: (key: string, value: string) => void;
}

/**
 * Log `audit(kind, payload, ...)` only if this exact signature
 * (kind + every signaturePart joined) hasn't been logged within
 * `minIntervalMs`. Returns true when the event was actually written.
 */
export function auditDeduped(
  kind: string,
  payload: unknown,
  signatureParts: readonly (string | number | null | undefined)[],
  opts: {
    userId?: string;
    connectedAccountId?: string;
    minIntervalMs?: number;
  } = {},
  deps: AuditDedupeDeps = {},
): boolean {
  const now = deps.now ?? Date.now();
  const signature = `${kind}|${signatureParts.map((p) => String(p ?? "")).join("|")}`;
  const key = `${KEY_PREFIX}${signature}`;
  const getW = deps.getWatermark ?? ((k: string) => getInternalSetting<string>(k));
  const setW = deps.setWatermark ?? ((k: string, v: string) => setInternalSetting(k, v));

  const last = getW(key);
  if (last) {
    const lastMs = Date.parse(last);
    if (Number.isFinite(lastMs) && now - lastMs < (opts.minIntervalMs ?? DEFAULT_DEDUPE_INTERVAL_MS)) {
      return false;
    }
  }
  setW(key, new Date(now).toISOString());
  (deps.auditImpl ?? audit)(kind, payload, opts.userId ?? "local", opts.connectedAccountId);
  return true;
}
