import { describe, expect, it } from "vitest";
import { decideStageBudget } from "../src/lib/chat/stage-budget";
import { cancelChatTurn, registerChatTurn, releaseChatTurn } from "../src/lib/chat/turn-registry";

describe("decideStageBudget", () => {
  it("always runs step 0", () => {
    const decision = decideStageBudget({ stepIndex: 0, deadlineMs: 0, nowMs: 10_000, minStageBudgetMs: 15_000 });
    expect(decision.action).toBe("run");
  });

  it("skips later steps when remaining is thin", () => {
    const decision = decideStageBudget({
      stepIndex: 2,
      deadlineMs: 20_000,
      nowMs: 10_000,
      minStageBudgetMs: 15_000
    });
    expect(decision).toMatchObject({ action: "skip", reason: "remaining_below_min_stage" });
  });
});

describe("chat turn registry", () => {
  it("409s a duplicate in-flight key and cancels", () => {
    const key = `test-${Date.now()}`;
    registerChatTurn({ turnKey: key, userId: "u1" });
    expect(() => registerChatTurn({ turnKey: key, userId: "u1" })).toThrow(/chat_turn_in_flight/);
    expect(cancelChatTurn(key, "u1")).toBe(true);
    releaseChatTurn(key);
    expect(cancelChatTurn(key, "u1")).toBe(false);
  });
});
