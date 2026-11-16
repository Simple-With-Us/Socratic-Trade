import { z } from "zod";

/** Strip control chars and bound length for optional schemaVersion envelope fields (log-safe). */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

export function sanitizeSchemaVersionString(raw: string): string {
  return raw.trim().replace(CONTROL_CHARS, "").slice(0, 64);
}

/** Optional envelope `schemaVersion`: finite number or sanitized non-empty string; whitespace-only strings become absent. */
export const OptionalSchemaVersionSchema = z
  .union([z.number().finite(), z.string()])
  .transform((value) => {
    if (typeof value === "number") return value;
    const cleaned = sanitizeSchemaVersionString(value);
    return cleaned.length > 0 ? cleaned : undefined;
  })
  .optional();

export type OptionalSchemaVersion = z.infer<typeof OptionalSchemaVersionSchema>;

/** Tolerant read for outbound/share payloads (not an HTTP trust boundary). */
export function readOptionalSchemaVersionField(raw: unknown): OptionalSchemaVersion {
  const parsed = OptionalSchemaVersionSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data;
}
