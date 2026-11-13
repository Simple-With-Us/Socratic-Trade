/**
 * Inbound POST /api/keys body.  Domain checks (catalog service, plan-tier options, route
 * eligibility) still run after this parse.  `.strict()` rejects unknown keys.  The Zod error
 * is never returned or logged, so a submitted apiKey value cannot leak into the 400 envelope.
 *
 * Lives here, not in `app/api/keys/route.ts`, because Next.js route modules may only export
 * HTTP handlers and a fixed set of config keys.
 */
import "server-only";
import { z } from "zod";

export const KeyUpsertSchema = z
  .object({
    service: z.string().optional(),
    apiKey: z.string().optional(),
    label: z.string().nullable().optional(),
    planTier: z.string().nullable().optional(),
    route: z.string().optional(),
    // Accepted for client compatibility; identity comes only from middleware headers.
    userId: z.string().optional()
  })
  .strict();
