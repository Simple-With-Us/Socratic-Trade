import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SocraticDecisionCase } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-socratic-${randomUUID()}.db`)}`;
});

// Captures every storeContexts call so we can assert the re-index after a coach-note append
// carries the note in its embedded text, without needing real Pinecone/Voyage credentials.
const storeContextsCalls: Array<{
  documents: Array<{ text: string }>;
  options?: { dedupKeyPrefix?: string; scope?: string; leaseGuard?: { assertOwnership: () => void } };
}> = [];
let storeContextsInterceptor: ((text: string) => Promise<void>) | undefined;
let storeContextsResultOverride:
  | { attempted: number; indexed: number; skipped?: boolean; unconfigured?: boolean; error?: string }
  | undefined;
vi.mock("../src/lib/vector-db", () => ({
  getCurrentVectorProviderAuthority: async (options?: { leaseGuard?: { assertOwnership: () => void } }) => {
    options?.leaseGuard?.assertOwnership();
    return "provider:test";
  },
  managedVectorLedgerAuthority: () => "ledger:test",
  storeContexts: async (
    documents: Array<{ text: string }>,
    _userId?: string,
    options?: { dedupKeyPrefix?: string; scope?: string; leaseGuard?: { assertOwnership: () => void } }
  ) => {
    options?.leaseGuard?.assertOwnership();
    if (storeContextsInterceptor) await storeContextsInterceptor(documents.map((document) => document.text).join("\n"));
    options?.leaseGuard?.assertOwnership();
    storeContextsCalls.push({ documents, options });
    return storeContextsResultOverride ?? { attempted: documents.length, indexed: documents.length };
  }
}));

function fmpDerivedDecision(id: string, chunkId: string): SocraticDecisionCase {
  return {
    id,
    userId: "local",
    status: "proposed",
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z",
    symbol: "EXE",
    side: "buy",
    authority: "decide",
    thesis: "FMP-derived case",
    rationale: "FMP-derived rationale.",
    action: "BUY EXE",
    evidence: [],
    ragAttributions: [{
      symbol: "EXE",
      query: "earnings call",
      source: "fmp-earnings-transcript",
      docType: "earnings-transcript",
      chunkId,
      text: "licensed context",
      contribution: "licensed context"
    }],
    dissent: [],
    lessons: [],
    coachNotes: []
  };
}

describe("Socratic decision persistence", () => {
  it("settles a licensed provider reservation as no-write when indexing short-circuits", async () => {
    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "on";
    const { indexSocraticDecisionMemory } = await import("../src/lib/socratic-memory");
    const { activateFmpTranscriptRightsGeneration } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getDb } = await import("../src/lib/db");
    activateFmpTranscriptRightsGeneration();
    storeContextsResultOverride = { attempted: 1, indexed: 0, skipped: true };
    const id = `fmp-no-write-${randomUUID()}`;
    try {
      await indexSocraticDecisionMemory({
        id,
        userId: "local",
        status: "proposed",
        createdAt: "2026-07-14T12:00:00.000Z",
        updatedAt: "2026-07-14T12:00:00.000Z",
        symbol: "EXE",
        side: "buy",
        authority: "decide",
        thesis: "FMP-derived case",
        rationale: "FMP-derived rationale.",
        action: "BUY EXE",
        evidence: [],
        ragAttributions: [{
          symbol: "EXE",
          query: "earnings call",
          source: "fmp-earnings-transcript",
          docType: "earnings-transcript",
          chunkId: "occ:v3:fmp:no-write",
          text: "licensed context",
          contribution: "licensed context"
        }],
        dissent: [],
        lessons: [],
        coachNotes: []
      });
    } finally {
      storeContextsResultOverride = undefined;
    }

    const row = getDb().prepare(`
      SELECT status, terminal_outcome
      FROM fmp_transcript_derived_provider_work WHERE artifact_id = ?
    `).get(id) as { status: string; terminal_outcome: string };
    expect(row).toEqual({ status: "complete", terminal_outcome: "no_provider_write" });
  });

  it("retains a purge obligation when provider-write acknowledgement is ambiguous", async () => {
    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "on";
    const { indexSocraticDecisionMemory } = await import("../src/lib/socratic-memory");
    const { activateFmpTranscriptRightsGeneration } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getDb } = await import("../src/lib/db");
    activateFmpTranscriptRightsGeneration();
    storeContextsResultOverride = {
      attempted: 1,
      indexed: 0,
      // Error presence, not message truthiness, is the durable proof that provider state is unknown.
      error: ""
    };
    const id = `fmp-provider-unknown-${randomUUID()}`;
    try {
      await indexSocraticDecisionMemory(fmpDerivedDecision(id, "occ:v3:fmp:provider-unknown"));
    } finally {
      storeContextsResultOverride = undefined;
    }

    const row = getDb().prepare(`
      SELECT status, terminal_outcome
      FROM fmp_transcript_derived_provider_work WHERE artifact_id = ?
    `).get(id) as { status: string; terminal_outcome: string };
    expect(row).toEqual({ status: "complete", terminal_outcome: "provider_write_unknown" });
  });

  it("fences a paused FMP-derived memory writer after rights revocation and lease expiry", async () => {
    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "on";
    const { indexSocraticDecisionMemory } = await import("../src/lib/socratic-memory");
    const {
      activateFmpTranscriptRightsGeneration,
      captureFmpTranscriptRightsGeneration
    } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getDb } = await import("../src/lib/db");
    activateFmpTranscriptRightsGeneration();
    expect(captureFmpTranscriptRightsGeneration()).toBeDefined();

    let releaseWriter!: () => void;
    let reportWriterStarted!: () => void;
    const writerBlocked = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writerStarted = new Promise<void>((resolve) => { reportWriterStarted = resolve; });
    storeContextsInterceptor = async () => {
      reportWriterStarted();
      await writerBlocked;
    };
    const id = `fmp-paused-${randomUUID()}`;
    const indexing = indexSocraticDecisionMemory({
      id,
      userId: "local",
      status: "proposed",
      createdAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:00:00.000Z",
      symbol: "EXE",
      side: "buy",
      authority: "decide",
      thesis: "FMP-derived case",
      rationale: "FMP-derived rationale.",
      action: "BUY EXE",
      evidence: [],
      ragAttributions: [{
        symbol: "EXE",
        query: "earnings call",
        source: "fmp-earnings-transcript",
        docType: "earnings-transcript",
        chunkId: "occ:v3:fmp:paused",
        text: "licensed context",
        contribution: "licensed context"
      }],
      dissent: [],
      lessons: [],
      coachNotes: []
    });
    await writerStarted;

    const database = getDb();
    database.prepare(`
      UPDATE fmp_transcript_rights_gate
      SET generation = generation + 1, status = 'revoked', updated_at = ?
      WHERE singleton = 1
    `).run(new Date().toISOString());
    database.prepare(`
      UPDATE fmp_transcript_derived_provider_work
      SET lease_expires_at = '2000-01-01T00:00:00.000Z',
          status = 'complete', terminal_outcome = 'lease_expired', completed_at = ?
      WHERE artifact_id = ?
    `).run(new Date().toISOString(), id);
    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    releaseWriter();

    await expect(indexing).rejects.toThrow(/rights generation is revoked or stale|lease is stale or lost/i);
    storeContextsInterceptor = undefined;
    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "on";
    activateFmpTranscriptRightsGeneration();
  });

  it("serializes one decision's vector updates so a slow older lifecycle cannot overwrite the terminal state", async () => {
    const { indexSocraticDecisionMemory } = await import("../src/lib/socratic-memory");
    let releasePlacing!: () => void;
    let reportPlacingStarted!: () => void;
    const placingBlocked = new Promise<void>((resolve) => { releasePlacing = resolve; });
    const placingStarted = new Promise<void>((resolve) => { reportPlacingStarted = resolve; });
    storeContextsInterceptor = async (text) => {
      if (!text.includes("final_action: PLACING")) return;
      reportPlacingStarted();
      await placingBlocked;
    };

    const id = `serialized-${randomUUID()}`;
    const base = {
      id,
      userId: `u-${randomUUID()}`,
      createdAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:00:00.000Z",
      symbol: "EXE",
      side: "buy" as const,
      authority: "decide" as const,
      thesis: id,
      rationale: "Green thesis.",
      action: "BUY EXE $5",
      evidence: [],
      ragAttributions: [],
      dissent: [],
      lessons: [],
      coachNotes: []
    };
    const first = indexSocraticDecisionMemory({ ...base, status: "placing" });
    await placingStarted;
    const second = indexSocraticDecisionMemory({
      ...base,
      status: "placed",
      updatedAt: "2026-07-14T12:00:01.000Z"
    });
    releasePlacing();
    await Promise.all([first, second]);
    storeContextsInterceptor = undefined;

    const calls = storeContextsCalls.filter((call) =>
      call.documents.some((document) => document.text.includes(`broker_argument: ${id}`))
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].documents[0].text).toContain("final_action: PLACING");
    expect(calls[1].documents[0].text).toContain("final_action: PLACED");
  });

  it("keeps case status, applied sizing, policy evidence, and embedded memory synchronized with proposal lifecycle", async () => {
    const {
      claimProposalForExecution,
      getSocraticDecisionCase,
      insertProposal,
      updateProposalStatus,
      upsertSocraticDecisionCase
    } = await import("../src/lib/db");
    const userId = `u-lifecycle-${randomUUID()}`;
    const proposalId = `prop-lifecycle-${randomUUID()}`;
    const baseProposal = {
      symbol: "EXE",
      side: "buy" as const,
      type: "market" as const,
      dollarAmount: 4,
      timeInForce: "gfd" as const,
      marketHours: "regular_hours" as const,
      rationale: "Green thesis.\n\nRed Team review — approved at full size: evidence checks out.",
      greenTeamRationale: "Green thesis.",
      sizingSnapshot: { portfolioValue: 100, estimatedNotional: 4, estimatedPctOfNav: 4 },
      tradeThesisTag: "Value-Quality",
      entryMarketRegime: "Neutral"
    };
    const approved = { approved: true, reasons: ["Deterministic checks passed."] };
    insertProposal({
      id: proposalId,
      userId,
      runId: `run-${randomUUID()}`,
      accountNumber: "IRA-1",
      proposal: baseProposal,
      decision: approved,
      estimatedNotional: 4,
      status: "proposed"
    });
    upsertSocraticDecisionCase({
      id: proposalId,
      userId,
      proposalId,
      accountNumber: "IRA-1",
      symbol: "EXE",
      side: "buy",
      status: "proposed",
      authority: "decide",
      thesis: "Value-Quality",
      rationale: baseProposal.rationale,
      greenTeamRationale: baseProposal.greenTeamRationale,
      sizingSnapshot: baseProposal.sizingSnapshot,
      action: "BUY EXE $4",
      policyDecision: approved,
      evidence: [{ kind: "policy", title: "Proposed decision", summary: "Policy approved BUY EXE $4." }],
      ragAttributions: [],
      dissent: [],
      outcome: { status: "open", note: "Still maturing.", outcomes: [] },
      lessons: ["Preserve this learned lesson."],
      coachNotes: ["Preserve this coach note."]
    });

    const appliedProposal = {
      ...baseProposal,
      dollarAmount: 5,
      sizingSnapshot: { portfolioValue: 100, estimatedNotional: 5, estimatedPctOfNav: 5 },
      rationale: `${baseProposal.rationale} [Sized up from $4.00 to meet the broker minimum.]`
    };
    expect(
      claimProposalForExecution(proposalId, "placing", userId, {
        proposal: appliedProposal,
        review: { estimatedNotional: 5, alerts: [], raw: {} },
        estimatedNotional: 5,
        refId: "ref-lifecycle",
        executionMode: "broker/live"
      })
    ).toBe(true);

    const placing = getSocraticDecisionCase(proposalId, userId);
    expect(placing).toMatchObject({ status: "placing", notional: 5, action: "BUY EXE $5" });
    expect(placing?.sizingSnapshot).toMatchObject({ estimatedNotional: 5, estimatedPctOfNav: 5 });
    expect(placing?.evidence[0]).toMatchObject({ title: "Placement pending confirmation" });

    updateProposalStatus(
      proposalId,
      "rejected_by_broker",
      "order-declined",
      { estimatedNotional: 5, alerts: [], raw: {} },
      5,
      userId,
      undefined,
      "Broker declined the fractional order."
    );
    const rejected = getSocraticDecisionCase(proposalId, userId);
    expect(rejected?.status).toBe("rejected_by_broker");
    expect(rejected?.evidence[0]).toMatchObject({ title: "Rejected by broker" });
    expect(rejected?.evidence[0]?.summary).toContain("Broker declined the fractional order");
    expect(rejected?.outcome).toMatchObject({ status: "open", note: "Still maturing." });
    expect(rejected?.lessons).toContain("Preserve this learned lesson.");
    expect(rejected?.coachNotes).toContain("Preserve this coach note.");

    await vi.waitFor(() => {
      expect(
        storeContextsCalls.some((call) =>
          call.documents.some((document) => document.text.includes("final_action: REJECTED_BY_BROKER"))
        )
      ).toBe(true);
    });
  });

  it("persists decision cases, coach notes, and framework proposal status", async () => {
    const {
      attachSocraticDecisionCoachPrimitives,
      appendSocraticDecisionCoachNote,
      createSocraticFrameworkProposal,
      getSocraticFrameworkProposal,
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
      greenTeamRationale: "Forced selling looks temporary.",
      sizingSnapshot: {
        portfolioValue: 100,
        estimatedNotional: 4.6,
        estimatedPctOfNav: 4.6,
        dailyOpeningCap: { mode: "pct_nav", configuredValue: 20, effectiveNotional: 20, pctOfNav: 20 },
        dailyNotionalUsed: 0,
        remainingDailyNotional: 20
      },
      action: "BUY AAPL $1000",
      evidence: [{ kind: "policy", title: "Approved", summary: "Preference override applied.", tone: "positive" }],
      ragAttributions: [],
      dissent: []
    });

    expect(decisionId).toBe("prop-1");
    const persisted = listSocraticDecisionCases("u1", { connectedAccountId: "acct-1" })[0];
    expect(persisted?.symbol).toBe("AAPL");
    expect(persisted?.greenTeamRationale).toBe("Forced selling looks temporary.");
    expect(persisted?.sizingSnapshot).toEqual({
      portfolioValue: 100,
      estimatedNotional: 4.6,
      estimatedPctOfNav: 4.6,
      dailyOpeningCap: { mode: "pct_nav", configuredValue: 20, effectiveNotional: 20, pctOfNav: 20 },
      dailyNotionalUsed: 0,
      remainingDailyNotional: 20
    });

    const coached = appendSocraticDecisionCoachNote(decisionId, "Favor broader crash baskets next time.", "u1");
    expect(coached?.coachNotes).toEqual(["Favor broader crash baskets next time."]);
    expect(coached?.greenTeamRationale).toBe("Forced selling looks temporary.");
    expect(coached?.sizingSnapshot?.estimatedPctOfNav).toBe(4.6);

    // Re-indexing is fire-and-forget (a dynamic import + .then()/.catch()), so poll until the mocked
    // storeContexts call lands rather than assuming a fixed number of microtask flushes. A standalone
    // coach-note vector now ALSO embeds the note text, so this call also lands one more storeContexts
    // call carrying it — wait for both before asserting.
    await vi.waitFor(() => {
      const hasCoachCall = storeContextsCalls.some((call) =>
        call.documents.some((doc) => doc.text.includes("Favor broader crash baskets next time."))
      );
      const hasCoachNoteVector = storeContextsCalls.some(
        (call) =>
          call.options?.dedupKeyPrefix === "coach-note" &&
          call.documents.some((doc) => doc.text.includes("Favor broader crash baskets next time."))
      );
      expect(hasCoachCall).toBe(true);
      expect(hasCoachNoteVector).toBe(true);
    });

    // The re-indexed vector-memory doc's TEXT contains the coach note (not frozen at "coach_notes:
    // none" the way it was written at creation) — same contextId/dedupKeyPrefix, so this is an
    // in-place upsert, not a duplicate vector. Tightened to dedupKeyPrefix === "socratic-decision"
    // because the standalone coach-note vector (dedupKeyPrefix "coach-note", asserted separately
    // below) ALSO embeds the note text and would otherwise match this same filter.
    const coachCalls = storeContextsCalls.filter(
      (call) => call.options?.dedupKeyPrefix === "socratic-decision" && call.documents.some((doc) => doc.text.includes("Favor broader crash baskets next time."))
    );
    expect(coachCalls.length).toBeGreaterThanOrEqual(1);
    expect(coachCalls[coachCalls.length - 1].options?.dedupKeyPrefix).toBe("socratic-decision");
    expect(coachCalls[coachCalls.length - 1].options?.scope).toBe("private");

    // Sibling assertion: a standalone dedupKeyPrefix === "coach-note" vector also landed.
    const coachNoteVectorCalls = storeContextsCalls.filter(
      (call) => call.options?.dedupKeyPrefix === "coach-note" && call.documents.some((doc) => doc.text.includes("Favor broader crash baskets next time."))
    );
    expect(coachNoteVectorCalls.length).toBeGreaterThanOrEqual(1);
    expect(coachNoteVectorCalls[coachNoteVectorCalls.length - 1].options?.scope).toBe("private");

    const promoted = await attachSocraticDecisionCoachPrimitives(
      decisionId,
      {
        note: "Convert this into a durable sizing lesson.",
        promoteTo: "lesson",
        lessonText: "Size panic baskets more aggressively when breadth is capitulatory."
      },
      "u1"
    );
    expect(promoted?.decision.coachNotes.at(-1)).toBe("Convert this into a durable sizing lesson.");
    expect(promoted?.decision.lessons).toContain("Size panic baskets more aggressively when breadth is capitulatory.");

    const frameworkPromotion = await attachSocraticDecisionCoachPrimitives(
      decisionId,
      {
        note: "Framework should capture this as a repeatable crash playbook.",
        promoteTo: "framework",
        framework: {
          subsystem: "strategy",
          priority: "high",
          title: "Codify the crash playbook",
          rationale: "Broader basket entries would have improved the recovery capture.",
          proposedChange: "When breadth panic reverses, deploy the broader basket instead of a single-name entry."
        }
      },
      "u1"
    );
    expect(frameworkPromotion?.frameworkProposal?.title).toBe("Codify the crash playbook");
    expect(getSocraticFrameworkProposal(frameworkPromotion?.frameworkProposal?.id ?? "", "u1")?.decisionId).toBe(decisionId);

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
    const updated = updateSocraticFrameworkProposalStatus(frameworkId, "accepted", "u1", "Use this in next flash-crash run.", "rewrite");
    expect(updated?.status).toBe("accepted");
    expect(updated?.ownerVerb).toBe("rewrite");
    expect(updated?.ownerResponse).toContain("flash-crash");
  });

  it("serves one decision case by id through the read-only route", async () => {
    const { finishStrategyRun, insertStrategyRun, upsertSocraticDecisionCase } = await import("../src/lib/db");
    const { GET } = await import("../app/api/socratic/decisions/[id]/route");

    insertStrategyRun("trace-run-1");
    finishStrategyRun("trace-run-1", "completed", "Completed a trace-worthy run.");

    const decisionId = upsertSocraticDecisionCase({
      runId: "trace-run-1",
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
    await expect(response.json()).resolves.toMatchObject({
      decision: { id: decisionId, thesis: "Portfolio posture", runId: "trace-run-1" },
      run: { id: "trace-run-1", status: "completed", summary: "Completed a trace-worthy run." }
    });

    const missing = await GET(new Request("http://localhost/api/socratic/decisions/missing"), {
      params: Promise.resolve({ id: "missing" })
    });
    expect(missing.status).toBe(404);
  });

  it("promotes coach notes and validates framework rewrite semantics through the API routes", async () => {
    const { createSocraticFrameworkProposal, upsertSocraticDecisionCase } = await import("../src/lib/db");
    const { POST } = await import("../app/api/socratic/decisions/[id]/coach/route");
    const { PATCH } = await import("../app/api/socratic/framework/[id]/route");

    const decisionId = upsertSocraticDecisionCase({
      connectedAccountId: "acct-2",
      status: "blocked",
      authority: "decide",
      thesis: "Crash basket",
      rationale: "Need a repeatable coaching primitive.",
      action: "Wait",
      evidence: [],
      ragAttributions: [],
      dissent: []
    });

    const coachResponse = await POST(
      new Request(`http://localhost/api/socratic/decisions/${decisionId}/coach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          note: "Promote this into a framework primitive.",
          promoteTo: "framework",
          framework: {
            subsystem: "coaching",
            priority: "high",
            title: "Capture the crash coaching rule",
            rationale: "This should become a reusable review rule.",
            proposedChange: "When a crash basket is blocked, emit the lesson into framework review."
          }
        })
      }),
      { params: Promise.resolve({ id: decisionId }) }
    );
    expect(coachResponse.status).toBe(200);
    await expect(coachResponse.json()).resolves.toMatchObject({
      decision: { id: decisionId },
      frameworkProposal: { decisionId, title: "Capture the crash coaching rule", subsystem: "coaching" }
    });

    const frameworkId = createSocraticFrameworkProposal({
      connectedAccountId: "acct-2",
      decisionId,
      subsystem: "risk",
      title: "Tighten crash veto handling",
      rationale: "Need explicit rewrite semantics.",
      proposedChange: "Require a narrow rewrite verb path."
    });

    const missingRewriteText = await PATCH(
      new Request(`http://localhost/api/socratic/framework/${frameworkId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "accepted", ownerVerb: "rewrite" })
      }),
      { params: Promise.resolve({ id: frameworkId }) }
    );
    expect(missingRewriteText.status).toBe(400);

    const validRewrite = await PATCH(
      new Request(`http://localhost/api/socratic/framework/${frameworkId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "accepted",
          ownerVerb: "rewrite",
          ownerResponse: "Split this into a crash-only guardrail and a lesson-review path."
        })
      }),
      { params: Promise.resolve({ id: frameworkId }) }
    );
    expect(validRewrite.status).toBe(200);
    await expect(validRewrite.json()).resolves.toMatchObject({
      id: frameworkId,
      status: "accepted",
      ownerVerb: "rewrite",
      ownerResponse: "Split this into a crash-only guardrail and a lesson-review path."
    });
  });

  it("writeSocraticDecisionOutcome re-merges at write time so a concurrently-written worker row survives a stale caller (Finding 1 regression)", async () => {
    const { upsertSocraticDecisionCase, writeSocraticDecisionOutcome, getSocraticDecisionCase } = await import("../src/lib/db");

    const decisionId = upsertSocraticDecisionCase({
      userId: "u-lost-update",
      runId: "run-lu-1",
      proposalId: "prop-lu-1",
      accountNumber: "acct",
      symbol: "AAPL",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum",
      rationale: "Breakout with volume.",
      action: "BUY AAPL $1000",
      evidence: [],
      ragAttributions: [],
      dissent: []
    });

    // Simulate the durable due-jobs WORKER (drainDueIntradaySampleJobs) resolving the 15m horizon
    // mid-pass, persisted directly through the same writer a real worker uses.
    await writeSocraticDecisionOutcome(
      decisionId,
      {
        status: "open",
        measuredAt: "2026-07-05T12:15:00.000Z",
        outcomes: [
          { horizon: "15m", returnPct: 3, maturedAt: "2026-07-05T12:15:00.000Z", priceBasis: "fill->live_quote(+15m)", resolution: "ok" }
        ]
      },
      "u-lost-update"
    );
    const afterWorker = getSocraticDecisionCase(decisionId, "u-lost-update");
    expect(afterWorker?.outcome?.outcomes.find((r) => r.horizon === "15m")?.resolution).toBe("ok");

    // Now the INLINE maturation pass writes back a STALE outcomes array built from a pass-start
    // snapshot taken BEFORE the worker's write above (measureCase holds `outcomes` across awaits) —
    // it has no 15m row at all, only a later-horizon row the inline pass itself just measured.
    const staleOutcomes = [
      { horizon: "1h" as const, maturedAt: "2026-07-05T13:00:00.000Z", priceBasis: "fill->live_quote", resolution: "unresolvable" as const, reason: "no_intraday_source" }
    ];
    await writeSocraticDecisionOutcome(decisionId, { status: "open", measuredAt: "2026-07-05T13:00:00.000Z", outcomes: staleOutcomes }, "u-lost-update");

    // The worker-written 15m row must SURVIVE the stale write — this is the lost-update bug: without
    // the write-time re-merge, the stale array (missing 15m entirely) would have wholesale-replaced
    // the persisted outcome and erased it.
    const final = getSocraticDecisionCase(decisionId, "u-lost-update");
    const row15m = final?.outcome?.outcomes.find((r) => r.horizon === "15m");
    expect(row15m?.resolution).toBe("ok");
    expect(row15m?.returnPct).toBe(3);
    // And the inline pass's own new row is still present alongside it (a real merge, not a partial
    // overwrite that drops the caller's own contribution).
    const row1h = final?.outcome?.outcomes.find((r) => r.horizon === "1h");
    expect(row1h?.resolution).toBe("unresolvable");
  });
});
