/**
 * App B (Socratic Trade) webhook consumption receipts for App A outbound pushes.
 * Mirrors congress-trading-shared pushReceipt.ts (ST-3846).
 */

import { z } from 'zod';

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

export interface CongressPushApplyLike {
  ok: boolean;
  type?: string;
  applied: number;
  reason?: string;
  duplicate?: boolean;
}

function eventConsumed(result: CongressPushApplyLike): boolean {
  return result.ok === true;
}

function buildReceiptEvent(result: CongressPushApplyLike, eventId?: string): CongressPushReceiptEvent {
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

function buildReceipt(result: CongressPushApplyLike, eventId?: string): CongressPushReceipt {
  const event = buildReceiptEvent(result, eventId);
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

function buildBatchReceipt(results: CongressPushApplyLike[]): CongressPushReceipt {
  const lines = results.map((result) => buildReceiptEvent(result));
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

export type ParseCongressPushReceiptResult =
  | { ok: true; receipt: CongressPushReceipt }
  | { ok: false; reason: string };

export function parseCongressPushReceipt(payload: unknown): ParseCongressPushReceiptResult {
  const versioned = CongressPushReceiptSchema.safeParse(payload);
  if (versioned.success) {
    return { ok: true, receipt: versioned.data };
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'push response body was empty or unparseable' };
  }

  const legacy = payload as CongressPushApplyLike & { results?: CongressPushApplyLike[] };
  if (Array.isArray(legacy.results)) {
    return { ok: true, receipt: buildBatchReceipt(legacy.results) };
  }

  if (typeof legacy.ok !== 'boolean' || typeof legacy.applied !== 'number') {
    return { ok: false, reason: 'push response missing receiptVersion and legacy ok/applied fields' };
  }

  return { ok: true, receipt: buildReceipt(legacy) };
}

export function congressPushReceiptFailureReason(parsed: ParseCongressPushReceiptResult): string | null {
  if (!parsed.ok) return parsed.reason;
  if (parsed.receipt.consumed) return null;
  const firstBad = parsed.receipt.results?.find((line) => !line.consumed);
  if (firstBad?.reason) return `consumption failed: ${firstBad.reason}`;
  if (parsed.receipt.reason) return `consumption failed: ${parsed.receipt.reason}`;
  return 'consumption failed: ok=false';
}

/** Max bytes to read from App B's webhook response body when validating consumption. */
export const WEBHOOK_PUSH_RECEIPT_MAX_BYTES = 32_768;

export async function readWebhookPushReceipt(response: Response): Promise<ParseCongressPushReceiptResult> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return { ok: false, reason: 'push response missing JSON content-type' };
  }
  const text = await response.text();
  if (text.length > WEBHOOK_PUSH_RECEIPT_MAX_BYTES) {
    return { ok: false, reason: 'push response body too large' };
  }
  if (!text.trim()) {
    return { ok: false, reason: 'push response body was empty or unparseable' };
  }
  try {
    return parseCongressPushReceipt(JSON.parse(text));
  } catch {
    return { ok: false, reason: 'push response body was not valid JSON' };
  }
}
