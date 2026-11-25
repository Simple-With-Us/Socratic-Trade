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
});

describe("applyAcceptedFrameworkProposal (D4b)", () => {
  it("emits an enabled advisory overlay for an accepted proposal and rewrites in place", async () => {
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
    const accepted = updateSocraticFrameworkProposalStatus(id, "accepted", user);
    expect(accepted?.status).toBe("accepted");

    const applied = applyAcceptedFrameworkProposal(getSocraticFrameworkProposal(id, user)!);
    expect(applied.emitted).toBe(true);
    expect(applied.overlayId).toBe(frameworkOverlayId(id));
    const overlays = listStrategyOverlays(user);
    expect(overlays).toHaveLength(1);
    expect(overlays[0].enabled).toBe(true);
    expect(overlays[0].instructions).toContain("Prefer entries within 1%");

    // Owner rewrites and re-accepts: same overlay id, updated instructions, still ONE row.
    const rewritten = updateSocraticFrameworkProposalStatus(id, "accepted", user, "Prefer entries within 0.5% of the quote.", "rewrite");
    expect(rewritten?.ownerVerb).toBe("rewrite");
    const second = applyAcceptedFrameworkProposal(getSocraticFrameworkProposal(id, user)!);
    expect(second.emitted).toBe(true);
    expect(second.overlayId).toBe(frameworkOverlayId(id));
    const after = listStrategyOverlays(user);
    expect(after).toHaveLength(1);
    expect(after[0].instructions).toContain("0.5%");
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

    updateSocraticFrameworkProposalStatus(id, "accepted", user);
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
});

describe("recordRedVetoDecisionRow (D5c)", () => {
  it("writes a rejected decision row and dedupes re-vetoes on the derived id, preserving a matured outcome", async () => {
    const { getDb, setPolicy, upsertSocraticDecisionCase } = await import("../src/lib/db");
    const { recordRedVetoDecisionRow, redVetoDecisionId } = await import("../src/lib/red-veto-decision");
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
    expect(decisionId).toBe(redVetoDecisionId(runId, "AAPL"));

    const { getSocraticDecisionCase } = await import("../src/lib/db");
    const row = getSocraticDecisionCase(decisionId!, user)!;
    expect(row.status).toBe("rejected");
    expect(row.side).toBe("buy");
    expect(row.thesisTag).toBe("momentum_breakout");
    expect(row.redTeamVerdict?.rejected).toBe(true);
    expect(row.policyDecision?.approved).toBe(false);
    expect(row.policyDecision?.reasons?.[0]).toBe("red_team_veto: Unsustainable thesis.");
    expect(row.lessons).toEqual([]);

    // A matured outcome must survive a re-veto (run retry) of the same (runId, symbol).
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
});