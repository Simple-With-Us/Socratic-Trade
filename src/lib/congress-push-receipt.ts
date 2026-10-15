import { z } from "zod";
import type { ApplyResult } from "./congress-trade-events";

/** Wire version for App B webhook responses to App A push deliveries. */
export const CONGRESS_PUSH_RECEIPT_VERSION = 1;

const nonNegativeInt = z.number().int().nonnegative();

export const CongressPushReceiptEventSchema = z
  .object({
    ok: z.boolean(),
    consumed: z.boolean(),
    type: z.string().trim().min(1).optional(),
    eventId: z.string().trim().min(1).optional(),
    applied: nonNegativeInt,
    duplicate: z.boolean().optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

export type CongressPushReceiptEvent = z.infer<typeof CongressPushReceiptEventSchema>;

export const CongressPushReceiptSchema = z
  .object({
    receiptVersion: z.literal(CONGRESS_PUSH_RECEIPT_VERSION),
    delivered: z.literal(true),
    consumed: z.boolean(),
    ok: z.boolean(),
    type: z.string().trim().min(1).optional(),
    eventId: z.string().trim().min(1).optional(),
    applied: nonNegativeInt,
    duplicate: z.boolean().optional(),
    reason: z.string().trim().min(1).optional(),
    count: nonNegativeInt.optional(),
    results: z.array(CongressPushReceiptEventSchema).optional(),
  })
  .strict();

export type CongressPushReceipt = z.infer<typeof CongressPushReceiptSchema>;

function eventConsumed(result: ApplyResult): boolean {
  return result.ok === true;
}

export function buildCongressPushReceiptEvent(result: ApplyResult, eventId?: string): CongressPushReceiptEvent {
  const consumed = eventConsumed(result);
  return CongressPushReceiptEventSchema.parse({
    ok: result.ok,
    consumed,
    type: result.type,
    eventId,
    applied: result.applied,
    duplicate: result.duplicate,
    reason: result.reason,
  });
}

export function buildCongressPushReceipt(result: ApplyResult, eventId?: string): CongressPushReceipt {
  const event = buildCongressPushReceiptEvent(result, eventId);
  return CongressPushReceiptSchema.parse({
    receiptVersion: CONGRESS_PUSH_RECEIPT_VERSION,
    delivered: true,
    consumed: event.consumed,
    ok: event.ok,
    type: event.type,
    eventId: event.eventId,
    applied: event.applied,
    duplicate: event.duplicate,
    reason: event.reason,
  });
}

export function buildCongressPushBatchReceipt(
  results: ApplyResult[],
  eventIds?: (string | undefined)[],
): CongressPushReceipt {
  const lines = results.map((result, index) => buildCongressPushReceiptEvent(result, eventIds?.[index]));
  const consumed = lines.every((line) => line.consumed);
  const ok = lines.every((line) => line.ok);
  const applied = lines.reduce((sum, line) => sum + line.applied, 0);
  return CongressPushReceiptSchema.parse({
    receiptVersion: CONGRESS_PUSH_RECEIPT_VERSION,
    delivered: true,
    consumed,
    ok,
    applied,
    count: lines.length,
    results: lines,
  });
}

export function resolveCongressEventId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const rec = body as { id?: unknown; events?: unknown };
  if (typeof rec.id === "string" && rec.id.trim()) return rec.id.trim();
  if (Array.isArray(rec.events) && rec.events.length > 0) {
    const first = rec.events[0];
    if (first && typeof first === "object" && typeof (first as { id?: unknown }).id === "string") {
      return ((first as { id: string }).id).trim();
    }
  }
  return undefined;
}

/** Parallel to `events[]` — preserves index alignment when some envelopes omit `id`. */
export function resolveCongressEventIds(body: unknown): (string | undefined)[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const rec = body as { events?: unknown };
  if (!Array.isArray(rec.events)) return undefined;
  return rec.events.map((event) => {
    const raw = event && typeof event === "object" ? (event as { id?: unknown }).id : undefined;
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  });
}
