import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { ThesisRegimeStat } from "../src/lib/performance";

// Port 2 (lesson writer) suite. Mirrors test/coach-note-archive.test.ts's harness: a per-run temp
// DATABASE_URL and a module-scope mock of "../src/lib/vector-db" capturing every storeContexts
// call so we can assert vector contracts without real Pinecone/Voyage credentials. This file owns
// no production files besides src/lib/post-mortem.ts (Implementer 2's exclusive territory per the
// design) and duplicates the small createDecision/mock harness rather than importing it from
// test/coach-note-archive.test.ts, by design (file-exclusive split, zero shared files).

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-lesson-vectors-${randomUUID()}.db`)}`;
  // Same flake class as post-mortem.test.ts / approval-lock: the first test in a fresh-DB file
  // bears the full better-sqlite3 migration cost and can blow vitest's default timeout.
  vi.setConfig({ testTimeout: 20_000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_URL;
  delete process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET;
});

const storeContextsCalls: Array<{
  userId: string;
  documents: Array<{ text: string; metadata: Record<string, unknown> }>;
  options?: { dedupKeyPrefix?: string; scope?: string };
}> = [];

// When set, the mocked storeContexts throws for the call whose FIRST document carries this exact
// `accession` — used to prove a single bucket's (or a single promoted-lesson's) vector-write
// failure never blocks siblings and never blocks the durable caller (attach path / reflection pass).
let failAccession: string | undefined;
// When set, the mocked storeContexts returns this result (after recording the call) instead of a
// plain successful index — used to simulate dedup hits and unconfigured/budget skips.
let storeResultOverride: Record<string, unknown> | undefined;

vi.mock("../src/lib/vector-db", () => ({
  getCurrentVectorProviderAuthority: async () => "provider:test",
  managedVectorLedgerAuthority: () => "ledger:test",
  storeContexts: async (
    documents: Array<{ text: string; metadata: Record<string, unknown> }>,
    userId: string = "local",
    options?: { dedupKeyPrefix?: string; scope?: string }
  ) => {
    const accession = documents[0]?.metadata?.accession;
    if (failAccession && accession === failAccession) {
      throw new Error(`simulated vector write failure for accession ${String(accession)}`);
    }
    storeContextsCalls.push({ userId, documents, options });
    if (storeResultOverride) return { attempted: documents.length, ...storeResultOverride };
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

function stat(
  thesisTag: string,
  regime: string,
  trades: number,
  overrides: Partial<ThesisRegimeStat> = {},
  sourceAccounts: string[] = ["acct-test"],
  envBreakdown: { paper: number; live: number } = { paper: trades, live: 0 }
): ThesisRegimeStat & { source_accounts: string[]; environment_breakdown: { paper: number; live: number } } {
  return {
    thesisTag,
    regime,
    trades,
    winRate: 60,
    avgReturnPct: 2,
    totalPnl: 500,
    shrunkWinRate: 55,
    shrunkAvgReturnPct: 1.8,
    ...overrides,
    source_accounts: sourceAccounts,
    environment_breakdown: envBreakdown
  };
}

describe("promoted-lesson vector (attachSocraticDecisionCoachPrimitives promoteTo:'lesson')", () => {
  it("promoteTo:'lesson' emits a standalone lesson vector", async () => {
    const { attachSocraticDecisionCoachPrimitives, getDb, upsertConnectedAccount } = await import("../src/lib/db");
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
    const lessonText = "Trim faster on breadth failure.";

    const result = await attachSocraticDecisionCoachPrimitives(decisionId, { note: lessonText, promoteTo: "lesson" }, userId);
    expect(result?.promotedLesson).toBe(lessonText);

    const call = storeContextsCalls.find(
      (c) => c.options?.dedupKeyPrefix === "lesson" && c.documents.some((d) => d.metadata.decision_id === decisionId)
    );
    expect(call).toBeDefined();
    expect(call!.userId).toBe(userId);
    expect(call!.options?.scope).toBe("private");

    const doc = call!.documents[0];
    const hash = createHash("sha256").update(lessonText, "utf8").digest("hex").slice(0, 16);
    expect(doc.metadata.doc_type).toBe("lesson");
    expect(doc.metadata.decision_id).toBe(decisionId);
    expect(doc.metadata.connected_account_id).toBe(connectedAccountId);
    expect(doc.metadata.vector_id).toBe(`socratic-lesson:${decisionId}:${hash}`);
    expect(doc.metadata.accession).toBe(`${decisionId}:lesson:${hash}`);
    expect(doc.text).toContain(`lesson: ${lessonText}`);

    const db = getDb();
    const promoted = db
      .prepare("SELECT payload FROM audit_events WHERE kind = 'socratic_decision_coach_promoted' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    expect(promoted).toHaveLength(1);
  });

  it("re-promoting an identical lesson emits no duplicate vector", async () => {
    const { attachSocraticDecisionCoachPrimitives } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const decisionId = await createDecision(userId);
    const lessonText = "Same lesson text, twice.";

    await attachSocraticDecisionCoachPrimitives(decisionId, { note: lessonText, promoteTo: "lesson" }, userId);
    const afterFirst = storeContextsCalls.filter(
      (c) => c.options?.dedupKeyPrefix === "lesson" && c.documents.some((d) => d.metadata.decision_id === decisionId)
    ).length;
    expect(afterFirst).toBe(1);

    // Second promotion of the exact same text: decision.lessons already contains it, so the
    // newly-added-lesson guard in db-socratic.ts must skip the vector emission entirely.
    await attachSocraticDecisionCoachPrimitives(decisionId, { note: lessonText, promoteTo: "lesson" }, userId);
    const afterSecond = storeContextsCalls.filter(
      (c) => c.options?.dedupKeyPrefix === "lesson" && c.documents.some((d) => d.metadata.decision_id === decisionId)
    ).length;
    expect(afterSecond).toBe(1);
  });
});

describe("thesis x regime bucket lesson vectors (writeThesisRegimeLessonVectors)", () => {
  it("writes one vector per well-sampled bucket; thin and Untagged buckets are gated out", async () => {
    const { writeThesisRegimeLessonVectors } = await import("../src/lib/post-mortem");
    const { getDb } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const connectedAccountId = `acct-${randomUUID()}`;

    const stats = [
      stat("Momentum", "Bull", 5), // exactly at the MIN_LOTS boundary -> written
      stat("Momentum", "Bear", 4), // below boundary -> thin, skipped
      stat("Untagged", "Bull", 10), // Untagged -> skipped regardless of sample size
      stat("MeanReversion", "Unspecified", 6) // legitimate Unspecified-regime bucket -> written
    ];

    await writeThesisRegimeLessonVectors(stats, userId, [{accountNumber: connectedAccountId, environment: "paper"}]);

    const calls = storeContextsCalls.filter(
      (c) => c.options?.dedupKeyPrefix === "lesson" && c.documents.some((d) => String(d.metadata.vector_id ?? "").includes(userId))
    );
    expect(calls).toHaveLength(2);
    const buckets = calls.map((c) => `${c.documents[0].metadata.thesis_tag}@${c.documents[0].metadata.entry_market_regime}`);
    expect(new Set(buckets)).toEqual(new Set(["Momentum@Bull", "MeanReversion@Unspecified"]));

    const momentumCall = calls.find((c) => c.documents[0].metadata.thesis_tag === "Momentum")!;
    const doc = momentumCall.documents[0];
    expect(momentumCall.userId).toBe(userId);
    expect(momentumCall.options?.scope).toBe("private");
    expect(doc.metadata.doc_type).toBe("lesson");
    expect(doc.metadata.memory_scope).toBe("user");
    expect(doc.metadata.source).toBe("reflection-lesson");
    expect(doc.metadata.symbol).toBe("PORTFOLIO");
    expect(doc.metadata.account_environment).toBe("paper");
    expect(doc.metadata.connected_account_id).toBeUndefined();
    expect(doc.metadata.vector_id).toBe(`reflection-lesson:${userId}:Momentum:Bull`);
    expect(doc.metadata.accession).toBe(`${userId}:Momentum:Bull`);
    // No per-episode fields: an aggregate must never look like a single labeled episode.
    expect(doc.metadata.decision_id).toBeUndefined();
    expect(doc.metadata.run_id).toBeUndefined();
    expect(doc.metadata.return_pct).toBeUndefined();
    expect(doc.text).toContain("thesis_tag: Momentum");
    expect(doc.text).toContain("entry_market_regime: Bull");
    expect(doc.text).toContain("sample: 5 closed lots");
    expect(doc.text).toContain('guidance: The "Momentum" thesis');
    expect(doc.text).toContain("in Bull conditions.");

    const rows = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'reflection_lesson_vectors_written' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload);
    expect(payload.buckets).toBe(2);
    expect(payload.skippedThin).toBe(2);
    expect(payload.failed).toBe(0);
  });

  it("stable identity across refreshes: same vector_id, differing text, no sibling accumulation", async () => {
    const { writeThesisRegimeLessonVectors } = await import("../src/lib/post-mortem");
    const userId = `u-${randomUUID()}`;
    const connectedAccountId = `acct-${randomUUID()}`;

    await writeThesisRegimeLessonVectors(
      [stat("Growth", "Bull", 8, { winRate: 60, avgReturnPct: 2, totalPnl: 500, shrunkWinRate: 55, shrunkAvgReturnPct: 1.8 })],
      userId,
      [{accountNumber: connectedAccountId, environment: "live"}]
    );
    await writeThesisRegimeLessonVectors(
      [stat("Growth", "Bull", 12, { winRate: 40, avgReturnPct: -1, totalPnl: -200, shrunkWinRate: 42, shrunkAvgReturnPct: -0.9 })],
      userId,
      [{accountNumber: connectedAccountId, environment: "live"}]
    );

    const calls = storeContextsCalls.filter(
      (c) => c.options?.dedupKeyPrefix === "lesson" && c.documents.some((d) => String(d.metadata.vector_id ?? "").includes(userId))
    );
    expect(calls).toHaveLength(2);
    const vectorIds = calls.map((c) => c.documents[0].metadata.vector_id);
    expect(vectorIds[0]).toBe(vectorIds[1]);
    expect(calls[0].documents[0].text).not.toBe(calls[1].documents[0].text);
  });

  it("a single bucket's vector-write failure isolates: siblings still write, one degraded receipt, function resolves", async () => {
    const { writeThesisRegimeLessonVectors } = await import("../src/lib/post-mortem");
    const { getDb } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const connectedAccountId = `acct-${randomUUID()}`;

    const stats = [stat("Momentum", "Bull", 6), stat("Value", "Bear", 7)];
    failAccession = `${userId}:Momentum:Bull`;
    try {
      // Resolves (never throws) and reports the partial outcome so a signature-deduping caller can retry.
      await expect(writeThesisRegimeLessonVectors(stats, userId, [{accountNumber: connectedAccountId, environment: "paper"}])).resolves.toEqual({
        attempted: 2,
        written: 1,
        skipped: 0,
        failed: 1
      });
    } finally {
      failAccession = undefined;
    }

    const calls = storeContextsCalls.filter(
      (c) => c.options?.dedupKeyPrefix === "lesson" && c.documents.some((d) => String(d.metadata.vector_id ?? "").includes(userId))
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].documents[0].metadata.thesis_tag).toBe("Value");

    const degraded = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'socratic_vector_write_degraded' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    expect(degraded).toHaveLength(1);
    const degradedPayload = JSON.parse(degraded[0].payload);
    expect(degradedPayload.docType).toBe("lesson");
    expect(degradedPayload.bucket).toBe("Momentum @ Bull");

    const summary = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'reflection_lesson_vectors_written' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    expect(summary).toHaveLength(1);
    const summaryPayload = JSON.parse(summary[0].payload);
    expect(summaryPayload.buckets).toBe(1);
    expect(summaryPayload.failed).toBe(1);
    expect(summaryPayload.skippedThin).toBe(0);
  });

  it("cross-user/account isolation: every write carries exactly the userId/account passed in", async () => {
    const { writeThesisRegimeLessonVectors } = await import("../src/lib/post-mortem");
    const userA = `u1-${randomUUID()}`;
    const accountA = `acct-${randomUUID()}`;

    await writeThesisRegimeLessonVectors([stat("Breakout", "Bull", 6)], userA, [{accountNumber: accountA, environment: "paper"}]);

    const calls = storeContextsCalls.filter((c) => c.documents.some((d) => String(d.metadata.vector_id ?? "").includes(userA)));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect(call.userId).toBe(userA);
      expect(call.documents[0].metadata.vector_id).toBe(`reflection-lesson:${userA}:Breakout:Bull`);
    }
  });
});

describe("generateReflectionSummary integration", () => {
  it("the bucket lesson writer runs inside the connectedAccount guard, and its failure never fails the reflection pass", async () => {
    const userId = `post-mortem-lesson-${randomUUID()}`;
    const accountNumber = "APCA-PAPER-LESSON";
    const accountId = randomUUID();
    const { getDb, getUserSetting, insertFillEvent, setActiveConnectedAccount, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { generateReflectionSummary } = await import("../src/lib/post-mortem");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";

    upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Alpaca Paper", isActive: true });
    setActiveConnectedAccount(accountId, userId);
    setPolicy({ ...DEFAULT_POLICY, accountNumber, activeBroker: "alpaca", llmModel: "openai/gpt-4.1-mini" }, userId);

    // 5 closed lots in the SAME thesis x regime bucket -> clears MIN_LOTS_FOR_LESSON_VECTOR (5).
    for (let i = 0; i < 5; i++) {
      insertFillEvent({
        userId,
        accountNumber,
        source: "paper",
        executionMode: "broker/paper",
        symbol: `SYM${i}`,
        side: "buy",
        quantity: 1,
        price: 100,
        notional: 100,
        status: "filled",
        filledAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        raw: { proposal: { tradeThesisTag: "Momentum-Breakout", entryMarketRegime: "Tech-Bull" } }
      });
      insertFillEvent({
        userId,
        accountNumber,
        source: "paper",
        executionMode: "broker/paper",
        symbol: `SYM${i}`,
        side: "sell",
        quantity: 1,
        price: 110,
        notional: 110,
        status: "filled",
        filledAt: `2026-01-0${i + 1}T01:00:00.000Z`
      });
    }

    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ output_text: "lessons applied" }), { status: 200, headers: { "content-type": "application/json" } })
    );

    failAccession = `${userId}:Momentum-Breakout:Tech-Bull`;
    try {
      await expect(generateReflectionSummary(accountNumber, userId)).resolves.toBeUndefined();
    } finally {
      failAccession = undefined;
    }

    // The reflection pass completed and wrote its summary normally despite the bucket-vector failure.
    expect(getUserSetting(userId, `reflection_summary:${accountNumber}`, "")).toBe("lessons applied");

    const db = getDb();
    const degraded = db
      .prepare("SELECT payload FROM audit_events WHERE kind = 'socratic_vector_write_degraded' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    expect(degraded.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(degraded[0].payload).docType).toBe("lesson");

    const summary = db
      .prepare("SELECT payload FROM audit_events WHERE kind = 'reflection_lesson_vectors_written' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    expect(summary).toHaveLength(1);
    const summaryPayload = JSON.parse(summary[0].payload);
    expect(summaryPayload.failed).toBe(1);
  });

  it("ST-4589 B6: with no LLM key the deterministic bucket lessons are still written, once per new-fills signature, with no LLM call", async () => {
    const userId = `post-mortem-nokey-${randomUUID()}`;
    const accountNumber = "APCA-PAPER-NOKEY";
    const accountId = randomUUID();
    const { getUserSetting, insertFillEvent, setActiveConnectedAccount, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { generateReflectionSummary } = await import("../src/lib/post-mortem");
    const { resolveLlmEndpoint } = await import("../src/lib/llm-provider");

    upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Alpaca Paper", isActive: true });
    setActiveConnectedAccount(accountId, userId);
    setPolicy({ ...DEFAULT_POLICY, accountNumber, activeBroker: "alpaca", llmModel: "openai/gpt-4.1-mini" }, userId);
    // Precondition: this harness really has no chat key for the user.
    expect(resolveLlmEndpoint({ ...DEFAULT_POLICY, llmModel: "openai/gpt-4.1-mini" }, userId, "https://api.openai.com/v1/chat/completions").key).toBeFalsy();

    for (let i = 0; i < 5; i++) {
      insertFillEvent({
        userId, accountNumber, source: "paper", executionMode: "broker/paper", symbol: `NK${i}`, side: "buy",
        quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-02-0${i + 1}T00:00:00.000Z`,
        raw: { proposal: { tradeThesisTag: "Momentum-Breakout", entryMarketRegime: "Tech-Bull" } }
      });
      insertFillEvent({
        userId, accountNumber, source: "paper", executionMode: "broker/paper", symbol: `NK${i}`, side: "sell",
        quantity: 1, price: 110, notional: 110, status: "filled", filledAt: `2026-02-0${i + 1}T01:00:00.000Z`
      });
    }

    const fetchSpy = vi.fn(async () => {
      throw new Error("no network call expected on the no-key path");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const accession = `${userId}:Momentum-Breakout:Tech-Bull`;
    const writesFor = () => storeContextsCalls.filter((c) => c.documents[0]?.metadata?.accession === accession).length;

    await generateReflectionSummary(accountNumber, userId);
    expect(writesFor()).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    // No LLM reflection was produced.
    expect(getUserSetting(userId, `reflection_summary:${accountNumber}`, "")).toBe("");

    // Same fills -> deduped, no second write.
    await generateReflectionSummary(accountNumber, userId);
    expect(writesFor()).toBe(1);
  });

  it("ST-4589: a failed bucket does not record the deterministic-lesson signature, so the next run retries", async () => {
    const userId = `post-mortem-retry-${randomUUID()}`;
    const accountNumber = "APCA-PAPER-RETRY";
    const accountId = randomUUID();
    const { getInternalSetting, insertFillEvent, setActiveConnectedAccount, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { generateReflectionSummary } = await import("../src/lib/post-mortem");

    upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Alpaca Paper", isActive: true });
    setActiveConnectedAccount(accountId, userId);
    setPolicy({ ...DEFAULT_POLICY, accountNumber, activeBroker: "alpaca", llmModel: "openai/gpt-4.1-mini" }, userId);
    for (let i = 0; i < 5; i++) {
      insertFillEvent({
        userId, accountNumber, source: "paper", executionMode: "broker/paper", symbol: `RT${i}`, side: "buy",
        quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-03-0${i + 1}T00:00:00.000Z`,
        raw: { proposal: { tradeThesisTag: "Momentum-Breakout", entryMarketRegime: "Tech-Bull" } }
      });
      insertFillEvent({
        userId, accountNumber, source: "paper", executionMode: "broker/paper", symbol: `RT${i}`, side: "sell",
        quantity: 1, price: 110, notional: 110, status: "filled", filledAt: `2026-03-0${i + 1}T01:00:00.000Z`
      });
    }
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("no network call expected on the no-key path");
    }));

    const accession = `${userId}:Momentum-Breakout:Tech-Bull`;
    const signatureKey = `reflection_lesson_signature:${userId}:${accountNumber}`;
    const writesFor = () => storeContextsCalls.filter((c) => c.documents[0]?.metadata?.accession === accession).length;

    failAccession = accession;
    try {
      await generateReflectionSummary(accountNumber, userId);
    } finally {
      failAccession = undefined;
    }
    expect(writesFor()).toBe(0);
    expect(getInternalSetting<string>(signatureKey)).toBeFalsy();

    // Same fills, store healthy again -> retried and now recorded.
    await generateReflectionSummary(accountNumber, userId);
    expect(writesFor()).toBe(1);
    expect(getInternalSetting<string>(signatureKey)).toBeTruthy();
  });

  async function seedNoKeyAccount(prefix: string) {
    const userId = `post-mortem-${prefix}-${randomUUID()}`;
    const accountNumber = `APCA-PAPER-${prefix.toUpperCase()}`;
    const accountId = randomUUID();
    const { insertFillEvent, setActiveConnectedAccount, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Alpaca Paper", isActive: true });
    setActiveConnectedAccount(accountId, userId);
    setPolicy({ ...DEFAULT_POLICY, accountNumber, activeBroker: "alpaca", llmModel: "openai/gpt-4.1-mini" }, userId);
    for (let i = 0; i < 5; i++) {
      insertFillEvent({
        userId, accountNumber, source: "paper", executionMode: "broker/paper", symbol: `${prefix}${i}`, side: "buy",
        quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-04-0${i + 1}T00:00:00.000Z`,
        raw: { proposal: { tradeThesisTag: "Momentum-Breakout", entryMarketRegime: "Tech-Bull" } }
      });
      insertFillEvent({
        userId, accountNumber, source: "paper", executionMode: "broker/paper", symbol: `${prefix}${i}`, side: "sell",
        quantity: 1, price: 110, notional: 110, status: "filled", filledAt: `2026-04-0${i + 1}T01:00:00.000Z`
      });
    }
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("no network call expected on the no-key path");
    }));
    return { userId, accountNumber, signatureKey: `reflection_lesson_signature:${userId}:${accountNumber}` };
  }

  it("ST-4589: an exact dedup hit (skipped + dedupComplete) counts as written, does not warn, and records the signature", async () => {
    const { getInternalSetting } = await import("../src/lib/db");
    const { generateReflectionSummary, writeThesisRegimeLessonVectors } = await import("../src/lib/post-mortem");
    const { userId, accountNumber, signatureKey } = await seedNoKeyAccount("DD");
    const warn = vi.spyOn(console, "warn");
    storeResultOverride = { indexed: 0, skipped: true, dedupComplete: true };
    try {
      await expect(writeThesisRegimeLessonVectors([stat("Momentum", "Bull", 6)], userId, [])).resolves.toEqual({
        attempted: 1, written: 1, skipped: 0, failed: 0
      });
      await generateReflectionSummary(accountNumber, userId);
    } finally {
      storeResultOverride = undefined;
    }
    expect(getInternalSetting<string>(signatureKey)).toBeTruthy();
    expect(warn.mock.calls.some((call) => String(call[0]).includes("lesson vector write skipped"))).toBe(false);
    warn.mockRestore();
  });

  it("ST-4589: a plain skip (no dedupComplete, e.g. unconfigured store) or a budget skip is not recorded", async () => {
    const { getInternalSetting } = await import("../src/lib/db");
    const { generateReflectionSummary, writeThesisRegimeLessonVectors } = await import("../src/lib/post-mortem");
    const { userId, accountNumber, signatureKey } = await seedNoKeyAccount("PS");
    storeResultOverride = { indexed: 0, skipped: true, unconfigured: true };
    try {
      await generateReflectionSummary(accountNumber, userId);
      expect(getInternalSetting<string>(signatureKey)).toBeFalsy();
      // A dedupComplete flag does not excuse a budget skip.
      storeResultOverride = { indexed: 0, skipped: true, dedupComplete: true, budgetSkipped: 1 };
      await expect(writeThesisRegimeLessonVectors([stat("Momentum", "Bull", 6)], userId, [])).resolves.toEqual({
        attempted: 1, written: 0, skipped: 1, failed: 0
      });
    } finally {
      storeResultOverride = undefined;
    }
  });
});
