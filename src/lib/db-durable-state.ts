// db-durable-state.ts — generic (namespace, key) -> JSON value store backing
// src/lib/durable-state.ts's createDurableMap. Not queried directly by feature code; go through
// createDurableMap instead, which layers hydrate-once + debounced/immediate write-behind on top of
// these raw CRUD calls so hot callers don't pay a synchronous DB write on every access.
import "server-only";
import { getDb } from "./db";

export function getDurableStateValue<T>(namespace: string, key: string): T | undefined {
  const row = getDb()
    .prepare("SELECT value FROM durable_state WHERE namespace = ? AND key = ?")
    .get(namespace, key) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined; // corrupt row — treat as absent rather than throwing
  }
}

export function setDurableStateValue(namespace: string, key: string, value: unknown, now: string = new Date().toISOString()): void {
  getDb()
    .prepare(
      `INSERT INTO durable_state (namespace, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(namespace, key, JSON.stringify(value), now);
}

export function deleteDurableStateValue(namespace: string, key: string): void {
  getDb().prepare("DELETE FROM durable_state WHERE namespace = ? AND key = ?").run(namespace, key);
}

/** All (key, value) rows currently persisted under `namespace`, for one-time hydration into an
 *  in-memory cache. Corrupt rows are skipped rather than thrown. */
export function listDurableStateNamespace(namespace: string): Array<[string, unknown]> {
  const rows = getDb()
    .prepare("SELECT key, value FROM durable_state WHERE namespace = ?")
    .all(namespace) as Array<{ key: string; value: string }>;
  const out: Array<[string, unknown]> = [];
  for (const row of rows) {
    try {
      out.push([row.key, JSON.parse(row.value)]);
    } catch {
      /* corrupt row — skip */
    }
  }
  return out;
}
