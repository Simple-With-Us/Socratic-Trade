/** Resolve the as-of stamp every live retrieve must pass so VECTOR_ASOF_STRICT can fire. */

export function resolveRetrievalAsOf(
  explicit?: string | null,
  now: () => string = () => new Date().toISOString()
): string {
  const trimmed = typeof explicit === "string" ? explicit.trim() : "";
  if (trimmed) {
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return now();
}
