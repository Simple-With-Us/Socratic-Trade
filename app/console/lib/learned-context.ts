/** Typed client for the learned-context confirmation queue (the "things the
 *  AI inferred it wants to remember" inbox) AND the durable learned-context
 *  archive (everything actually recorded — silent fact-tier rows plus
 *  approved risk/directive rows). Deliberately SELF-CONTAINED — not part of
 *  lib/api.ts — so parallel work on that file never collides with this
 *  feature. Talks to the real endpoints only:
 *
 *    GET    /api/learned-context/pending              → LearnedContextPendingRow[]
 *           (server already filters to status === "pending", newest first)
 *    POST   /api/learned-context/pending/[id]/approve → { status: "approved", tier }
 *    POST   /api/learned-context/pending/[id]/reject  → { status: "rejected" }
 *    GET    /api/learned-context                      → LearnedContextRow[]
 *           (everything durably recorded for this user, newest first)
 *    DELETE /api/learned-context/[id]                 → { status: "deleted" }
 *
 *  Error bodies from these routes are plain text (NextResponse(message)), so
 *  failures are surfaced with the server's own sentence, never a fabricated one. */

import type { LearnedContextPendingRow, LearnedContextRow } from "@/lib/types";
import { formatStrategyDirectiveBlock } from "@/lib/learned-context-queue-helpers";

export type PendingLearnedItem = LearnedContextPendingRow;

export class LearnedContextApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "LearnedContextApiError";
    this.status = status;
  }
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.trim() || fallback;
}

export async function fetchPendingLearnedContext(signal?: AbortSignal): Promise<PendingLearnedItem[]> {
  let res: Response;
  try {
    res = await fetch("/api/learned-context/pending", { cache: "no-store", signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new LearnedContextApiError("Network error — the server could not be reached.", 0);
  }
  if (!res.ok) {
    throw new LearnedContextApiError(await errorMessage(res, `Could not load the queue (${res.status}).`), res.status);
  }
  const data = (await res.json()) as PendingLearnedItem[];
  // The route already returns only status === "pending"; filter defensively anyway.
  return Array.isArray(data) ? data.filter((item) => item.status === "pending") : [];
}

async function act(id: string, action: "approve" | "reject"): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/learned-context/pending/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  } catch {
    throw new LearnedContextApiError("Network error — the server could not be reached.", 0);
  }
  if (!res.ok) {
    throw new LearnedContextApiError(await errorMessage(res, `Request failed (${res.status}).`), res.status);
  }
}

/** Approve: 'strategy-directive' appends an attributed AI-LEARNED block to the
 *  strategy prompt; 'risk' promotes to an advisory learned-context row. The
 *  server NEVER derives a numeric policy change from an approval. */
export function approvePendingLearnedContext(id: string): Promise<void> {
  return act(id, "approve");
}

/** Reject: the candidate is discarded. Nothing is applied anywhere. */
export function rejectPendingLearnedContext(id: string): Promise<void> {
  return act(id, "reject");
}

/** The exact attributed block an approval would append to the strategy prompt
 *  RIGHT NOW. The server stamps the block with the APPROVAL date (see
 *  mergeStrategyDirectiveBlock in src/lib/learned-context/store.ts), so the
 *  preview uses today — not createdAt, which the legacy UI showed and which
 *  could not match what actually lands. The row's source/origin are passed for
 *  the same reason: the server stamps a provenance line and, when the text is
 *  not owner-authored, contains it — the preview must show both. */
export function directiveBlockPreview(item: PendingLearnedItem): string {
  return formatStrategyDirectiveBlock(item.id, new Date().toISOString(), item.value, item.source, item.origin);
}

/** Everything durably recorded for this user: silent fact-tier rows (never queued, never
 *  confirmed) plus any risk/strategy-directive rows they approved from the pending queue above.
 *  This is the "what has the AI learned so far" browse list — read + delete only; nothing here is
 *  ever auto-applied by fetching it. */
export async function fetchLearnedContext(signal?: AbortSignal): Promise<LearnedContextRow[]> {
  let res: Response;
  try {
    res = await fetch("/api/learned-context", { cache: "no-store", signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new LearnedContextApiError("Network error — the server could not be reached.", 0);
  }
  if (!res.ok) {
    throw new LearnedContextApiError(await errorMessage(res, `Could not load learned context (${res.status}).`), res.status);
  }
  const data = (await res.json()) as LearnedContextRow[];
  return Array.isArray(data) ? data : [];
}

/** Erase a recorded learned-context row. Irreversible — the caller should confirm first. */
export async function deleteLearnedContextItem(id: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/learned-context/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    throw new LearnedContextApiError("Network error — the server could not be reached.", 0);
  }
  if (!res.ok) {
    throw new LearnedContextApiError(await errorMessage(res, `Delete failed (${res.status}).`), res.status);
  }
}
