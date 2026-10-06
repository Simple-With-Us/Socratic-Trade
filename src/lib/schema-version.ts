/** Strip control chars and bound length for optional schemaVersion envelope fields (log-safe). */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

export function sanitizeSchemaVersionString(raw: string): string {
  return raw.trim().replace(CONTROL_CHARS, "").slice(0, 64);
}

export function readOptionalSchemaVersionField(
  raw: unknown
): string | number | undefined {
  if (typeof raw === "string") {
    const cleaned = sanitizeSchemaVersionString(raw);
    return cleaned.length > 0 ? cleaned : undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return undefined;
}
