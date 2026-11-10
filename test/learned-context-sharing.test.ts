/**
 * Tests for cross-user shared-fact sharing (docs/rollouts/2026-06-21-shared-fact-sharing.md).
 *
 * All four spec cases:
 *  1. contributeShared ON → fact written as scope='shared'; OFF → scope='private'.
 *  2. includeShared ON → user B's retrieval includes user A's shared fact.
 *     includeShared OFF → user B sees only their own rows.
 *  3. ISOLATION: user A's PRIVATE fact NEVER returned to user B regardless of B's includeShared.
 *  4. risk/strategy-directive never become shared (they don't reach the fact write path).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getDb, insertLearnedContext, listLearnedContextForDecision } from "../src/lib/db";
import { getLearnedContextSharing, setLearnedContextSharing } from "../src/lib/db-settings";
import { ingestLearned, retrieveLearnedContext } from "../src/lib/learned-context/store";
import type { LearnedContextRow } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/lc-sharing-test-${Date.now()}.db`;
  // Disable the LLM semantic gate so all classification is offline and deterministic.
  process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "off";
  getDb();
});

// ── helpers ────────────────────────────────────────────────────────────────────

function makeFactRow(overrides: Partial<LearnedContextRow>): LearnedContextRow {
  return {
    id: `row-${Math.random().toString(36).slice(2)}`,
    userId: "default-user",
    scope: "private",
    kind: "fact",
    subject: `fact:TEST-${Math.random().toString(36).slice(2)}`,
    symbol: null,
    value: "a generic market fact",
    source: "inferred",
    origin: "ingest",
    riskTier: "fact",
    confidence: 0.6,
    contributorUserId: "default-user",
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

// ── Case 1: contributeShared ON/OFF controls scope of written fact row ────────

describe("Case 1 — contributeShared flag controls scope on write", () => {
  it("contributeShared OFF → fact row is scope='private'", async () => {
    const userId = "share-write-off-user";
    // contributeShared now defaults ON, so opt OUT explicitly to exercise the private path.
    setLearnedContextSharing(userId, { contributeShared: false });
    const r = await ingestLearned(
      userId,
      { kind: "decision", subject: "fact:MSFT", value: "Microsoft has a dominant cloud platform." },
      "ingest"
    );
    expect(r.written).not.toBeNull();
    expect(r.tier).toBe("fact");
    expect(r.written?.scope).toBe("private");
    expect(r.written?.contributorUserId).toBe(userId);
  });

  it("contributeShared ON → fact row is scope='shared' with contributorUserId stamped", async () => {
    const userId = "share-write-on-user";
    setLearnedContextSharing(userId, { contributeShared: true });
    const r = await ingestLearned(
      userId,
      { kind: "decision", subject: "fact:AMZN", value: "Amazon AWS is the dominant cloud infrastructure provider." },
      "ingest"
    );
    expect(r.written).not.toBeNull();
    expect(r.tier).toBe("fact");
    expect(r.written?.scope).toBe("shared");
    expect(r.written?.contributorUserId).toBe(userId);
  });

  it("turning contributeShared back OFF → subsequent facts are scope='private' again", async () => {
    const userId = "share-write-toggle-user";
    setLearnedContextSharing(userId, { contributeShared: true });
    const r1 = await ingestLearned(
      userId,
      { kind: "decision", subject: "fact:GOOG-1", value: "Google leads in search advertising." },
      "ingest"
    );
    expect(r1.written?.scope).toBe("shared");

    setLearnedContextSharing(userId, { contributeShared: false });
    const r2 = await ingestLearned(
      userId,
      { kind: "decision", subject: "fact:GOOG-2", value: "Google Cloud is the third-largest cloud provider." },
      "ingest"
    );
    expect(r2.written?.scope).toBe("private");
  });
});

// ── Case 2: includeShared ON/OFF controls retrieval ───────────────────────────

describe("Case 2 — includeShared flag controls whether shared facts appear in retrieval", () => {
  const contributorId = "contributor-alpha";
  const readerId = "reader-beta";
  const sharedSubject = "fact:SHARED-FACT-CASE2";
  const sharedValue = "Tesla is the EV market share leader in the US.";

  beforeAll(() => {
    // Write a shared fact directly — simulates contributorId having contributeShared ON.
    insertLearnedContext(
      makeFactRow({
        id: `shared-case2-${Date.now()}`,
        userId: contributorId,
        scope: "shared",
        subject: sharedSubject,
        value: sharedValue,
        contributorUserId: contributorId
      })
    );
  });

  it("includeShared ON (default) → reader sees the contributor's shared fact", () => {
    setLearnedContextSharing(readerId, { includeShared: true });
    const results = retrieveLearnedContext(readerId, []);
    expect(results.some((s) => s.includes(sharedValue))).toBe(true);
  });

  it("includeShared OFF → reader does NOT see the contributor's shared fact", () => {
    setLearnedContextSharing(readerId, { includeShared: false });
    const results = retrieveLearnedContext(readerId, []);
    expect(results.every((s) => !s.includes(sharedValue))).toBe(true);
  });

  it("includeShared can be passed explicitly as options.includeShared, overriding the setting", () => {
    // Even if setting is OFF, an explicit options.includeShared=true overrides it.
    setLearnedContextSharing(readerId, { includeShared: false });
    const withOverride = retrieveLearnedContext(readerId, [], undefined, { includeShared: true });
    expect(withOverride.some((s) => s.includes(sharedValue))).toBe(true);

    // And vice versa: setting ON but explicit false → no shared rows.
    setLearnedContextSharing(readerId, { includeShared: true });
    const withFalseOverride = retrieveLearnedContext(readerId, [], undefined, { includeShared: false });
    expect(withFalseOverride.every((s) => !s.includes(sharedValue))).toBe(true);
  });
});

// ── Case 3: ISOLATION — private row from user A NEVER returned to user B ────
// This is the most critical safety test.

describe("Case 3 — ISOLATION: user A private row NEVER returned to user B", () => {
  const userA = "isolation-user-a";
  const userB = "isolation-user-b";
  const privateSubject = "fact:PRIVATE-ISOLATION";
  const privateValue = "This is user A private fact that B must never see.";

  beforeAll(() => {
    // Insert a PRIVATE row for user A. This must never cross to user B.
    insertLearnedContext(
      makeFactRow({
        id: `private-isolation-${Date.now()}`,
        userId: userA,
        scope: "private",  // PRIVATE — must not cross user boundary
        subject: privateSubject,
        value: privateValue,
        contributorUserId: userA
      })
    );
    // Ensure user B has includeShared ON (the most permissive setting for B) — the private row
    // must still not appear.
    setLearnedContextSharing(userB, { includeShared: true });
  });

  it("user B's listLearnedContextForDecision never includes user A's private row", () => {
    const rows = listLearnedContextForDecision(userB, [], true);
    const leaked = rows.some((r) => r.userId === userA && r.scope === "private");
    expect(leaked).toBe(false);
  });

  it("user B's retrieveLearnedContext never includes user A's private row value", () => {
    const results = retrieveLearnedContext(userB, [], undefined, { includeShared: true });
    expect(results.every((s) => !s.includes(privateValue))).toBe(true);
  });

  it("user A can still read their own private row", () => {
    const rows = listLearnedContextForDecision(userA, []);
    expect(rows.some((r) => r.subject === privateSubject && r.value === privateValue)).toBe(true);
  });
});

// ── Case 4: risk/strategy-directive never become shared ─────────────────────

describe("Case 4 — risk and strategy-directive tiers are never written as shared", () => {
  it("an autonomous risk candidate does not produce a shared row (routed to pending queue)", async () => {
    const userId = "risk-share-test-user";
    // Enable contributeShared ON — even so, a risk-tier candidate must NOT produce scope='shared'.
    setLearnedContextSharing(userId, { contributeShared: true });

    const r = await ingestLearned(
      userId,
      { kind: "pattern", subject: "max_position", value: "raise the stop loss threshold to 30%" },
      "autonomous"
    );
    // Must be routed to pending, not written.
    expect(r.written).toBeNull();
    expect(r.pendingId).not.toBeNull();

    // Confirm no shared row exists for this user/subject.
    const sharedRows = listLearnedContextForDecision("any-other-user", [], true).filter(
      (row) => row.userId === userId && row.scope === "shared" && row.subject === "max_position"
    );
    expect(sharedRows).toHaveLength(0);
  });

  it("a chat risk candidate is hard-capped — no shared row produced", async () => {
    const userId = "chat-risk-share-user";
    setLearnedContextSharing(userId, { contributeShared: true });

    const r = await ingestLearned(
      userId,
      {
        kind: "pattern",
        subject: "tech",
        value: "be much more aggressive on tech stocks",
        intent: "be much more aggressive on tech stocks"
      },
      "chat"
    );
    expect(r.written).toBeNull();
    expect(r.dropped).toBe("chat_risk_dropped");

    const sharedRows = listLearnedContextForDecision("any-reader", [], true).filter(
      (row) => row.userId === userId && row.scope === "shared"
    );
    expect(sharedRows).toHaveLength(0);
  });
});

// ── Settings helpers ──────────────────────────────────────────────────────────

describe("getLearnedContextSharing / setLearnedContextSharing helpers", () => {
  it("defaults: includeShared=true, contributeShared=true", () => {
    const prefs = getLearnedContextSharing("prefs-fresh-user");
    expect(prefs.includeShared).toBe(true);
    expect(prefs.contributeShared).toBe(true);
  });

  it("can set and retrieve individual flags independently", () => {
    const userId = "prefs-set-user";
    setLearnedContextSharing(userId, { contributeShared: true });
    const a = getLearnedContextSharing(userId);
    expect(a.contributeShared).toBe(true);
    expect(a.includeShared).toBe(true); // default preserved

    setLearnedContextSharing(userId, { includeShared: false });
    const b = getLearnedContextSharing(userId);
    expect(b.includeShared).toBe(false);
    expect(b.contributeShared).toBe(true); // prior value preserved
  });
});
