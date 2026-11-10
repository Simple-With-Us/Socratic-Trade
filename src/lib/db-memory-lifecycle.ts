// db-memory-lifecycle.ts — per-vector recency/importance lifecycle (migration 80).
import "server-only";
import { getDb } from "./db";

export interface VectorDocLifecycleRow {
  userId: string;
  vectorId: string;
  docType: string;
  firstSeenAt: string;
  lastRetrievedAt: string | null;
  retrievalCount: number;
  archivedAt: string | null;
  updatedAt: string;
}

function rowFromDb(row: {
  user_id: string;
  vector_id: string;
  doc_type: string;
  first_seen_at: string;
  last_retrieved_at: string | null;
  retrieval_count: number;
  archived_at: string | null;
  updated_at: string;
}): VectorDocLifecycleRow {
  return {
    userId: row.user_id,
    vectorId: row.vector_id,
    docType: row.doc_type,
    firstSeenAt: row.first_seen_at,
    lastRetrievedAt: row.last_retrieved_at,
    retrievalCount: row.retrieval_count,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at
  };
}

export function recordVectorDocSeen(input: {
  userId: string;
  vectorId: string;
  docType: string;
  now?: string;
}): void {
  const now = input.now ?? new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO vector_doc_lifecycle (
         user_id, vector_id, doc_type, first_seen_at, last_retrieved_at, retrieval_count, archived_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, 0, NULL, ?)
       ON CONFLICT(user_id, vector_id) DO UPDATE SET
         doc_type = excluded.doc_type,
         updated_at = excluded.updated_at`
    )
    .run(input.userId, input.vectorId, input.docType, now, now);
}

export function bumpVectorDocRetrieved(input: {
  userId: string;
  vectorIds: string[];
  now?: string;
}): void {
  if (input.vectorIds.length === 0) return;
  const now = input.now ?? new Date().toISOString();
  const stmt = getDb().prepare(
    `UPDATE vector_doc_lifecycle
     SET last_retrieved_at = ?, retrieval_count = retrieval_count + 1, updated_at = ?
     WHERE user_id = ? AND vector_id = ? AND archived_at IS NULL`
  );
  const tx = getDb().transaction((ids: string[]) => {
    for (const id of ids) stmt.run(now, now, input.userId, id);
  });
  tx(input.vectorIds);
}

export function listLiveVectorDocLifecycle(userId: string): VectorDocLifecycleRow[] {
  const rows = getDb()
    .prepare(
      `SELECT user_id, vector_id, doc_type, first_seen_at, last_retrieved_at, retrieval_count, archived_at, updated_at
       FROM vector_doc_lifecycle
       WHERE user_id = ? AND archived_at IS NULL`
    )
    .all(userId) as Array<{
    user_id: string;
    vector_id: string;
    doc_type: string;
    first_seen_at: string;
    last_retrieved_at: string | null;
    retrieval_count: number;
    archived_at: string | null;
    updated_at: string;
  }>;
  return rows.map(rowFromDb);
}

export function archiveVectorDocs(userId: string, vectorIds: string[], now?: string): number {
  if (vectorIds.length === 0) return 0;
  const stamp = now ?? new Date().toISOString();
  const stmt = getDb().prepare(
    `UPDATE vector_doc_lifecycle SET archived_at = ?, updated_at = ? WHERE user_id = ? AND vector_id = ? AND archived_at IS NULL`
  );
  let changed = 0;
  const tx = getDb().transaction((ids: string[]) => {
    for (const id of ids) changed += Number(stmt.run(stamp, stamp, userId, id).changes ?? 0);
  });
  tx(vectorIds);
  return changed;
}

export function isVectorDocArchived(userId: string, vectorId: string): boolean {
  const row = getDb()
    .prepare(`SELECT archived_at FROM vector_doc_lifecycle WHERE user_id = ? AND vector_id = ?`)
    .get(userId, vectorId) as { archived_at: string | null } | undefined;
  return Boolean(row?.archived_at);
}
