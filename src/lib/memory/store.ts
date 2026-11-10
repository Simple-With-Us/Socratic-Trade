// Per-user memory store with upsert/supersede semantics (reconcile-on-write, never blind-append),
// backed by the user_memory SQLite table. Hard constraints are always surfaced first on retrieve.
// Ported from reference/atlas-public-src/bff/memory/store.mjs (Map -> SQLite).

import { randomUUID } from "crypto";
import {
  audit,
  deleteMemory,
  findLiveMemoryBySubject,
  insertMemory,
  listLiveMemory,
  supersedeMemory,
  touchMemory
} from "../db";
import type { MemoryItem } from "../types";
import { extractCandidates, score } from "./salience";
import { captureUserWriteEpoch, runWithUserWriteEpoch, type UserWriteEpoch } from "../user-write-fence";

export interface IngestResult {
  written: Array<{ item: MemoryItem; op: "append" | "supersede" | "upsert"; score: number }>;
  held: Array<{ subject: string; score: number }>;
  skipped: Array<{ subject: string; score: number }>;
}

/**
 * Apply the write policy to a message: extract candidates, score, WRITE/HOLD/SKIP. A candidate
 * matching an existing (kind, subject) upserts if identical, else supersedes the prior value.
 */
export function ingestMessage(userId: string, message: string, writeEpoch?: UserWriteEpoch): IngestResult {
  const epoch = writeEpoch ?? captureUserWriteEpoch(userId);
  return runWithUserWriteEpoch(userId, epoch, () => {
    const written: IngestResult["written"] = [];
    const held: IngestResult["held"] = [];
    const skipped: IngestResult["skipped"] = [];

    for (const c of extractCandidates(message)) {
      const existing = findLiveMemoryBySubject(userId, c.kind, c.subject);
      const { score: s, decision } = score(c, existing);

    if (decision === "SKIP") {
      skipped.push({ subject: c.subject, score: s });
      continue;
    }
    if (decision === "HOLD") {
      held.push({ subject: c.subject, score: s });
      continue;
    }

    // WRITE: upsert if identical, else supersede the prior value (reconcile, don't accumulate).
    if (existing && existing.value === c.value) {
      const updated = touchMemory(existing.id, new Date().toISOString(), Math.max(existing.confidence, c.confidence));
      if (updated) written.push({ item: updated, op: "upsert", score: s });
      continue;
    }
    const item: MemoryItem = {
      id: randomUUID(),
      userId,
      kind: c.kind,
      subject: c.subject,
      value: c.value,
      source: c.source,
      confidence: c.confidence,
      hard: c.hard,
      assertedAt: new Date().toISOString(),
      supersededBy: null
    };
    insertMemory(item);
    if (existing) supersedeMemory(existing.id, item.id);
    written.push({ item, op: existing ? "supersede" : "append", score: s });
    audit("memory.write", { userId, kind: item.kind, subject: item.subject, op: existing ? "supersede" : "append" }, userId);
    }
    return { written, held, skipped };
  });
}

/** For prompt assembly: hard constraints ALWAYS included, then most-recent live items up to a budget. */
export function retrieve(userId: string, options: { limit?: number } = {}): MemoryItem[] {
  const limit = options.limit ?? 12;
  const items = listLiveMemory(userId);
  const constraints = items.filter((m) => m.hard);
  const rest = items
    .filter((m) => !m.hard)
    .sort((a, b) => b.assertedAt.localeCompare(a.assertedAt))
    .slice(0, Math.max(0, limit - constraints.length));
  return [...constraints, ...rest];
}

export function listMemories(userId: string): MemoryItem[] {
  return listLiveMemory(userId);
}

export function forget(userId: string, id: string): boolean {
  const epoch = captureUserWriteEpoch(userId);
  return runWithUserWriteEpoch(userId, epoch, () => {
    const removed = deleteMemory(userId, id);
    if (removed) audit("memory.forget", { userId, id }, userId);
    return removed;
  });
}
