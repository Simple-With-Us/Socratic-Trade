import { SharePayloadSchema } from "@jaywedgeworth22/congress-trading-shared";
import { z } from "zod";
import { sanitizeSchemaVersionString } from "./schema-version";

const SchemaVersionSchema = z
  .union([
    z.number().finite(),
    z
      .string()
      .transform(sanitizeSchemaVersionString)
      .pipe(z.string().min(1).max(64)),
  ])
  .optional();

/** Strict inbound body for POST /api/admin/securities/import (shared row shapes, strip unknown keys). */
export const SecuritiesImportPayloadSchema = SharePayloadSchema.extend({
  schemaVersion: SchemaVersionSchema,
});

export type SecuritiesImportPayload = z.infer<typeof SecuritiesImportPayloadSchema>;
