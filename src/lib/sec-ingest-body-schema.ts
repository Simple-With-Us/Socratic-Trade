/**
 * Inbound POST /api/admin/sec-ingest body.
 * `.strict()` rejects unknown keys. Parse with safeParse and reject with 400
 * `invalid_payload` before the rate limit or the seed/requeue service.
 * `offset` and `limit` accept a number or a numeric string (the previous
 * `Number(body.offset)` behavior) and reject an empty or non-numeric string.
 *
 * Lives here, not in `app/api/admin/sec-ingest/route.ts`, because Next.js route
 * modules may only export HTTP handlers and a fixed set of config keys.
 */
import { z } from "zod";

/** Coerce a quoted numeric string, but do not turn "" or non-numeric values into 0. */
const optionalNonnegInt = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && /^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return value;
  }
  return value;
}, z.number().int().nonnegative().optional());

export const SecIngestBodySchema = z
  .object({
    action: z.enum(["seed", "requeue-dead-letter"]),
    offset: optionalNonnegInt,
    limit: optionalNonnegInt,
    ciks: z.array(z.string().min(1)).optional()
  })
  .strict();

export type SecIngestBody = z.infer<typeof SecIngestBodySchema>;
