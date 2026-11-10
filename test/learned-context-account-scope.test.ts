import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, insertLearnedContext, listLearnedContext, listPendingLearnedContext } from "../src/lib/db";
import { ingestLearned, retrieveLearnedContextDetailed } from "../src/lib/learned-context/store";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/learned-context-account-scope-${randomUUID()}.db`;
  process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "off";
  getDb();
});

describe("learned-context connected-account isolation", () => {
  it("keeps a paper lesson private to its source account and marks it transfer-candidate", async () => {
    const userId = `paper-scope-${randomUUID()}`;
    const written = await ingestLearned(
      userId,
      { kind: "pattern", subject: "track_record:momentum", value: "Momentum has worked in closed trades." },
      "autonomous",
      { connectedAccountId: "paper-a", accountEnvironment: "paper" }
    );

    expect(written.written).toMatchObject({
      scope: "private",
      connectedAccountId: "paper-a",
      accountEnvironment: "paper",
      learningScope: "account",
      transferState: "not_applicable"
    });
    expect(retrieveLearnedContextDetailed(userId, [], undefined, { connectedAccountId: "paper-a" }).rows).toHaveLength(1);
    // Per-user: when called with a different account filter, still returns NULL-scoped rows.
    // Non-matching connectedAccountId rows are excluded, but the paper-a row has a specific
    // connectedAccountId and won't match "live-b".
    expect(retrieveLearnedContextDetailed(userId, [], undefined, { connectedAccountId: "live-b" }).rows).toHaveLength(0);
    // Per-user: when called without a connectedAccountId, all account-scoped rows are included.
    expect(retrieveLearnedContextDetailed(userId, []).rows).toHaveLength(1);
  });

  it("deduplicates the same subject independently per account", async () => {
    const userId = `dedupe-scope-${randomUUID()}`;
    for (const connectedAccountId of ["account-a", "account-b"]) {
      await ingestLearned(
        userId,
        { kind: "fact", subject: "track_record:value", value: `Value result for ${connectedAccountId}.` },
        "autonomous",
        { connectedAccountId, accountEnvironment: "live" }
      );
    }
    expect(listLearnedContext(userId)).toHaveLength(2);
    expect(retrieveLearnedContextDetailed(userId, [], undefined, { connectedAccountId: "account-a" }).rows[0]?.value)
      .toContain("account-a");
    expect(retrieveLearnedContextDetailed(userId, [], undefined, { connectedAccountId: "account-b" }).rows[0]?.value)
      .toContain("account-b");
  });

  it("allows owner portfolio context and validated research across accounts, but excludes legacy rows", async () => {
    const userId = `research-scope-${randomUUID()}`;
    await ingestLearned(
      userId,
      { kind: "fact", subject: "owner:constraint", value: "Prefer businesses with durable cash flows." },
      "ingest"
    );
    await ingestLearned(
      userId,
      {
        kind: "pattern",
        subject: "validated_track_record:quality",
        value: "Quality has a positive record corroborated across broker-paper and live accounts."
      },
      "autonomous",
      { learningScope: "research", transferState: "validated" }
    );
    insertLearnedContext({
      id: randomUUID(),
      userId,
      scope: "private",
      kind: "pattern",
      subject: "legacy:unknown-account",
      symbol: null,
      value: "Unattributed autonomous history.",
      source: "inferred",
      origin: "autonomous",
      riskTier: "fact",
      confidence: 0.5,
      contributorUserId: userId,
      connectedAccountId: null,
      accountEnvironment: null,
      learningScope: "legacy",
      transferState: "not_applicable",
      assertedAt: new Date().toISOString(),
      supersededBy: null,
      expiresAt: null
    });

    const rows = retrieveLearnedContextDetailed(userId, [], undefined, { connectedAccountId: "any-account" }).rows;
    expect(rows.map((row) => row.subject)).toEqual(expect.arrayContaining([
      "owner:constraint",
      "validated_track_record:quality"
    ]));
    expect(rows.some((row) => row.learningScope === "legacy")).toBe(false);
  });

  it("preserves account provenance when risk-adjacent lessons enter the approval queue", async () => {
    const userId = `pending-scope-${randomUUID()}`;
    const result = await ingestLearned(
      userId,
      { kind: "pattern", subject: "max_position", value: "Raise position size to 30%." },
      "autonomous",
      { connectedAccountId: "paper-risk", accountEnvironment: "paper" }
    );
    expect(result.pending).toMatchObject({
      connectedAccountId: "paper-risk",
      accountEnvironment: "paper",
      learningScope: "account",
      transferState: "not_applicable"
    });
    expect(listPendingLearnedContext(userId)[0]).toMatchObject({ connectedAccountId: "paper-risk" });
  });
});
