/**
 * Recursively delete keys whose value is `null` from a policy object (in place), so a client clearing an
 * optional field (sent as `null` to survive JSON) becomes an ABSENT key: the guard is off / default.
 * Skips arrays, which never carry intentional nulls for current policy fields.
 */
export function stripNullsDeep(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === null) delete obj[key];
    else if (typeof value === "object" && !Array.isArray(value)) stripNullsDeep(value as Record<string, unknown>);
  }
}
