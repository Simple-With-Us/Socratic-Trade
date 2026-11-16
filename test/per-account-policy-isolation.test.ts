/**
 * Per-account state isolation test (PR 1).
 *
 * One user with two connected accounts must get fully independent live policy /
 * system state per account, while strategy_profiles remains the shared user-level
 * library. The active account's live state is what getPolicy(userId) returns;
 * getPolicy(userId, accountId) addresses a specific account directly.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-per-account-isolation-${randomUUID()}.db`)}`;
});

describe("per-account policy isolation (PR 1)", () => {
  const userId = `user-${randomUUID()}`;
  const a1 = `acct-1-${randomUUID()}`;
  const a2 = `acct-2-${randomUUID()}`;

  it("each connected account holds an independent live policy", async () => {
    const db = await import("../src/lib/db");

    db.upsertConnectedAccount({ id: a1, userId, broker: "alpaca", environment: "paper", accountNumber: "PA1", label: "Acct 1", isActive: true });
    db.upsertConnectedAccount({ id: a2, userId, broker: "alpaca", environment: "paper", accountNumber: "PA2", label: "Acct 2", isActive: false });

    // A1 is active: set a distinct cap, which lands on A1's live state.
    db.setPolicy({ ...db.getPolicy(userId), maxOrderNotional: 1111 }, userId);
    // Address A2 directly without switching the active account.
    db.setPolicy({ ...db.getPolicy(userId, a2), maxOrderNotional: 2222 }, userId, a2);

    expect(db.getPolicy(userId, a1).maxOrderNotional).toBe(1111);
    expect(db.getPolicy(userId, a2).maxOrderNotional).toBe(2222);
    // The user-level (active-account) view follows A1 while it is active.
    expect(db.getPolicy(userId).maxOrderNotional).toBe(1111);

    // Switching the active account flips the user-level view to A2's live state.
    db.setActiveConnectedAccount(a2, userId);
    expect(db.getPolicy(userId).maxOrderNotional).toBe(2222);
  });

  it("system state (kill-switch / run mode) is per account", async () => {
    const db = await import("../src/lib/db");

    db.setPolicy({ ...db.getPolicy(userId, a1), systemState: "active" }, userId, a1);
    db.setPolicy({ ...db.getPolicy(userId, a2), systemState: "halted" }, userId, a2);

    expect(db.getPolicy(userId, a1).systemState).toBe("active");
    expect(db.getPolicy(userId, a2).systemState).toBe("halted");
  });

  it("activeBroker is derived from each account's own broker — an account is an account", async () => {
    const db = await import("../src/lib/db");
    const testAcct = `acct-test-${randomUUID()}`;
    db.upsertConnectedAccount({ id: testAcct, userId, broker: "test", environment: "paper", label: "Sim", isActive: false });

    expect(db.getPolicy(userId, testAcct).activeBroker).toBe("test");
    expect(db.getPolicy(userId, a1).activeBroker).toBe("alpaca");
    // No policy-level paperMode override exists anymore: paper vs live is purely the connected
    // account's own `environment`, never a policy flag.
    expect((db.getPolicy(userId, testAcct) as unknown as Record<string, unknown>).paperMode).toBeUndefined();
    expect((db.getPolicy(userId, a1) as unknown as Record<string, unknown>).paperMode).toBeUndefined();
  });

  it("run-lock is per account — one account's lock doesn't block another", async () => {
    const db = await import("../src/lib/db");
    const u = `lockuser-${randomUUID()}`;
    const x = `acct-x-${randomUUID()}`;
    const y = `acct-y-${randomUUID()}`;

    expect(db.acquireStrategyLock("owner1", u, x)).toBe(true);
    expect(db.acquireStrategyLock("owner2", u, x)).toBe(false); // same account re-lock blocked
    expect(db.acquireStrategyLock("owner3", u, y)).toBe(true);  // different account NOT blocked

    db.releaseStrategyLock("owner1", u, x);
    expect(db.acquireStrategyLock("owner4", u, x)).toBe(true);

    db.releaseStrategyLock("owner4", u, x);
    db.releaseStrategyLock("owner3", u, y);
    expect(db.acquireStrategyLock("owner5", u, x)).toBe(true);
    expect(db.acquireStrategyLock("owner6", u, y)).toBe(true);
  });

  it("strategy runs and the cadence clock are per account", async () => {
    const db = await import("../src/lib/db");
    const u = `runuser-${randomUUID()}`;
    const x = `racct-x-${randomUUID()}`;
    const y = `racct-y-${randomUUID()}`;

    db.insertStrategyRun(randomUUID(), u, x);
    expect(db.getLastStrategyRunStartedAt(u, x)).not.toBeNull();
    expect(db.getLastStrategyRunStartedAt(u, y)).toBeNull(); // account y has no runs of its own
  });

  it("a newly-seeded non-active account never auto-arms autonomy (seeds 'halted')", async () => {
    const db = await import("../src/lib/db");
    const u = `armuser-${randomUUID()}`;
    const active = `active-${randomUUID()}`;
    const other = `other-${randomUUID()}`;

    db.upsertConnectedAccount({ id: active, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-A", label: "Active", isActive: true });
    db.upsertConnectedAccount({ id: other, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-O", label: "Other", isActive: false });

    // Arm autonomy on the active account.
    db.setPolicy({ ...db.getPolicy(u, active), systemState: "active" }, u, active);
    expect(db.getPolicy(u, active).systemState).toBe("active");

    // First touch of the non-active account must NOT inherit "active" — it seeds "halted" so the
    // multi-account scheduler can't silently start trading a dormant account.
    expect(db.getPolicy(u, other).systemState).toBe("halted");
  });

  it("requireTypedConfirmation is user-level — one switch spans every account", async () => {
    // Promoted to USER_LEVEL_POLICY_FIELDS in the 2026-07-10 Settings IA restructure: the
    // typed-phrase ceremony is an owner preference, not a per-account guardrail.
    const db = await import("../src/lib/db");
    const u = `typeduser-${randomUUID()}`;
    const p = `tacct-p-${randomUUID()}`;
    const q = `tacct-q-${randomUUID()}`;

    db.upsertConnectedAccount({ id: p, userId: u, broker: "alpaca", environment: "paper", accountNumber: "TP1", label: "P", isActive: true });
    db.upsertConnectedAccount({ id: q, userId: u, broker: "alpaca", environment: "live", accountNumber: "TQ1", label: "Q", isActive: false });

    // Default: required (true) on every account.
    expect(db.getPolicy(u, p).requireTypedConfirmation).toBe(true);
    expect(db.getPolicy(u, q).requireTypedConfirmation).toBe(true);

    // Turning it off through ONE account applies to the whole login…
    db.setPolicy({ ...db.getPolicy(u, p), requireTypedConfirmation: false }, u, p);
    expect(db.getPolicy(u, p).requireTypedConfirmation).toBe(false);
    expect(db.getPolicy(u, q).requireTypedConfirmation).toBe(false);

    // …and a stale divergent per-account value (pre-promotion legacy row) is
    // superseded by the user-level overlay on read, never resurrected.
    const raw = db
      .getDb()
      .prepare("SELECT policy FROM account_strategy_state WHERE user_id = ? AND connected_account_id = ?")
      .get(u, q) as { policy: string };
    const legacy = JSON.parse(raw.policy) as Record<string, unknown>;
    legacy.requireTypedConfirmation = true; // divergent account-scoped leftover
    db.getDb()
      .prepare("UPDATE account_strategy_state SET policy = ? WHERE user_id = ? AND connected_account_id = ?")
      .run(JSON.stringify(legacy), u, q);
    expect(db.getPolicy(u, q).requireTypedConfirmation).toBe(false);
  });

  it("deleting a connected account purges its per-account isolated state", async () => {
    const db = await import("../src/lib/db");
    const u = `deluser-${randomUUID()}`;
    const keep = `keep-${randomUUID()}`;
    const drop = `drop-${randomUUID()}`;

    db.upsertConnectedAccount({ id: keep, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-K", label: "Keep", isActive: true });
    db.upsertConnectedAccount({ id: drop, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-D", label: "Drop", isActive: false });

    // Seed per-account state for both accounts.
    db.setPolicy({ ...db.getPolicy(u, keep), maxOrderNotional: 500 }, u, keep);
    db.setPolicy({ ...db.getPolicy(u, drop), maxOrderNotional: 600 }, u, drop);
    db.insertStrategyRun(randomUUID(), u, drop);
    db.setCounterfactualLearningWatermark({ userId: u, connectedAccountId: drop, lastAuditRowid: 42 });

    expect(db.purgeConnectedAccount(drop, u)).toBe(true);

    // Dropped account's isolated state is gone…
    expect(db.getLastStrategyRunStartedAt(u, drop)).toBeNull();
    expect(db.getCounterfactualLearningWatermark(u, drop)).toBeUndefined();
    // …while the kept account's state survives untouched.
    expect(db.getPolicy(u, keep).maxOrderNotional).toBe(500);
  });

  it("strategy model choices are account-scoped with a one-time legacy user seed", async () => {
    const db = await import("../src/lib/db");
    const u = `modeluser-${randomUUID()}`;
    const active = `model-active-${randomUUID()}`;
    const other = `model-other-${randomUUID()}`;

    db.upsertConnectedAccount({ id: active, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-A", label: "Active", isActive: true });
    db.upsertConnectedAccount({ id: other, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-O", label: "Other", isActive: false });

    db.setUserSetting(u, "policy", {
      llmModel: "xai/grok-4.3",
      redTeamLlmModel: "anthropic/claude-opus-4-8",
      llmReasoningEffort: "high"
    });

    const stalePolicy = { ...db.getPolicy(u, other) };
    delete stalePolicy.llmModel;
    delete stalePolicy.redTeamLlmModel;
    delete stalePolicy.llmReasoningEffort;
    db.getDb()
      .prepare(
        `INSERT OR REPLACE INTO account_strategy_state
           (user_id, connected_account_id, policy, prompt, scoring_weights, system_state, derived_from_profile_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        u,
        other,
        JSON.stringify(stalePolicy),
        "Prompt",
        JSON.stringify(stalePolicy.scoringWeights),
        stalePolicy.systemState,
        null,
        new Date().toISOString()
      );

    expect(db.getPolicy(u, other).llmModel).toBe("xai/grok-4.3");
    expect(db.getPolicy(u, other).redTeamLlmModel).toBe("anthropic/claude-opus-4-8");
    expect(db.getPolicy(u, other).llmReasoningEffort).toBe("high");

    db.setPolicy({ ...db.getPolicy(u, active), llmModel: "openai/gpt-5.5", redTeamLlmModel: "gpt-5.4" }, u, active);
    db.setPolicy({ ...db.getPolicy(u, other), llmModel: "gemini-2.5-flash", redTeamLlmModel: undefined }, u, other);

    expect(db.getPolicy(u, active).llmModel).toBe("openai/gpt-5.5");
    expect(db.getPolicy(u, active).redTeamLlmModel).toBe("gpt-5.4");
    expect(db.getPolicy(u, other).llmModel).toBe("gemini-2.5-flash");
    expect(db.getPolicy(u, other).redTeamLlmModel).toBeUndefined();

    const userPolicy = db.getUserSetting<Record<string, unknown>>(u, "policy", {});
    expect(userPolicy.llmModel).toBeUndefined();
    expect(userPolicy.redTeamLlmModel).toBeUndefined();
    expect(userPolicy.llmReasoningEffort).toBeUndefined();

    const row = db.getDb()
      .prepare("SELECT policy FROM account_strategy_state WHERE user_id = ? AND connected_account_id = ?")
      .get(u, other) as { policy: string };
    expect(JSON.parse(row.policy).llmModel).toBe("gemini-2.5-flash");
    expect(JSON.parse(row.policy).redTeamLlmModel).toBeUndefined();
  });

  it("migrates legacy model choices to every account before clearing user policy", async () => {
    const db = await import("../src/lib/db");
    const u = `legacy-migrate-${randomUUID()}`;
    const active = `legacy-active-${randomUUID()}`;
    const other = `legacy-other-${randomUUID()}`;
    const untouched = `legacy-untouched-${randomUUID()}`;

    db.upsertConnectedAccount({ id: active, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-A", label: "Active", isActive: true });
    db.upsertConnectedAccount({ id: other, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-O", label: "Other", isActive: false });
    db.upsertConnectedAccount({ id: untouched, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-U", label: "Untouched", isActive: false });

    db.setUserSetting(u, "policy", {
      llmModel: "xai/grok-4.3",
      redTeamLlmModel: "anthropic/claude-opus-4-8",
      llmReasoningEffort: "high"
    });

    const stalePolicy = { ...db.getPolicy(u, active) };
    delete stalePolicy.llmModel;
    delete stalePolicy.redTeamLlmModel;
    delete stalePolicy.llmReasoningEffort;
    db.getDb()
      .prepare(
        `INSERT OR REPLACE INTO account_strategy_state
           (user_id, connected_account_id, policy, prompt, scoring_weights, system_state, derived_from_profile_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        u,
        other,
        JSON.stringify(stalePolicy),
        "Prompt",
        JSON.stringify(stalePolicy.scoringWeights),
        stalePolicy.systemState,
        null,
        new Date().toISOString()
      );

    db.setPolicy({ ...db.getPolicy(u, active), maxOrderNotional: 1234 }, u, active);

    const userPolicy = db.getUserSetting<Record<string, unknown>>(u, "policy", {});
    expect(userPolicy.llmModel).toBeUndefined();
    expect(userPolicy.redTeamLlmModel).toBeUndefined();
    expect(userPolicy.llmReasoningEffort).toBeUndefined();

    expect(db.getPolicy(u, other).llmModel).toBe("xai/grok-4.3");
    expect(db.getPolicy(u, other).redTeamLlmModel).toBe("anthropic/claude-opus-4-8");
    expect(db.getPolicy(u, other).llmReasoningEffort).toBe("high");

    expect(db.getPolicy(u, untouched).llmModel).toBe("xai/grok-4.3");
    expect(db.getPolicy(u, untouched).redTeamLlmModel).toBe("anthropic/claude-opus-4-8");
    expect(db.getPolicy(u, untouched).llmReasoningEffort).toBe("high");
  });

  it("counterfactual learning watermark is isolated per account", async () => {
    const db = await import("../src/lib/db");
    const u = `wmuser-${randomUUID()}`;
    const x = `wacct-x-${randomUUID()}`;
    const y = `wacct-y-${randomUUID()}`;

    db.setCounterfactualLearningWatermark({ userId: u, connectedAccountId: x, lastAuditRowid: 100 });
    db.setCounterfactualLearningWatermark({ userId: u, connectedAccountId: y, lastAuditRowid: 7 });

    expect(db.getCounterfactualLearningWatermark(u, x)?.lastAuditRowid).toBe(100);
    expect(db.getCounterfactualLearningWatermark(u, y)?.lastAuditRowid).toBe(7);
    // The account-agnostic (user-wide) watermark is a distinct row, untouched by the per-account ones.
    expect(db.getCounterfactualLearningWatermark(u)).toBeUndefined();
  });

  it("matured skipped-candidate counterfactuals read back per account", async () => {
    const db = await import("../src/lib/db");
    const u = `cfuser-${randomUUID()}`;
    const x = `cacct-x-${randomUUID()}`;
    const y = `cacct-y-${randomUUID()}`;

    // One skipped candidate per account, then mature each.
    db.insertSkippedCounterfactualCandidate({
      userId: u, connectedAccountId: x, runId: "rx", symbol: "AAA",
      snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 10, horizonDays: 5, targetDate: "2026-06-06"
    });
    db.insertSkippedCounterfactualCandidate({
      userId: u, connectedAccountId: y, runId: "ry", symbol: "BBB",
      snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 20, horizonDays: 5, targetDate: "2026-06-06"
    });
    db.markSkippedCounterfactualMatured({ id: `${u}:rx:AAA:5`, userId: u, exitDate: "2026-06-06", exitPrice: 12, returnPct: 20 });
    db.markSkippedCounterfactualMatured({ id: `${u}:ry:BBB:5`, userId: u, exitDate: "2026-06-06", exitPrice: 22, returnPct: 10 });

    const xRows = db.listMaturedSkippedCounterfactuals(u, 50, x);
    const yRows = db.listMaturedSkippedCounterfactuals(u, 50, y);
    expect(xRows.map((r) => r.symbol)).toEqual(["AAA"]);
    expect(yRows.map((r) => r.symbol)).toEqual(["BBB"]);
    // User-wide read (no account) still sees both — back-compat.
    expect(db.listMaturedSkippedCounterfactuals(u, 50).length).toBe(2);
  });
});
