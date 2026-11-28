// OD-9 learning-to-trading seams (ST-4684): hard memory constraints in propose mode (D4a),
// accepted framework proposals emitting advisory overlays (D4b), and Red-veto decision rows
// deduped against skipped counterfactuals (D5c).  Each seam tested including the
// owner-adjustable override knobs and the dedupe contract.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  HARD_CONSTRAINT_PROMPT_CAP,
  listHardMemoryConstraints,
  shouldEmitAcceptedFrameworkAsOverlay,
  shouldSurfaceMemoryHardConstraints
} from "../src/lib/od9-seams";
import type { TradeProposal } from "../src/lib/types";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { listStrategyOverlays } from "../src/lib/db-overlays";
import { frameworkOverlayId } from "../src/lib/framework-applier";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-od9-seams-${randomUUID()}.db`)}`;
});

function makeProposal(overrides: Partial<TradeProposal>): TradeProposal {
  return {
    symbol: "AAPL",
    side: "buy",
    type: "market",
    quantity: undefined,
    dollarAmount: 1000,
    limitPrice: undefined,
    stopPrice: undefined,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "Test rationale",
    tradeThesisTag: "momentum_breakout",
    entryMarketRegime: "Neutral (Normal Volatility)",
    confidenceScore: 60,
    ...overrides
  };
}

describe("od9-seams gates (D4a/D4b overrides)", () => {
  it("surfaces memory hard constraints in propose authority by default", () => {
    expect(shouldSurfaceMemoryHardConstraints({ strategyAuthority: "propose" })).toBe(true);
    expect(shouldSurfaceMemoryHardConstraints({ strategyAuthority: "propose", tuning: {} })).toBe(true);
  });

  it("the tuning override disables the D4a seam", () => {
    expect(
      shouldSurfaceMemoryHardConstraints({ strategyAuthority: "propose", tuning: { chatHardConstraintsInPropose: false } })
    ).toBe(false);
  });

  it("the D4a seam is propose-mode only: decide authority never surfaces them", () => {
    expect(shouldSurfaceMemoryHardConstraints({ strategyAuthority: "decide" })).toBe(false);
    expect(shouldSurfaceMemoryHardConstraints({ strategyAuthority: "decide", tuning: { chatHardConstraintsInPropose: true } })).toBe(false);
  });

  it("D4b emission defaults on in propose authority with a tuning override", () => {
    expect(shouldEmitAcceptedFrameworkAsOverlay({ strategyAuthority: "propose" })).toBe(true);
    expect(
      shouldEmitAcceptedFrameworkAsOverlay({ strategyAuthority: "propose", tuning: { acceptedFrameworkProposalsToOverlays: false } })
    ).toBe(false);
    expect(shouldEmitAcceptedFrameworkAsOverlay({ strategyAuthority: "decide" })).toBe(false);
  });
});

describe("listHardMemoryConstraints (D4a loader)", () => {
  it("returns hard rows only, newest first, subject-deduped (oldest superseded) and capped", async () => {
    const { insertMemory, supersedeMemory } = await import("../src/lib/db");
    const userId = `od9-mem-${randomUUID()}`;
    const now = Date.now();
    const seed = (subject: string, value: string, hard: boolean, at: number) => {
      const item = {
        id: randomUUID(),
        userId,
        kind: "constraint" as const,
        subject,
        value,
        source: "user_stated",
        confidence: 0.9,
        hard,
        assertedAt: new Date(at).toISOString(),
        supersededBy: null
      };
      insertMemory(item);
      return item;
    };
    const olderNoLeverage = seed("no_leverage", "No margin", true, now - 4000);
    const newerNoLeverage = seed("no_leverage", "No margin (re-asserted)", true, now - 1000);
    supersedeMemory(olderNoLeverage.id, newerNoLeverage.id);
    seed("no_options", "No options", true, now - 2000);
    seed("soft_style", "Prefer tech", false, now);

    const constraints = listHardMemoryConstraints(userId, HARD_CONSTRAINT_PROMPT_CAP);
    expect(constraints.map((m) => m.subject)).toEqual(["no_leverage", "no_options"]);
    expect(constraints.every((m) => m.hard)).toBe(true);
    expect(constraints.find((m) => m.subject === "no_leverage")?.value).toContain("re-asserted");
  });

  it("caps the constraint count and drops non-hard rows", async () => {
    const { insertMemory } = await import("../src/lib/db");
    const userId = `od9-cap-${randomUUID()}`;
    for (let i = 0; i < HARD_CONSTRAINT_PROMPT_CAP + 4; i++) {
      insertMemory({
        id: randomUUID(),
        userId,
        kind: "constraint",
        subject: `rule_${i}`,
        value: `Rule ${i}`,
        source: "user_stated",
        confidence: 0.9,
        hard: true,
        assertedAt: new Date(Date.now() - i * 1000).toISOString(),
        supersededBy: null
      });
    }
    insertMemory({
      id: randomUUID(),
      userId,
      kind: "preference",
      subject: "style",
      value: "Prefer tech",
      source: "user_stated",
      confidence: 0.7,
      hard: false,
      assertedAt: new Date(Date.now() + 1000).toISOString(),
      supersededBy: null
    });
    const constraints = listHardMemoryConstraints(userId);
    expect(constraints).toHaveLength(HARD_CONSTRAINT_PROMPT_CAP);
    expect(constraints.every((m) => m.hard)).toBe(true);
  });
  it("picks the newest-asserted revision per subject even when rowid order diverges, and drops blank subjects", async () => {
    const { insertMemory } = await import("../src/lib/db");
    const userId = `od9-mem2-${randomUUID()}`;
    const now = Date.now();
    // Insert the NEWER-asserted row FIRST so its rowid is LOWER than the stale row's:
    // a MAX(rowid) dedupe would return the stale revision; asserted_at-first must win.
    insertMemory({
      id: randomUUID(),
      userId,
      kind: "constraint",
      subject: "no_leverage",
      value: "No margin (newest)",
      source: "user_stated",
      confidence: 0.9,
      hard: true,
      assertedAt: new Date(now).toISOString(),
      supersededBy: null
    });
    insertMemory({
      id: randomUUID(),
      userId,
      kind: "constraint",
      subject: "no_leverage",
      value: "No margin (stale)",
      source: "user_stated",
      confidence: 0.9,
      hard: true,
      assertedAt: new Date(now - 60_000).toISOString(),
      supersededBy: null
    });
    insertMemory({
      id: randomUUID(),
      userId,
      kind: "constraint",
      subject: "   ",
      value: "Blank subject noise",
      source: "user_stated",
      confidence: 0.9,
      hard: true,
      assertedAt: new Date(now + 1000).toISOString(),
      supersededBy: null
    });
    const constraints = listHardMemoryConstraints(userId);
    expect(constraints).toHaveLength(1);
    expect(constraints[0].subject).toBe("no_leverage");
    expect(constraints[0].value).toContain("newest");
  });
});

describe("applyAcceptedFrameworkProposal (D4b)", () => {
  it("requires the owner's confirmed text: a plain accept without ownerResponse emits nothing", async () => {
    const {
      createSocraticFrameworkProposal,
      getSocraticFrameworkProposal,
      setPolicy,
      updateSocraticFrameworkProposalStatus
    } = await import("../src/lib/db");
    const { applyAcceptedFrameworkProposal } = await import("../src/lib/framework-applier");
    const user = `od9-fw0-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OD9FW0", strategyAuthority: "propose" }, user);
    const id = createSocraticFrameworkProposal({
      userId: user,
      subsystem: "risk",
      priority: "high",
      title: "Tighten entry drift",
      rationale: "Several entries drifted past the cap.",
      proposedChange: "Prefer entries within 1% of the quoted reference."
    });
    const accepted = updateSocraticFrameworkProposalStatus(id, "accepted", user);
    expect(accepted?.status).toBe("accepted");
    // Security contract (Kody #5488): the model's proposedChange must NOT become
    // instructions, so a textless accept skips emission entirely.
    expect(applyAcceptedFrameworkProposal(getSocraticFrameworkProposal(id, user)!).skippedReason).toBe("owner_text_required");
    expect(listStrategyOverlays(user)).toHaveLength(0);
  });

  it("emits an enabled advisory overlay from the owner's text and upserts the rewrite in place", async () => {
    const {
      createSocraticFrameworkProposal,
      getSocraticFrameworkProposal,
      setPolicy,
      updateSocraticFrameworkProposalStatus
    } = await import("../src/lib/db");
    const { applyAcceptedFrameworkProposal } = await import("../src/lib/framework-applier");
    const user = `od9-fw-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OD9FW", strategyAuthority: "propose", tuning: { ...(DEFAULT_POLICY.tuning ?? {}) } }, user);
    const id = createSocraticFrameworkProposal({
      userId: user,
      subsystem: "risk",
      priority: "high",
      title: "Tighten entry drift",
      rationale: "Several entries drifted past the cap.",
      proposedChange: "Prefer entries within 1% of the quoted reference."
    });
    const accepted = updateSocraticFrameworkProposalStatus(id, "accepted", user, "Prefer entries within 1% of the quote.", "accept");
    expect(accepted?.status).toBe("accepted");

    const applied = applyAcceptedFrameworkProposal(getSocraticFrameworkProposal(id, user)!);
    expect(applied.emitted).toBe(true);
    expect(applied.overlayId).toBe(frameworkOverlayId(user, id));
    const overlays = listStrategyOverlays(user);
    expect(overlays).toHaveLength(1);
    expect(overlays[0].enabled).toBe(true);
    // Instructions are the OWNER's text, not the model's proposedChange.
    expect(overlays[0].instructions).toContain("Prefer entries within 1% of the quote.");
    expect(overlays[0].priority).toBe(40); // FRAMEWORK_PRIORITY.high

    // Owner rewrites and re-accepts: same overlay id, updated instructions, refreshed
    // priority from the mapping, still ONE row.
    const rewritten = updateSocraticFrameworkProposalStatus(id, "accepted", user, "Prefer entries within 0.5% of the quote.", "rewrite");
    expect(rewritten?.ownerVerb).toBe("rewrite");
    const second = applyAcceptedFrameworkProposal(getSocraticFrameworkProposal(id, user)!);
    expect(second.emitted).toBe(true);
    expect(second.overlayId).toBe(frameworkOverlayId(user, id));
    const after = listStrategyOverlays(user);
    expect(after).toHaveLength(1);
    expect(after[0].instructions).toContain("0.5%");
    expect(after[0].priority).toBe(40); // refreshed on re-accept
  });

  it("is idempotent under concurrent accepts (single UPSERT row) and bounds/sanitizes the write", async () => {
    const {
      createSocraticFrameworkProposal,
      getSocraticFrameworkProposal,
      setPolicy,
      updateSocraticFrameworkProposalStatus
    } = await import("../src/lib/db");
    const { applyAcceptedFrameworkProposal, frameworkOverlayId } = await import("../src/lib/framework-applier");
    const { upsertStrategyOverlay } = await import("../src/lib/db-overlays");
    const user = `od9-fw3-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OD9FW3", strategyAuthority: "propose" }, user);
    const id = createSocraticFrameworkProposal({ userId: user, subsystem: "sizing", priority: "medium", title: "T", rationale: "R", proposedChange: "C" });
    updateSocraticFrameworkProposalStatus(id, "accepted", user, "Prefer half-size exploratory entries.", "accept");
    const framework = getSocraticFrameworkProposal(id, user)!;
    // Two racing accepts of the same framework id must not collide or double-row.
    const [a, b] = await Promise.all([applyAcceptedFrameworkProposal(framework), applyAcceptedFrameworkProposal(framework)]);
    expect(a.emitted).toBe(true);
    expect(b.emitted).toBe(true);
    const rows = listStrategyOverlays(user);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(frameworkOverlayId(user, id));
    expect(rows[0].priority).toBe(70); // FRAMEWORK_PRIORITY.medium

    // Direct upsert idempotence on the natural key.
    upsertStrategyOverlay({ id: "shared-overlay-id", userId: user, name: "Direct", instructions: "First" });
    upsertStrategyOverlay({ id: "shared-overlay-id", userId: user, name: "Direct", instructions: "Second" });
    expect(listStrategyOverlays(user).filter((row) => row.id === "shared-overlay-id")).toHaveLength(1);
    expect(listStrategyOverlays(user).find((row) => row.id === "shared-overlay-id")?.instructions).toBe("Second");

    // Sanitize/bound: control characters stripped and instructions capped at 800 chars.
    const longText = "Keep \u0007 entries \u0000 small. " + "x".repeat(1600);
    const capped = updateSocraticFrameworkProposalStatus(id, "accepted", user, longText, "rewrite");
    expect(capped).toBeTruthy();
    const cappedApplied = applyAcceptedFrameworkProposal(getSocraticFrameworkProposal(id, user)!);
    expect(cappedApplied.emitted).toBe(true);
    const cappedRow = listStrategyOverlays(user).find((row) => row.id === frameworkOverlayId(user, id))!;
    expect(cappedRow.instructions.length).toBeLessThanOrEqual(800);
    expect(cappedRow.instructions).not.toContain("\u0007");
    expect(cappedRow.instructions).not.toContain("\u0000");
  });

  it("skips emission with reasons: not accepted, not propose mode, tuning override", async () => {
    const {
      createSocraticFrameworkProposal,
      getSocraticFrameworkProposal,
      setPolicy,
      updateSocraticFrameworkProposalStatus
    } = await import("../src/lib/db");
    const { applyAcceptedFrameworkProposal } = await import("../src/lib/framework-applier");
    const user = `od9-fw2-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OD9FW2", strategyAuthority: "propose" }, user);
    const id = createSocraticFrameworkProposal({ userId: user, subsystem: "coaching", title: "T", rationale: "R", proposedChange: "C" });
    const pending = getSocraticFrameworkProposal(id, user)!;
    expect(applyAcceptedFrameworkProposal(pending).skippedReason).toBe("not_accepted");

    updateSocraticFrameworkProposalStatus(id, "accepted", user, "Owner text.", "accept");
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OD9FW2", strategyAuthority: "decide" }, user);
    expect(applyAcceptedFrameworkProposal(getSocraticFrameworkProposal(id, user)!).skippedReason).toBe("not_propose_mode");
    expect(listStrategyOverlays(user)).toHaveLength(0);

    setPolicy(
      { ...DEFAULT_POLICY, accountNumber: "OD9FW2", strategyAuthority: "propose", tuning: { ...(DEFAULT_POLICY.tuning ?? {}), acceptedFrameworkProposalsToOverlays: false } },
      user
    );
    expect(applyAcceptedFrameworkProposal(getSocraticFrameworkProposal(id, user)!).skippedReason).toBe("tuning_disabled");
    expect(listStrategyOverlays(user)).toHaveLength(0);
  });
  it("refuses to upsert across owners: another user's overlay id is never rewritten", async () => {
    const { upsertStrategyOverlay } = await import("../src/lib/db-overlays");
    const ownerA = `od9-ownA-${randomUUID()}`;
    const ownerB = `od9-ownB-${randomUUID()}`;
    upsertStrategyOverlay({ id: "shared-id", userId: ownerA, name: "A", instructions: "Owner A rule" });
    expect(() => upsertStrategyOverlay({ id: "shared-id", userId: ownerB, name: "B", instructions: "Owner B rule" })).toThrow(/another user/);
    const aRow = listStrategyOverlays(ownerA).find((row) => row.id === "shared-id")!;
    expect(aRow.instructions).toBe("Owner A rule");
    expect(listStrategyOverlays(ownerB)).toHaveLength(0);
    // Same owner still refreshes its own row in place.
    upsertStrategyOverlay({ id: "shared-id", userId: ownerA, name: "A", instructions: "Owner A rule v2" });
    expect(listStrategyOverlays(ownerA).find((row) => row.id === "shared-id")?.instructions).toBe("Owner A rule v2");
  });
});
  it("gives a second owner accepting the SAME framework their own overlay (no first-writer squat)", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const { applyAcceptedFrameworkProposal, frameworkOverlayId } = await import("../src/lib/framework-applier");
    const ownerA = `od9-shareA-${randomUUID()}`;
    const ownerB = `od9-shareB-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "SHARE-A", strategyAuthority: "propose" }, ownerA);
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "SHARE-B", strategyAuthority: "propose" }, ownerB);
    // The SAME framework id accepted by two owners (Kody 68zvEh): each owner gets
    // their own overlay row; first-writer id squatting denies nobody.
    const sharedFrameworkId = randomUUID();
    const makeFramework = (userId: string) => ({
      id: sharedFrameworkId,
      userId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "accepted" as const,
      priority: "medium" as const,
      subsystem: "risk" as const,
      title: "Shared framework",
      rationale: "R",
      proposedChange: "Model wording (never persisted)",
      evidence: [],
      ownerVerb: "accept" as const,
      ownerResponse: "Prefer half-size exploratory entries."
    });
    const a = applyAcceptedFrameworkProposal(makeFramework(ownerA));
    const b = applyAcceptedFrameworkProposal(makeFramework(ownerB));
    expect(a.emitted).toBe(true);
    expect(b.emitted).toBe(true);
    expect(a.overlayId).toBe(frameworkOverlayId(ownerA, sharedFrameworkId));
    expect(b.overlayId).toBe(frameworkOverlayId(ownerB, sharedFrameworkId));
    expect(a.overlayId).not.toBe(b.overlayId);
    const aRows = listStrategyOverlays(ownerA);
    const bRows = listStrategyOverlays(ownerB);
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0].instructions).toBe(bRows[0].instructions);
    // Owner A re-accepting stays idempotent on A's row only.
    const again = applyAcceptedFrameworkProposal(makeFramework(ownerA));
    expect(again.overlayId).toBe(frameworkOverlayId(ownerA, sharedFrameworkId));
    expect(listStrategyOverlays(ownerA)).toHaveLength(1);
    expect(listStrategyOverlays(ownerB)).toHaveLength(1);
  });
  it("retires the legacy global-keyed overlay on re-accept so exactly one enabled row remains per owner+framework", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const { createStrategyOverlay } = await import("../src/lib/db-overlays");
    const { applyAcceptedFrameworkProposal, frameworkOverlayId, legacyFrameworkOverlayId } = await import("../src/lib/framework-applier");
    const user = `od9-legacy-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "LEGACY", strategyAuthority: "propose" }, user);
    const frameworkId = randomUUID();
    // Simulate the pre-upgrade world: a LEGACY global-keyed overlay row for this framework.
    createStrategyOverlay({
      id: legacyFrameworkOverlayId(frameworkId),
      userId: user,
      name: "Legacy wording",
      instructions: "Owner legacy wording.",
      priority: 70,
      enabled: true
    });
    const framework = {
      id: frameworkId,
      userId: user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "accepted" as const,
      priority: "medium" as const,
      subsystem: "risk" as const,
      title: "Upgrade scenario",
      rationale: "R",
      proposedChange: "Model wording (never persisted)",
      evidence: [],
      ownerVerb: "accept" as const,
      ownerResponse: "Prefer half-size exploratory entries."
    };
    const applied = applyAcceptedFrameworkProposal(framework);
    expect(applied.emitted).toBe(true);
    const rows = listStrategyOverlays(user);
    // Exactly ONE enabled advisory for this owner+framework: the new per-user row is
    // authoritative and the legacy global-keyed row is retired, not doubled.
    expect(rows.filter((row) => row.enabled)).toHaveLength(1);
    expect(rows.find((row) => row.id === frameworkOverlayId(user, frameworkId))?.enabled).toBe(true);
    expect(rows.find((row) => row.id === legacyFrameworkOverlayId(frameworkId))?.enabled).toBe(false);
    // Re-emission is stable: no resurrection, no duplicates.
    applyAcceptedFrameworkProposal(framework);
    const after = listStrategyOverlays(user);
    expect(after.filter((row) => row.enabled)).toHaveLength(1);
    expect(after.find((row) => row.id === legacyFrameworkOverlayId(frameworkId))?.enabled).toBe(false);
    // Another owner's PER-USER row for the same framework is untouched by this
    // owner's emission (the legacy lookup is scoped to this owner's rows; the legacy
    // global id could only ever be held by one owner anyway — global PRIMARY KEY).
    const other = `od9-legacy2-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "LEGACY2", strategyAuthority: "propose" }, other);
    createStrategyOverlay({
      id: frameworkOverlayId(other, frameworkId),
      userId: other,
      name: "Other owner overlay",
      instructions: "Other owner wording.",
      priority: 70,
      enabled: true
    });
    applyAcceptedFrameworkProposal(framework);
    expect(listStrategyOverlays(other).find((row) => row.id === frameworkOverlayId(other, frameworkId))?.enabled).toBe(true);
    expect(listStrategyOverlays(user).filter((row) => row.enabled)).toHaveLength(1);
  });



describe("recordRedVetoDecisionRow (D5c)", () => {
  it("writes a rejected decision row and dedupes re-vetoes of the SAME proposal shape, preserving a matured outcome", async () => {
    const { getDb, setPolicy, upsertSocraticDecisionCase } = await import("../src/lib/db");
    const { recordRedVetoDecisionRow } = await import("../src/lib/red-veto-decision");
    const user = `od9-veto-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OD9VETO", strategyAuthority: "decide" }, user);
    const runId = `run-${randomUUID()}`;
    const proposal = makeProposal({
      redTeamVerdict: { verdict: "reject", rejected: true, available: true, reason: "Unsustainable thesis.", model: "reviewer" }
    });

    const decisionId = recordRedVetoDecisionRow({
      userId: user,
      runId,
      proposalId: `p1-${randomUUID()}`,
      accountNumber: "OD9VETO",
      authority: "decide",
      proposal,
      reason: "Unsustainable thesis."
    });
    expect(decisionId).toMatch(new RegExp(`^red-veto:${runId}:AAPL:[0-9a-f]{12}$`));

    const { getSocraticDecisionCase } = await import("../src/lib/db");
    const row = getSocraticDecisionCase(decisionId!, user)!;
    expect(row.status).toBe("rejected");
    expect(row.side).toBe("buy");
    expect(row.thesisTag).toBe("momentum_breakout");
    expect(row.redTeamVerdict?.rejected).toBe(true);
    expect(row.policyDecision?.approved).toBe(false);
    expect(row.policyDecision?.reasons?.[0]).toBe("red_team_veto: Unsustainable thesis.");
    expect(row.lessons).toEqual([]);

    // A matured outcome must survive a re-veto (run retry) of the same proposal shape.
    const matured = {
      status: "won" as const,
      returnPct: 4.2,
      measuredAt: new Date().toISOString(),
      outcomes: [{ horizon: "1d" as const, resolution: "ok" as const, returnPct: 1.1 }]
    };
    upsertSocraticDecisionCase({ ...row, userId: user, outcome: matured });

    const proposalId2 = `p2-${randomUUID()}`;
    const again = recordRedVetoDecisionRow({
      userId: user,
      runId,
      proposalId: proposalId2,
      accountNumber: "OD9VETO",
      authority: "decide",
      proposal,
      reason: "Unsustainable thesis."
    });
    expect(again).toBe(decisionId);
    const after = getSocraticDecisionCase(decisionId!, user)!;
    expect(after.proposalId).toBe(proposalId2);
    expect(after.outcome?.status).toBe("won");
    expect(after.outcome?.returnPct).toBe(4.2);

    const count = (getDb().prepare("SELECT COUNT(*) AS n FROM socratic_decisions WHERE id = ? AND user_id = ?").get(decisionId, user) as { n: number }).n;
    expect(count).toBe(1);
  });

  it("gives a DIFFERENT proposal for the same symbol its own ledger row (no overwrite)", async () => {
    const { getSocraticDecisionCase, setPolicy } = await import("../src/lib/db");
    const { recordRedVetoDecisionRow } = await import("../src/lib/red-veto-decision");
    const user = `od9-veto2-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OD9VETO2", strategyAuthority: "decide" }, user);
    const runId = `run-${randomUUID()}`;
    const first = makeProposal({ tradeThesisTag: "momentum_breakout" });
    const proposalId1 = `p1-${randomUUID()}`;
    const a = recordRedVetoDecisionRow({
      userId: user,
      runId,
      proposalId: proposalId1,
      accountNumber: "OD9VETO2",
      authority: "decide",
      proposal: first,
      reason: "Flawed entry."
    });
    const second = makeProposal({ tradeThesisTag: "mean_reversion_oversold" });
    const proposalId2 = `p2-${randomUUID()}`;
    const b = recordRedVetoDecisionRow({
      userId: user,
      runId,
      proposalId: proposalId2,
      accountNumber: "OD9VETO2",
      authority: "decide",
      proposal: second,
      reason: "Flawed entry."
    });
    expect(b).toBeDefined();
    expect(b).not.toBe(a);
    const firstRow = getSocraticDecisionCase(a!, user)!;
    const secondRow = getSocraticDecisionCase(b!, user)!;
    expect(firstRow.proposalId).toBe(proposalId1);
    expect(secondRow.proposalId).toBe(proposalId2);
    expect(secondRow.thesisTag).toBe("mean_reversion_oversold");
  });
  it("keeps ONE ledger row when the same proposal shape is re-vetoed with drifted sizing numbers", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const { recordRedVetoDecisionRow } = await import("../src/lib/red-veto-decision");
    const user = `od9-veto3-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OD9VETO3", strategyAuthority: "decide" }, user);
    const runId = `run-${randomUUID()}`;
    const base = makeProposal({});
    const drifted = makeProposal({ dollarAmount: 1234, referencePrice: 187.5 });
    const a = recordRedVetoDecisionRow({
      userId: user,
      runId,
      proposalId: `p1-${randomUUID()}`,
      accountNumber: "OD9VETO3",
      authority: "decide",
      proposal: base,
      reason: "Flawed entry."
    });
    const b = recordRedVetoDecisionRow({
      userId: user,
      runId,
      proposalId: `p2-${randomUUID()}`,
      accountNumber: "OD9VETO3",
      authority: "decide",
      proposal: drifted,
      reason: "Flawed entry."
    });
    expect(b).toBe(a);
  });
});