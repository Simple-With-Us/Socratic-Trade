import { z } from "zod";

export const ApiErrorBodySchema = z.object({ error: z.string() }).strict();

export const ApiKeysListBodySchema = z.object({
  keys: z.array(
    z.object({
      service: z.string(),
      retired: z.boolean().optional(),
      configured: z.boolean().optional(),
      source: z.enum(["user", "env", "none", "retired"]).optional()
    })
  )
});

export const SourceFeaturesPatchOkSchema = z
  .object({
    ok: z.literal(true),
    overrides: z.record(z.string(), z.unknown())
  })
  .strict();
