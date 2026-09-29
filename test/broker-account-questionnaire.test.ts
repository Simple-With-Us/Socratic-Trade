import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Root cause (2026-09-25, board 687a5fb4, lane G3): production evidence on the live Robinhood
// "Agentic" account showed 3 `placing_failed` rejections for "We're required to have you answer
// some questions about y[our...]" — an ACCOUNT-level Robinhood compliance gate, not a per-order
// sizing problem. This suite covers detection of that specific error text and the durable
// account-level hold it sets, independent of the strategy-loop wiring (covered by
// final-size-red-autonomous.test.ts-style integration elsewhere).
beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-account-questionnaire-${randomUUID()}.db`)}`;
});

describe("detectRobinhoodAccountQuestionnaireError", () => {
  it("matches the exact production error text (truncated mid-sentence)", async () => {
    const { detectRobinhoodAccountQuestionnaireError } = await import("../src/lib/broker-account-questionnaire");
    const message =
      'Robinhood place_equity_order response had no order id: {"text":"API error 400: {\\"non_field_errors\\":[\\"We\'re required to have you answer some questions about y';
    const reason = detectRobinhoodAccountQuestionnaireError(message);
    expect(reason).toContain("Robinhood");
    expect(reason).toContain("questionnaire");
  });

  it("does not match an unrelated 4xx error", async () => {
    const { detectRobinhoodAccountQuestionnaireError } = await import("../src/lib/broker-account-questionnaire");
    const reason = detectRobinhoodAccountQuestionnaireError("API error 400: Fractional orders must be at least $1.");
    expect(reason).toBeUndefined();
  });

  it("does not match an empty or generic message", async () => {
    const { detectRobinhoodAccountQuestionnaireError } = await import("../src/lib/broker-account-questionnaire");
    expect(detectRobinhoodAccountQuestionnaireError("")).toBeUndefined();
    expect(detectRobinhoodAccountQuestionnaireError("network timeout")).toBeUndefined();
  });
});

describe("account-level action-required state", () => {
  it("is unset until marked, then reads back the reason and a since timestamp", async () => {
    const { getAccountActionRequired, markAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    const userId = `questionnaire-user-${randomUUID()}`;
    expect(getAccountActionRequired(userId, "RH-ACCOUNT")).toBeUndefined();

    markAccountActionRequired(userId, "RH-ACCOUNT", "Robinhood requires you to answer account questions.");
    const state = getAccountActionRequired(userId, "RH-ACCOUNT");
    expect(state?.reason).toBe("Robinhood requires you to answer account questions.");
    expect(typeof state?.since).toBe("string");
  });

  it("is scoped per (user, accountNumber) — not global", async () => {
    const { getAccountActionRequired, markAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    const userId = `questionnaire-user-${randomUUID()}`;
    markAccountActionRequired(userId, "RH-ACCOUNT-A", "held A");
    expect(getAccountActionRequired(userId, "RH-ACCOUNT-B")).toBeUndefined();
    expect(getAccountActionRequired(`other-${userId}`, "RH-ACCOUNT-A")).toBeUndefined();
    expect(getAccountActionRequired(userId, "RH-ACCOUNT-A")?.reason).toBe("held A");
  });

  it("clears on clearAccountActionRequired and is a no-op when nothing is held", async () => {
    const { clearAccountActionRequired, getAccountActionRequired, markAccountActionRequired } = await import(
      "../src/lib/broker-account-questionnaire"
    );
    const userId = `questionnaire-user-${randomUUID()}`;
    markAccountActionRequired(userId, "RH-ACCOUNT", "held");
    clearAccountActionRequired(userId, "RH-ACCOUNT");
    expect(getAccountActionRequired(userId, "RH-ACCOUNT")).toBeUndefined();
    expect(() => clearAccountActionRequired(userId, "RH-ACCOUNT")).not.toThrow();
  });

  it("re-marking refreshes the reason and last attempt but keeps the ORIGINAL since (idempotent, not duplicated)", async () => {
    const { getAccountActionRequired, markAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    const userId = `questionnaire-user-${randomUUID()}`;
    const t0 = Date.parse("2026-09-28T12:00:00.000Z");
    markAccountActionRequired(userId, "RH-ACCOUNT", "first", t0);
    const first = getAccountActionRequired(userId, "RH-ACCOUNT");
    markAccountActionRequired(userId, "RH-ACCOUNT", "second", t0 + 6 * 60 * 60_000);
    const second = getAccountActionRequired(userId, "RH-ACCOUNT");
    expect(first?.reason).toBe("first");
    expect(second?.reason).toBe("second");
    expect(second?.since).toBe(first?.since);
    expect(second?.lastAttemptAt).toBe(new Date(t0 + 6 * 60 * 60_000).toISOString());
  });
});

// Audit of the merged G3 change (2026-09-29): the hold used to clear ONLY when an opening order was
// accepted, but the run loop refused to place ANY opening order while the hold was set — so the
// hold could never clear by itself, and the "clears automatically" promise in the owner alert was
// false.  The gate is now half-open: after each retry interval ONE entry is let through as a probe.
describe("evaluateAccountActionRequiredGate (self-clearing hold)", () => {
  const T0 = Date.parse("2026-09-28T12:00:00.000Z");

  it("is clear when nothing is held", async () => {
    const { evaluateAccountActionRequiredGate } = await import("../src/lib/broker-account-questionnaire");
    expect(evaluateAccountActionRequiredGate(`gate-${randomUUID()}`, "RH-ACCOUNT", T0)).toEqual({ kind: "clear" });
  });

  it("holds entries right after a rejection and for the whole retry interval", async () => {
    const { ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS, evaluateAccountActionRequiredGate, markAccountActionRequired } = await import(
      "../src/lib/broker-account-questionnaire"
    );
    const userId = `gate-${randomUUID()}`;
    markAccountActionRequired(userId, "RH-ACCOUNT", "held", T0);
    expect(evaluateAccountActionRequiredGate(userId, "RH-ACCOUNT", T0).kind).toBe("hold");
    expect(evaluateAccountActionRequiredGate(userId, "RH-ACCOUNT", T0 + ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS - 1).kind).toBe("hold");
  });

  it("lets a probe entry through once the retry interval has elapsed (the hold must be escapable)", async () => {
    const { ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS, evaluateAccountActionRequiredGate, markAccountActionRequired } = await import(
      "../src/lib/broker-account-questionnaire"
    );
    const userId = `gate-${randomUUID()}`;
    markAccountActionRequired(userId, "RH-ACCOUNT", "held", T0);
    const gate = evaluateAccountActionRequiredGate(userId, "RH-ACCOUNT", T0 + ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS);
    expect(gate.kind).toBe("probe");
  });

  it("a probe that is rejected again re-arms the hold for a full interval", async () => {
    const { ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS, evaluateAccountActionRequiredGate, markAccountActionRequired } = await import(
      "../src/lib/broker-account-questionnaire"
    );
    const userId = `gate-${randomUUID()}`;
    markAccountActionRequired(userId, "RH-ACCOUNT", "held", T0);
    const probeAt = T0 + ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS;
    expect(evaluateAccountActionRequiredGate(userId, "RH-ACCOUNT", probeAt).kind).toBe("probe");
    // The probe reached the broker and was refused again -> the strategy loop re-marks.
    markAccountActionRequired(userId, "RH-ACCOUNT", "held", probeAt);
    expect(evaluateAccountActionRequiredGate(userId, "RH-ACCOUNT", probeAt + 1).kind).toBe("hold");
    expect(evaluateAccountActionRequiredGate(userId, "RH-ACCOUNT", probeAt + ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS).kind).toBe("probe");
  });

  it("a probe that is accepted clears the hold entirely", async () => {
    const { ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS, clearAccountActionRequired, evaluateAccountActionRequiredGate, markAccountActionRequired } =
      await import("../src/lib/broker-account-questionnaire");
    const userId = `gate-${randomUUID()}`;
    markAccountActionRequired(userId, "RH-ACCOUNT", "held", T0);
    const probeAt = T0 + ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS;
    expect(evaluateAccountActionRequiredGate(userId, "RH-ACCOUNT", probeAt).kind).toBe("probe");
    clearAccountActionRequired(userId, "RH-ACCOUNT");
    expect(evaluateAccountActionRequiredGate(userId, "RH-ACCOUNT", probeAt + 1)).toEqual({ kind: "clear" });
  });

  it("a state persisted by the merged version (no lastAttemptAt) falls back to since so it can still probe", async () => {
    const { ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS, evaluateAccountActionRequiredGate } = await import(
      "../src/lib/broker-account-questionnaire"
    );
    const { setInternalSetting } = await import("../src/lib/db");
    const userId = `gate-${randomUUID()}`;
    setInternalSetting(`robinhoodAccountActionRequired:${userId}:RH-ACCOUNT`, { reason: "legacy", since: new Date(T0).toISOString() });
    expect(evaluateAccountActionRequiredGate(userId, "RH-ACCOUNT", T0 + 1).kind).toBe("hold");
    expect(evaluateAccountActionRequiredGate(userId, "RH-ACCOUNT", T0 + ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS).kind).toBe("probe");
  });

  it("an unparseable timestamp probes instead of holding forever", async () => {
    const { evaluateAccountActionRequiredGate } = await import("../src/lib/broker-account-questionnaire");
    const { setInternalSetting } = await import("../src/lib/db");
    const userId = `gate-${randomUUID()}`;
    setInternalSetting(`robinhoodAccountActionRequired:${userId}:RH-ACCOUNT`, { reason: "corrupt", since: "not-a-date" });
    expect(evaluateAccountActionRequiredGate(userId, "RH-ACCOUNT", T0).kind).toBe("probe");
  });
});

describe("shouldAlertAccountActionRequired cooldown", () => {
  it("alerts once per (user, accountNumber) and suppresses a second call within the cooldown window", async () => {
    const { shouldAlertAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    const userId = `questionnaire-alert-${randomUUID()}`;
    expect(shouldAlertAccountActionRequired(userId, "RH-ACCOUNT")).toBe(true);
    expect(shouldAlertAccountActionRequired(userId, "RH-ACCOUNT")).toBe(false);
  });

  it("cooldown is scoped per (user, accountNumber), not global", async () => {
    const { shouldAlertAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    const userId = `questionnaire-alert-${randomUUID()}`;
    expect(shouldAlertAccountActionRequired(userId, "RH-ACCOUNT-A")).toBe(true);
    expect(shouldAlertAccountActionRequired(userId, "RH-ACCOUNT-B")).toBe(true);
    expect(shouldAlertAccountActionRequired(`other-${userId}`, "RH-ACCOUNT-A")).toBe(true);
  });
});
