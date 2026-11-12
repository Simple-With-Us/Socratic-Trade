/**
 * Inbound POST /api/admin/sec-ingest body.
 * `.strict()` rejects unknown keys. Parse with safeParse and reject with 400
 * `invalid_payload` before the rate limit or the seed/requeue service.
 *
 * Lives here, not in `app/api/admin/sec-ingest/route.ts`, because Next.js route
 * modules may only export HTTP handlers and a fixed set of config keys.
 */
import { z } from "zod";

export const SecIngestBodySchema = z
  .object({
    action: z.enum(["seed", "requeue-dead-letter"]),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().nonnegative().optional(),
    ciks: z.array(z.string().min(1)).optional()
  })
  .strict();

export type SecIngestBody = z.infer<typeof SecIngestBodySchema>;
