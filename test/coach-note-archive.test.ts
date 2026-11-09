import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Port 1 (coach-note archive + receipt + coach-note vector writer) suite. Mirrors
// test/socratic-db.test.ts's harness: a per-run temp DATABASE_URL and a module-scope mock of
// "../src/lib/vector-db" capturing every storeContexts call so we can assert vector contracts
// without real Pinecone/Voyage credentials.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-coach-archive-${randomUUID()}.db`)}`;
});

const storeContextsCalls: Array<{
  userId: string;
  documents: Array<{ text: string; metadata: Record<string, unknown> }>;
  options?: { dedupKeyPrefix?: string; scope?: string };
}> = [];

// When set, the mocked storeContexts throws for calls whose dedupKeyPrefix matches — used to
// prove a vector-write failure for ONE doc type (e.g. "coach-note") never blocks the durable
// append/promotion and never prevents a SIBLING doc type (e.g. the "socratic-decision" re-index)
// from succeeding.
let failDedupPrefix: string | undefined;

vi.mock("../src/lib/vector-db", () => ({
  getCurrentVectorProviderAuthority: async () => "provider:test",
  managedVectorLedgerAuthority: () => "ledger:test",
  storeContexts: async (
    documents: Array<{ text: string; metadata: Record<string, unknown> }>,
    userId: string = "local",
    options?: { dedupKeyPrefix?: string; scope?: string }
  ) => {
    if (failDedupPrefix && options?.dedupKeyPrefix === failDedupPrefix) {
      throw new Error(`simulated ${options.dedupKeyPrefix} vector write failure`);
    }
    storeContextsCalls.push({ userId, documents, options });
    return { attempted: documents.length, indexed: documents.length };
  }
}));

async function createDecision(userId: string, connectedAccountId?: string): Promise<string> {
  const { upsertSocraticDecisionCase } = await import("../src/lib/db");
  const id = `decision-${randomUUID()}`;
  upsertSocraticDecisionCase({
    id,
    userId,
    ...(connectedAccountId ? { connectedAccountId } : {}),
    symbol: "TEST",
    side: "buy",
    status: "proposed",
    authority: "decide",
    thesis: "Test thesis",
    rationale: "Test rationale.",
    action: "BUY TEST $1",
    thesisTag: "Momentum",
    regime: "Bull",
    evidence: [],
    ragAttributions: [],
    dissent: []
  });
  return id;
}

describe("coach-note archive + receipt (migration 53)", () => {
  it("no note is ever lost: archive union live window == every note ever appended", async () => {
    const { appendSocraticDecisionCoachNote, listArchivedCoachNotes, getSocraticDecisionCase } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const decisionId = await createDecision(userId);
    const notes = Array.from({ length: 25 }, (_, i) => `note-${i}`);
    for (const note of notes) {
      appendSocraticDecisionCoachNote(decisionId, note, userId);
    }

    const updated = getSocraticDecisionCase(decisionId, userId);
    expect(updated?.coachNotes).toEqual(notes.slice(-20));

    const archived = listArchivedCoachNotes(decisionId, userId);
    expect(archived.map((row) => row.note)).toEqual(notes.slice(0, 5));
    expect(archived.map((row) => row.noteSeq)).toEqual([0, 1, 2, 3, 4]);

    const union = [...archived.map((row) => row.note), ...(updated?.coachNotes ?? [])];
    expect(union).toEqual(notes);
  });

  it("archive receipt fires only when archival occurs", async () => {
    const { appendSocraticDecisionCoachNote, getDb } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const decisionId = await createDecision(userId);
    const db = getDb();

    for (let i = 0; i < 20; i++) {
      appendSocraticDecisionCoachNote(decisionId, `pad-${i}`, userId);
    }
    const beforeRows = db
      .prepare("SELECT payload FROM audit_events WHERE kind = 'socratic_decision_coach_notes_archived' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    expect(beforeRows).toHaveLength(0);

    appendSocraticDecisionCoachNote(decisionId, "note-21", userId);
    const afterRows = db
      .prepare("SELECT payload FROM audit_events WHERE kind = 'socratic_decision_coach_notes_archived' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    expect(afterRows).toHaveLength(1);
    const payload = JSON.parse(afterRows[0].payload) as { decisionId: string; count: number };
    expect(payload.decisionId).toBe(decisionId);
    expect(payload.count).toBe(1);
  });

  it("both append paths archive consistently", async () => {
    const { appendSocraticDecisionCoachNote, attachSocraticDecisionCoachPrimitives, listArchivedCoachNotes, getDb } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const decisionId = await createDecision(userId);
    for (let i = 0; i < 20; i++) {
      appendSocraticDecisionCoachNote(decisionId, `note-${i}`, userId);
    }

    const promoted = await attachSocraticDecisionCoachPrimitives(decisionId, { note: "note-20" }, userId);
    expect(promoted?.decision.coachNotes).toEqual([...Array.from({ length: 19 }, (_, i) => `note-${i + 1}`), "note-20"]);

    const archived = listArchivedCoachNotes(decisionId, userId);
    expect(archived).toHaveLength(1);
    expect(archived[0].note).toBe("note-0");
    expect(archived[0].noteSeq).toBe(0);

    const db = getDb();
    const rows = db
      .prepare("SELECT payload FROM audit_events WHERE kind = 'socratic_decision_coach_notes_archived' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
  });

  it("coach-note vector contract", async () => {
    const { appendSocraticDecisionCoachNote, upsertConnectedAccount } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const connectedAccountId = `acct-${randomUUID()}`;
    upsertConnectedAccount({
      id: connectedAccountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-1",
      label: "Paper",
      isActive: true
    });
    const decisionId = await createDecision(userId, connectedAccountId);

    appendSocraticDecisionCoachNote(decisionId, "Trim faster on breadth failure.", userId);

    await vi.waitFor(() => {
      const call = storeContextsCalls.find((c) => c.options?.dedupKeyPrefix === "coach-note" && c.documents.some((d) => d.metadata.decision_id === decisionId));
      expect(call).toBeDefined();
    });

    const call = storeContextsCalls.find(
      (c) => c.options?.dedupKeyPrefix === "coach-note" && c.documents.some((d) => d.metadata.decision_id === decisionId)
    )!;
    expect(call.userId).toBe(userId);
    expect(call.options?.scope).toBe("private");
    const doc = call.documents[0];
    expect(doc.metadata.doc_type).toBe("coach-note");
    expect(doc.metadata.decision_id).toBe(decisionId);
    expect(doc.metadata.connected_account_id).toBe(connectedAccountId);
    expect(doc.metadata.thesis_tag).toBe("Momentum");
    expect(doc.metadata.entry_market_regime).toBe("Bull");
    expect(String(doc.metadata.accession)).toBe(`${decisionId}:coach:0`);
    expect(doc.text).toContain("note_seq: 0");
    expect(doc.text).toContain(`decision_id: ${decisionId}`);
    expect(doc.text).toContain("note: Trim faster on breadth failure.");
  });

  it("sibling notes never overwrite each other", async () => {
    const { appendSocraticDecisionCoachNote } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const decisionId = await createDecision(userId);

    appendSocraticDecisionCoachNote(decisionId, "First note.", userId);
    appendSocraticDecisionCoachNote(decisionId, "Second note.", userId);

    await vi.waitFor(() => {
      const calls = storeContextsCalls.filter(
        (c) => c.options?.dedupKeyPrefix === "coach-note" && c.documents.some((d) => d.metadata.decision_id === decisionId)
      );
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    const accessions = storeContextsCalls
      .filter((c) => c.options?.dedupKeyPrefix === "coach-note" && c.documents.some((d) => d.metadata.decision_id === decisionId))
      .map((c) => c.documents[0].metadata.accession);
    expect(new Set(accessions).size).toBe(accessions.length);
    // Neither sibling note's accession collides with the parent decision doc's own id.
    expect(accessions).not.toContain(decisionId);
  });

  it("vector failure never blocks the coach-note append (fire-and-forget path)", async () => {
    const { appendSocraticDecisionCoachNote, getSocraticDecisionCase, getDb } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const decisionId = await createDecision(userId);

    failDedupPrefix = "coach-note";
    try {
      const result = appendSocraticDecisionCoachNote(decisionId, "Handle degraded write.", userId);
      expect(result?.coachNotes).toEqual(["Handle degraded write."]);

      await vi.waitFor(() => {
        const db = getDb();
        const rows = db
          .prepare("SELECT payload FROM audit_events WHERE kind = 'socratic_vector_write_degraded' AND user_id = ?")
          .all(userId) as Array<{ payload: string }>;
        expect(rows.length).toBeGreaterThanOrEqual(1);
      });
    } finally {
      failDedupPrefix = undefined;
    }

    const persisted = getSocraticDecisionCase(decisionId, userId);
    expect(persisted?.coachNotes).toEqual(["Handle degraded write."]);
  });

  it("vector failure never blocks the attach path (awaited route-shaped call)", async () => {
    const { attachSocraticDecisionCoachPrimitives, getDb, getSocraticDecisionCase } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const decisionId = await createDecision(userId);

    failDedupPrefix = "coach-note";
    let result;
    try {
      result = await attachSocraticDecisionCoachPrimitives(decisionId, { note: "Attach path degraded write." }, userId);
    } finally {
      failDedupPrefix = undefined;
    }
    expect(result?.decision.coachNotes).toEqual(["Attach path degraded write."]);

    const db = getDb();
    const rows = db
      .prepare("SELECT payload FROM audit_events WHERE kind = 'socratic_vector_write_degraded' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const persisted = getSocraticDecisionCase(decisionId, userId);
    expect(persisted?.coachNotes).toEqual(["Attach path degraded write."]);
  });

  it("cross-user isolation: another user cannot read, coach, or promote a foreign decision", async () => {
    const { appendSocraticDecisionCoachNote, attachSocraticDecisionCoachPrimitives, listArchivedCoachNotes, getDb } = await import("../src/lib/db");
    const ownerId = `u1-${randomUUID()}`;
    const intruderId = `u2-${randomUUID()}`;
    const decisionId = await createDecision(ownerId);

    appendSocraticDecisionCoachNote(decisionId, "owner note", ownerId);

    const intruderAppend = appendSocraticDecisionCoachNote(decisionId, "intruder note", intruderId);
    expect(intruderAppend).toBeUndefined();

    const intruderAttach = await attachSocraticDecisionCoachPrimitives(decisionId, { note: "intruder attach" }, intruderId);
    expect(intruderAttach).toBeUndefined();

    expect(listArchivedCoachNotes(decisionId, intruderId)).toEqual([]);

    const db = getDb();
    const crossUserArchiveRows = db
      .prepare("SELECT COUNT(*) AS count FROM socratic_coach_note_archive WHERE user_id = ?")
      .get(intruderId) as { count: number };
    expect(crossUserArchiveRows.count).toBe(0);

    await vi.waitFor(() => {
      const calls = storeContextsCalls.filter((c) => c.documents.some((d) => d.metadata.decision_id === decisionId));
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
    const calls = storeContextsCalls.filter((c) => c.documents.some((d) => d.metadata.decision_id === decisionId));
    for (const call of calls) {
      expect(call.userId).toBe(ownerId);
    }
  });
});
