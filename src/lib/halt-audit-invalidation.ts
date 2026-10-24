/**
 * Which audit writes change the cached halt-cause answer (ST-4561).
 *
 * The halt-cause cache in autonomy-halt-cause.ts holds, per (user, connected account), the latest
 * app-initiated halt and whether anything after it handed that halt over.  Two SQL predicates in
 * that module decide both facts: `APP_HALT_PREDICATE` (the halt rows) and `handoverPredicate` (the
 * rows that hand a halt over).  An audit write that matches EITHER one can change the cached
 * answer, so the write path must drop the cached answer for that scope.  A write that matches
 * neither cannot change it, so it must NOT -- every needless invalidation forces a fresh
 * multi-second off-loop scan of the 19 GB `audit_events` table and defeats the cache TTL.
 *
 * This is the same test the SQL runs, evaluated in JS on the payload the write is about to store.
 * It has no imports on purpose: db.ts calls it on every audit write, and autonomy-halt-cause.ts
 * imports db.ts.  `test/halt-audit-invalidation.test.ts` runs this function and the SQL
 * predicates over the same rows and requires them to agree.
 *
 * SQLite semantics it mirrors:
 *  - `json_extract` on invalid JSON is guarded to NULL, and NULL never compares equal or unequal.
 *  - JSON `false` extracts as integer 0 and `true` as 1, so `dryRun = 0` matches `0` and `false`;
 *    a string "0" is TEXT and does not equal the integer 0.
 *  - `'$.value.systemState' <> 'halted'` is true only for a present, non-null value that is not
 *    the text 'halted' (a number or an object compares unequal to the text).
 */

function parsePayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson);
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** SQL `x = 0` for a value json_extract produced. */
function sqlEqualsZero(value: unknown): boolean {
  return value === 0 || value === false;
}

/** SQL `x <> 'halted'` for a value json_extract produced: NULL (absent or JSON null) is not true. */
function sqlNotHalted(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return value !== "halted";
}

/**
 * True when an audit row of this kind and payload matches the app-halt predicate or the handover
 * predicate, so writing it can change the cached halt-cause answer for its scope.
 */
export function auditRowChangesHaltCause(kind: string, payloadJson: string | undefined): boolean {
  switch (kind) {
    case "broker_placement_auto_halted":
    case "broker_placement_auto_resumed":
    case "broker_placement_pause_owner_override":
    case "autonomy_halted_on_boot":
      return true;
    case "policy_violation_drawdown":
    case "ops_account_control":
    case "policy_change":
      break;
    default:
      // Every other kind: no payload parse on the audit write path.
      return false;
  }
  const payload = typeof payloadJson === "string" ? parsePayload(payloadJson) : undefined;
  switch (kind) {
    case "policy_violation_drawdown":
      // Only the HARD action halts the account.  The advisory row (no `revertedTo`) is written on
      // every breached strategy run and cannot change the answer.
      return field(payload, "revertedTo") === "halted";
    case "ops_account_control":
      return field(payload, "action") === "set_system_state" && sqlEqualsZero(field(payload, "dryRun"));
    case "policy_change":
      return sqlNotHalted(field(field(payload, "value"), "systemState"));
    default:
      return false;
  }
}
