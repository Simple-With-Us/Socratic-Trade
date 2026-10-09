import { SharePayloadSchema } from "@jaywedgeworth22/congress-trading-shared";
import { z } from "zod";
import { OptionalSchemaVersionSchema } from "./schema-version";

/** Strict inbound body for POST /api/admin/securities/import (shared row shapes, strip unknown keys). */
export const SecuritiesImportPayloadSchema = SharePayloadSchema.extend({
  schemaVersion: OptionalSchemaVersionSchema,
});

export type SecuritiesImportPayload = z.infer<typeof SecuritiesImportPayloadSchema>;

/** Strict JSON contract for POST securities-import responses (success, skip, and error shapes). */
export const SecuritiesImportResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  skipped: z.boolean().optional(),
  reason: z.string().optional(),
  refs: z.number().optional(),
  pricedTickers: z.number().optional(),
  priceRows: z.number().optional(),
  spxRows: z.number().optional(),
  origin: z.string().optional(),
  totals: z
    .object({
      refs: z.number(),
      pricedTickers: z.number(),
      priceRows: z.number(),
      spxRows: z.number(),
    })
    .optional(),
  schemaVersion: OptionalSchemaVersionSchema,
  acceptedNotPersisted: z.record(z.string(), z.number()).optional(),
  note: z.string().optional(),
});

export type SecuritiesImportResponse = z.infer<typeof SecuritiesImportResponseSchema>;
