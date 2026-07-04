import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-socratic-${randomUUID()}.db`)}`;
});

// Captures every storeContexts call so we can assert the re-index after a coach-note append
// carries the note in its embedded text, without needing real Pinecone/Voyage credentials.
const storeContextsCalls: Array<{ documents: Array<{ text: string }>; options?: { dedupKeyPrefix?: string } }> = [];
vi.mock("../src/lib/vector-db", () => ({
  storeContexts: async (documents: Array<{ text: string }>, _userId?: string, options?: { dedupKeyPrefix?: string }) => {
    storeContextsCalls.push({ documents, options });
    return { attempted: documents.length, indexed: documents.length };
  }
}));

describe("Socratic decision persistence", () => {
  it("persists decision cases, coach notes, and framework proposal status", async () => {
    const {
      appendSocraticDecisionCoachNote,
      createSocraticFrameworkProposal,
      listSocraticDecisionCases,
      listSocraticFrameworkProposals,
      updateSocraticFrameworkProposalStatus,
      upsertSocraticDecisionCase
    } = await import("../src/lib/db");

    const decisionId = upsertSocraticDecisionCase({
      userId: "u1",
      connectedAccountId: "acct-1",
      runId: "run-1",
      proposalId: "prop-1",
      accountNumber: "acct",
      symbol: "AAPL",
      side: "buy",
      status: "proposed",
      authority: "decide",
      thesis: "Mean-Reversion",
      rationale: "Forced selling looks temporary.",
      action: "BUY AAPL $1000",
      evidence: [{ kind: "policy", title: "Approved", summary: "Preference override applied.", tone: "positive" }],
      ragAttributions: [],
      dissent: []
    });

    expect(decisionId).toBe("prop-1");
    expect(listSocraticDecisionCases("u1", { connectedAccountId: "acct-1" })[0]?.symbol).toBe("AAPL");

    const coached = appendSocraticDecisionCoachNote(decisionId, "Favor broader crash baskets next time.", "u1");
    expect(coached?.coachNotes).toEqual(["Favor broader crash baskets next time."]);

    // Re-indexing is fire-and-forget (a dynamic import + .then()/.catch()), so poll until the mocked
    // storeContexts call lands rather than assuming a fixed number of microtask flushes.
    await vi.waitFor(() => {
      const hasCoachCall = storeContextsCalls.some((call) =>
        call.documents.some((doc) => doc.text.includes("Favor broader crash baskets next time."))
      );
      expect(hasCoachCall).toBe(true);
    });

    // The re-indexed vector-memory doc's TEXT contains the coach note (not frozen at "coach_notes:
    // none" the way it was written at creation) — same contextId/dedupKeyPrefix, so this is an
    // in-place upsert, not a duplicate vector.
    const coachCalls = storeContextsCalls.filter((call) =>
      call.documents.some((doc) => doc.text.includes("Favor broader crash baskets next time."))
    );
    expect(coachCalls.length).toBeGreaterThanOrEqual(1);
    expect(coachCalls[coachCalls.length - 1].options?.dedupKeyPrefix).toBe("socratic-decision");

    const frameworkId = createSocraticFrameworkProposal({
      userId: "u1",
      connectedAccountId: "acct-1",
      decisionId,
      runId: "run-1",
      subsystem: "sizing",
      priority: "high",
      title: "Raise panic-basket sizing",
      rationale: "Override succeeded in a liquidity crash.",
      proposedChange: "When breadth panic reverses, allow larger basket deployment.",
      evidence: []
    });

    expect(listSocraticFrameworkProposals("u1", { connectedAccountId: "acct-1" })[0]?.id).toBe(frameworkId);
    const updated = updateSocraticFrameworkProposalStatus(frameworkId, "accepted", "u1", "Use this in next flash-crash run.");
    expect(updated?.status).toBe("accepted");
    expect(updated?.ownerResponse).toContain("flash-crash");
  });

  it("serves one decision case by id through the read-only route", async () => {
    const { upsertSocraticDecisionCase } = await import("../src/lib/db");
    const { GET } = await import("../app/api/socratic/decisions/[id]/route");

    const decisionId = upsertSocraticDecisionCase({
      status: "observed",
      authority: "propose",
      thesis: "Portfolio posture",
      rationale: "No single-name action was warranted.",
      action: "Observe",
      evidence: [],
      ragAttributions: [],
      dissent: []
    });

    const response = await GET(new Request(`http://localhost/api/socratic/decisions/${decisionId}`), {
      params: Promise.resolve({ id: decisionId })
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: decisionId, thesis: "Portfolio posture" });

    const missing = await GET(new Request("http://localhost/api/socratic/decisions/missing"), {
      params: Promise.resolve({ id: "missing" })
    });
    expect(missing.status).toBe(404);
  });
});
