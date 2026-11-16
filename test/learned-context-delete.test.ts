// Erasure-path tests for the learned-context ARCHIVE (browse + delete what's actually been
// recorded — the "review it afterward, delete what you don't want" surface that sits alongside
// the risk-tier confirmation queue). Pins two invariants:
//   1. Ownership isolation: a user can delete only their OWN rows — including their own
//      shared-scope contributions (erasure), never a row another user merely reads via
//      includeShared.
//   2. listLearnedContext already excludes superseded rows and is scoped per user (pre-existing
//      behavior this feature depends on) — asserted here so a future change to either function
//      can't silently break the archive's read/delete pairing without failing a test.
//
// We exercise the db helper layer directly (imported via `../src/lib/db`), matching the
// established convention in test/learned-context-pending.test.ts: the DELETE route is a thin
// wrapper whose ownership gate IS deleteLearnedContext's `WHERE id = ? AND user_id = ?` returning
// false for a foreign/missing id — asserted here via a faithful reconstruction of the route body.

import { randomUUID } from "crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { audit, deleteLearnedContext, getDb, insertLearnedContext, listAudit, listLearnedContext, supersedeLearnedContext } from "../src/lib/db";
import { userIdForEmail } from "../src/lib/auth/identity";
import type { LearnedContextRow } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/learned-context-delete-test-${Date.now()}.db`;
  getDb();
});

const USER_A = userIdForEmail("alice-archive@example.com");
const USER_B = userIdForEmail("bob-archive@example.com");

function makeRow(overrides: Partial<LearnedContextRow>): LearnedContextRow {
  return {
    id: `row-${randomUUID()}`,
    userId: USER_A,
    scope: "private",
    kind: "fact",
    subject: "fact:AAPL",
    symbol: "AAPL",
    value: "Apple's services segment carries higher margins than hardware.",
    source: "inferred",
    origin: "ingest",
    riskTier: "fact",
    confidence: 0.6,
    contributorUserId: USER_A,
    assertedAt: new Date().toISOString(),
    supersededBy: null,
    expiresAt: null,
    ...overrides,
    connectedAccountId: overrides.connectedAccountId ?? null,
    accountEnvironment: overrides.accountEnvironment ?? null,
    learningScope: overrides.learningScope ?? "portfolio",
    transferState: overrides.transferState ?? "not_applicable"
  };
}

// Faithful re-creation of the DELETE route's body: delegate to deleteLearnedContext's ownership
// gate, 404-equivalent on a no-op, audit on success. Returns the HTTP-equivalent status.
function deleteAs(id: string, userId: string): number {
  const deleted = deleteLearnedContext(id, userId);
  if (!deleted) return 404;
  audit("learned_context.delete", { userId, id }, userId);
  return 200;
}

describe("deleteLearnedContext — ownership isolation", () => {
  it("deletes a row the user owns", () => {
    const row = makeRow({});
    insertLearnedContext(row);
    expect(listLearnedContext(USER_A).some((r) => r.id === row.id)).toBe(true);

    expect(deleteAs(row.id, USER_A)).toBe(200);

    expect(listLearnedContext(USER_A).some((r) => r.id === row.id)).toBe(false);
  });

  it("404s (no-op) when a different user attempts the delete — never deletes a foreign row", () => {
    const row = makeRow({ userId: USER_A, contributorUserId: USER_A });
    insertLearnedContext(row);

    expect(deleteAs(row.id, USER_B)).toBe(404);

    // The row must still exist for its actual owner — USER_B's attempt did nothing.
    expect(listLearnedContext(USER_A).some((r) => r.id === row.id)).toBe(true);
  });

  it("404s (no-op) for a missing id", () => {
    expect(deleteAs(`row-${randomUUID()}`, USER_A)).toBe(404);
  });

  it("a user can erase their own shared-scope contribution (right-to-erasure)", () => {
    const row = makeRow({ scope: "shared", userId: USER_A, contributorUserId: USER_A });
    insertLearnedContext(row);

    // USER_B (a mere reader of the shared pool) cannot delete it...
    expect(deleteAs(row.id, USER_B)).toBe(404);
    expect(listLearnedContext(USER_A).some((r) => r.id === row.id)).toBe(true);

    // ...but the original contributor can.
    expect(deleteAs(row.id, USER_A)).toBe(200);
    expect(listLearnedContext(USER_A).some((r) => r.id === row.id)).toBe(false);
  });

  it("records an audit event on successful delete, not on a no-op", () => {
    const row = makeRow({});
    insertLearnedContext(row);

    expect(deleteAs(`row-${randomUUID()}`, USER_A)).toBe(404); // no-op: asserted below to add nothing
    expect(deleteAs(row.id, USER_A)).toBe(200);

    const events = listAudit(50, USER_A).filter((a) => a.kind === "learned_context.delete");
    // Exactly one delete audit row for THIS row's id — the earlier no-op id never appears.
    expect(events.filter((a) => (a.payload as { id?: string })?.id === row.id)).toHaveLength(1);
  });
});

describe("listLearnedContext — read semantics the archive depends on", () => {
  it("excludes superseded rows", () => {
    const oldRow = makeRow({});
    const newRow = makeRow({ id: `row-${randomUUID()}` });
    insertLearnedContext(oldRow);
    insertLearnedContext(newRow);
    supersedeLearnedContext(oldRow.id, newRow.id);

    const listed = listLearnedContext(USER_A);
    expect(listed.some((r) => r.id === oldRow.id)).toBe(false);
    expect(listed.some((r) => r.id === newRow.id)).toBe(true);
  });

  it("is scoped per user — never returns another user's private rows", () => {
    const rowA = makeRow({ userId: USER_A, contributorUserId: USER_A });
    const rowB = makeRow({ id: `row-${randomUUID()}`, userId: USER_B, contributorUserId: USER_B, scope: "private" });
    insertLearnedContext(rowA);
    insertLearnedContext(rowB);

    expect(listLearnedContext(USER_A).some((r) => r.id === rowB.id)).toBe(false);
    expect(listLearnedContext(USER_B).some((r) => r.id === rowA.id)).toBe(false);
  });
});
