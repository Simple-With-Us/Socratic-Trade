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

export interface RecordVectorDocsSeenEntry {
  vectorId: string;
  docType: string;
}

export interface RecordVectorDocsSeenResult {
  recorded: number;
  failures: number;
  firstError?: string;
}

/** Batched form of recordVectorDocSeen: one prepared upsert in one transaction,
 * with a savepoint per row so one bad document cannot skip first-seen writes for
 * the valid documents that follow it. Duplicate vector ids keep the last doc type. */
export function recordVectorDocsSeen(input: {
  userId: string;
  documents: readonly RecordVectorDocsSeenEntry[];
  now?: string;
}): RecordVectorDocsSeenResult {
  const uniqueDocuments = new Map<string, RecordVectorDocsSeenEntry>();
  for (const document of input.documents) {
    if (document.vectorId && document.docType) uniqueDocuments.set(document.vectorId, document);
  }
  if (uniqueDocuments.size === 0) return { recorded: 0, failures: 0 };

  const now = input.now ?? new Date().toISOString();
  const database = getDb();
  const stmt = database.prepare(
    `INSERT INTO vector_doc_lifecycle (
       user_id, vector_id, doc_type, first_seen_at, last_retrieved_at, retrieval_count, archived_at, updated_at
     ) VALUES (?, ?, ?, ?, NULL, 0, NULL, ?)
     ON CONFLICT(user_id, vector_id) DO UPDATE SET
       doc_type = excluded.doc_type,
       updated_at = excluded.updated_at`
  );
  let recorded = 0;
  let failures = 0;
  let firstError: string | undefined;
  const writeBatch = database.transaction((documents: RecordVectorDocsSeenEntry[]) => {
    for (const document of documents) {
      database.exec("SAVEPOINT vector_doc_lifecycle_seen");
      try {
        stmt.run(input.userId, document.vectorId, document.docType, now, now);
        database.exec("RELEASE SAVEPOINT vector_doc_lifecycle_seen");
        recorded += 1;
      } catch (err) {
        failures += 1;
        firstError ??= err instanceof Error ? err.message : String(err);
        database.exec("ROLLBACK TO SAVEPOINT vector_doc_lifecycle_seen");
        database.exec("RELEASE SAVEPOINT vector_doc_lifecycle_seen");
      }
    }
  });
  writeBatch([...uniqueDocuments.values()]);
  return firstError === undefined ? { recorded, failures } : { recorded, failures, firstError };
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

/** Batched lookup of which of the given vector ids are soft-archived. Callers use this on
 * the retrieval READ path so a soft-archived doc stops feeding prompts: the archive sweep is
 * the writer, this is its reader, and ISOLATION comes from the indexed (user_id, archived_at)
 * rear of the table -- rows the sweep has not touched yet simply have archived_at NULL. */
export function listArchivedVectorIds(userId: string, vectorIds: readonly string[]): Set<string> {
  const ids = [...new Set(vectorIds.filter(Boolean))];
  const archived = new Set<string>();
  if (ids.length === 0) return archived;
  const db = getDb();
  for (const batch of chunk(ids, 200)) {
    const placeholders = batch.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT vector_id FROM vector_doc_lifecycle
         WHERE user_id = ? AND vector_id IN (${placeholders}) AND archived_at IS NOT NULL`
      )
      .all(userId, ...batch) as Array<{ vector_id: string }>;
    for (const row of rows) archived.add(row.vector_id);
  }
  return archived;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
