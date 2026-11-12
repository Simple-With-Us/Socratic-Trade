import { createHash } from "crypto";

// Idempotent receipt for a Congress.Trade -> Socratic-Trade share push.
// Congress.Trade sends `x-push-id` (and the same id in the JSON body).  This
// app answers with that id, a delivered ack, and a consumed ack.  `health` is
// `ok` only when the id and both acks are present.  A missing ack is the
// alert case.  The same function is duplicated in Congress.Trade
// `app/src/share/peerPushReceipt.ts`; keep the health names in lockstep.

export const PEER_PUSH_ID_HEADER = "x-push-id";

export const PEER_PUSH_HEALTH = [
  "ok",
  "missing-push-id",
  "missing-delivered-ack",
  "missing-consumed-ack",
] as const;

export type PeerPushHealth = (typeof PEER_PUSH_HEALTH)[number];

export interface PeerPushAck {
  at: string;
  ok: boolean;
  reason?: string;
}

export interface PeerPushAcks {
  delivered: PeerPushAck | null;
  consumed: PeerPushAck | null;
}

const PUSH_ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

/** A valid header wins.  An empty or junk header falls through to a valid body id. */
export function resolvePeerPushId(headerValue: string | null | undefined, bodyValue: unknown): string | null {
  const header = typeof headerValue === "string" ? headerValue.trim() : "";
  const body = typeof bodyValue === "string" ? bodyValue.trim() : "";
  if (PUSH_ID_RE.test(header)) return header;
  if (PUSH_ID_RE.test(body)) return body;
  return null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Stable hash of the parsed import body.  Same payload, same hash. */
export function peerPushPayloadHash(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export function isPeerPushHealth(value: string): value is PeerPushHealth {
  return (PEER_PUSH_HEALTH as readonly string[]).includes(value);
}

/**
 * Delivered is checked first, then consumed, then the push id.  An ack object
 * that is present counts even when `ok` is false.  Missing means the field
 * is null.  A push with both acks and no id is `missing-push-id`.
 */
export function peerPushHealth(input: {
  pushId: string | null;
  delivered: PeerPushAck | null;
  consumed: PeerPushAck | null;
}): PeerPushHealth {
  if (!input.delivered) return "missing-delivered-ack";
  if (!input.consumed) return "missing-consumed-ack";
  if (!input.pushId) return "missing-push-id";
  return "ok";
}
