/**
 * `policy.patch` + `expectedCurrent` — the server half of the phone's "these controls only
 * tighten" promise.
 *
 * `policy.patch` is a QUEUED mobile command, so minutes can pass between the tap that computed a
 * lowered cap and the write that applies it (a draining `strategy.run_once` sits in front of it).
 * `applyPolicyPatch` merges verbatim in either direction, so a reduction tapped against a $10,000
 * cap that the console lowers to $2,000 in that window would execute as a LOOSENING. The optional
 * `expectedCurrent` precondition — the exact counterpart of `order.cancel`'s
 * `expectedAccountNumber` — refuses that patch instead.
 *
 * Covered: precondition matches (applies), mismatch (refused + policy untouched + audited),
 * ABSENT (legacy behaviour, byte-for-byte unchanged), partial preconditions, unset/null
 * expectations, and unknown or malformed precondition fields.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mobile-policy-precondition-${randomUUID()}.db`)}`;
});

async function seedUser(policy: Record<string, unknown>) {
  const { getPolicy, setPolicy } = await import("../src/lib/db");
  const userId = `mobile-precondition-${randomUUID()}`;
  setPolicy({ ...getPolicy(userId), ...policy }, userId);
  return userId;
}

/** Queue + drain one command through the real worker, and hand back its terminal record. */
async function runPatch(userId: string, payload: Record<string, unknown>) {
  const { queueMobileCommand, processPendingMobileCommands, listMobileCommands } = await import(
    "../src/lib/mobile-api"
  );
  const { command } = queueMobileCommand({ userId, commandType: "policy.patch", payload });
  await processPendingMobileCommands({ limit: 5 });
  const finished = listMobileCommands({ userId }).find((item) => item.id === command.id);
  if (!finished) throw new Error("command vanished from the queue");
  return { queued: command, finished };
}

describe("policy.patch expectedCurrent precondition", () => {
  it("applies the patch when every precondition still matches", async () => {
    const { getPolicy } = await import("../src/lib/db");
    const userId = await seedUser({ maxOrderNotional: 10_000, maxOrderPctOfNav: undefined });

    const { queued, finished } = await runPatch(userId, {
      patch: { maxOrderNotional: 2_500 },
      expectedCurrent: { maxOrderNotional: 10_000 }
    });

    // The precondition survives normalization and is stored on the queued command.
    expect(queued.payload).toMatchObject({
      patch: { maxOrderNotional: 2_500 },
      expectedCurrent: { maxOrderNotional: 10_000 }
    });
    expect(finished.status).toBe("succeeded");
    expect(getPolicy(userId).maxOrderNotional).toBe(2_500);
  });

  it("refuses the patch when the guarded value moved, leaving the policy untouched", async () => {
    const { getPolicy, setPolicy, listAudit } = await import("../src/lib/db");
    const userId = await seedUser({ maxOrderNotional: 10_000, maxOrderPctOfNav: undefined });

    const { queueMobileCommand, processPendingMobileCommands, listMobileCommands } = await import(
      "../src/lib/mobile-api"
    );
    // Tapped while the cap read $10,000...
    const { command } = queueMobileCommand({
      userId,
      commandType: "policy.patch",
      payload: { patch: { maxOrderNotional: 7_500 }, expectedCurrent: { maxOrderNotional: 10_000 } }
    });
    // ...and lowered from the console before the queue got to it. Executing the queued patch now
    // would RAISE the cap from 2,000 back to 7,500 — the loosening this guard exists to stop.
    setPolicy({ ...getPolicy(userId), maxOrderNotional: 2_000 }, userId);
    await processPendingMobileCommands({ limit: 5 });

    const finished = listMobileCommands({ userId }).find((item) => item.id === command.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.error).toContain("maxOrderNotional changed since this was sent");
    expect(finished?.result).toMatchObject({
      error: "policy_precondition_mismatch",
      field: "maxOrderNotional",
      expected: 10_000,
      actual: 2_000
    });
    // Nothing applied — not the guarded field, not any other field of the patch.
    expect(getPolicy(userId).maxOrderNotional).toBe(2_000);

    const mismatches = listAudit(50, userId).filter(
      (event) => event.kind === "mobile_policy_patch_precondition_mismatch"
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].payload).toMatchObject({
      field: "maxOrderNotional",
      expected: 10_000,
      actual: 2_000,
      fields: ["maxOrderNotional"]
    });
    // The refusal is not recorded as a write.
    expect(listAudit(50, userId).filter((event) => event.kind === "mobile_policy_patch")).toHaveLength(0);
  });

  it("refuses without applying ANY field of a multi-field patch", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const userId = await seedUser({
      maxOrderNotional: 10_000,
      maxOrderPctOfNav: undefined,
      maxDailyNotional: 50_000,
      maxDailyPctOfNav: undefined,
      strategyAuthority: "decide"
    });

    const { queueMobileCommand, processPendingMobileCommands } = await import("../src/lib/mobile-api");
    const { command } = queueMobileCommand({
      userId,
      commandType: "policy.patch",
      payload: {
        patch: { maxOrderNotional: 5_000, maxDailyNotional: 20_000, strategyAuthority: "propose" },
        expectedCurrent: { maxOrderNotional: 10_000, maxDailyNotional: 50_000 }
      }
    });
    setPolicy({ ...getPolicy(userId), maxDailyNotional: 10_000 }, userId);
    await processPendingMobileCommands({ limit: 5 });

    const { listMobileCommands } = await import("../src/lib/mobile-api");
    expect(listMobileCommands({ userId }).find((item) => item.id === command.id)?.status).toBe("failed");
    const after = getPolicy(userId);
    // The cap whose precondition still matched is NOT written either — all or nothing.
    expect(after.maxOrderNotional).toBe(10_000);
    expect(after.maxDailyNotional).toBe(10_000);
    expect(after.strategyAuthority).toBe("decide");
  });

  it("guards the authority switch the phone actually sends", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const userId = await seedUser({ strategyAuthority: "decide" });

    const matched = await runPatch(userId, {
      patch: { strategyAuthority: "propose" },
      expectedCurrent: { strategyAuthority: "decide" }
    });
    expect(matched.finished.status).toBe("succeeded");
    expect(getPolicy(userId).strategyAuthority).toBe("propose");

    // Already Ask-First: the same queued tightening arriving late is refused rather than re-run
    // against an authority the owner may have changed for a reason.
    setPolicy({ ...getPolicy(userId), strategyAuthority: "propose" }, userId);
    const stale = await runPatch(userId, {
      patch: { strategyAuthority: "propose" },
      expectedCurrent: { strategyAuthority: "decide" }
    });
    expect(stale.finished.status).toBe("failed");
    expect(stale.finished.error).toContain("strategyAuthority changed since this was sent");
  });

  it("keeps a patch WITHOUT preconditions behaving exactly as before", async () => {
    const { getPolicy, setPolicy, listAudit } = await import("../src/lib/db");
    const userId = await seedUser({ maxOrderNotional: 10_000, maxOrderPctOfNav: undefined });

    const { queueMobileCommand, processPendingMobileCommands, listMobileCommands } = await import(
      "../src/lib/mobile-api"
    );
    const { command } = queueMobileCommand({
      userId,
      commandType: "policy.patch",
      payload: { patch: { maxOrderNotional: 7_500 } }
    });
    // Same mid-flight move as the refusal case above. With no expectation asserted there is
    // nothing to refuse on, and the legacy last-write-wins behaviour must survive verbatim —
    // the web console and every existing caller depend on it.
    setPolicy({ ...getPolicy(userId), maxOrderNotional: 2_000 }, userId);
    await processPendingMobileCommands({ limit: 5 });

    expect(listMobileCommands({ userId }).find((item) => item.id === command.id)?.status).toBe("succeeded");
    expect(getPolicy(userId).maxOrderNotional).toBe(7_500);
    // The stored payload keeps its legacy shape: no empty guard object appears.
    expect(command.payload).toEqual({ patch: { maxOrderNotional: 7_500 } });
    const writes = listAudit(50, userId).filter((event) => event.kind === "mobile_policy_patch");
    expect(writes).toHaveLength(1);
    expect(writes[0].payload).toEqual({ fields: ["maxOrderNotional"] });
  });

  it("treats an empty or null precondition object as no expectation at all", async () => {
    const { getPolicy } = await import("../src/lib/db");
    const emptyUser = await seedUser({ maxOrderNotional: 10_000, maxOrderPctOfNav: undefined });
    const empty = await runPatch(emptyUser, { patch: { maxOrderNotional: 4_000 }, expectedCurrent: {} });
    expect(empty.queued.payload).toEqual({ patch: { maxOrderNotional: 4_000 } });
    expect(empty.finished.status).toBe("succeeded");
    expect(getPolicy(emptyUser).maxOrderNotional).toBe(4_000);

    const nullUser = await seedUser({ maxOrderNotional: 10_000, maxOrderPctOfNav: undefined });
    const nulled = await runPatch(nullUser, { patch: { maxOrderNotional: 4_000 }, expectedCurrent: null });
    expect(nulled.queued.payload).toEqual({ patch: { maxOrderNotional: 4_000 } });
    expect(nulled.finished.status).toBe("succeeded");
  });

  it("checks only the fields it was given, and reads null as 'I believed this was unset'", async () => {
    const { getPolicy } = await import("../src/lib/db");
    const userId = await seedUser({
      maxOrderNotional: 10_000,
      maxOrderPctOfNav: undefined,
      maxDailyNotional: 50_000,
      maxDailyPctOfNav: undefined
    });

    // A partial precondition: two fields patched, one guarded. The unguarded field still applies.
    const partial = await runPatch(userId, {
      patch: { maxOrderNotional: 1_000, maxDailyNotional: 5_000 },
      expectedCurrent: { maxOrderNotional: 10_000 }
    });
    expect(partial.finished.status).toBe("succeeded");
    expect(getPolicy(userId).maxOrderNotional).toBe(1_000);
    expect(getPolicy(userId).maxDailyNotional).toBe(5_000);

    // `null` is a real expectation, not a skip: the hourly cap is genuinely unset here...
    const unsetMatches = await runPatch(userId, {
      patch: { maxOrderNotional: 900 },
      expectedCurrent: { maxOrderNotional: 1_000, maxHourlyNotional: null }
    });
    expect(unsetMatches.finished.status).toBe("succeeded");
    expect(getPolicy(userId).maxOrderNotional).toBe(900);

    // ...and a field that IS set fails a "was unset" expectation.
    const unsetMismatch = await runPatch(userId, {
      patch: { maxOrderNotional: 800 },
      expectedCurrent: { maxDailyNotional: null }
    });
    expect(unsetMismatch.finished.status).toBe("failed");
    expect(unsetMismatch.finished.error).toContain("it is 5000 now, not the not set");
    expect(getPolicy(userId).maxOrderNotional).toBe(900);
  });

  it("refuses a precondition it cannot honestly enforce at the door", async () => {
    const { queueMobileCommand, MobileCommandValidationError } = await import("../src/lib/mobile-api");
    const userId = await seedUser({ maxOrderNotional: 10_000 });

    const rejected: Array<Record<string, unknown>> = [
      // Not a field policy.patch can set — silently ignoring it would leave the caller believing
      // in a guard that does not exist.
      { patch: { maxOrderNotional: 5_000 }, expectedCurrent: { accountNumber: "SPOOFED" } },
      { patch: { maxOrderNotional: 5_000 }, expectedCurrent: { nonsense: 1 } },
      // Collections and nested objects are deliberately not guardable (no exact comparison).
      { patch: { maxOrderNotional: 5_000 }, expectedCurrent: { riskRules: { stopLossPct: 5 } } },
      { patch: { maxOrderNotional: 5_000 }, expectedCurrent: { blocklist: ["AAPL"] } },
      // Type mismatches — an unusable expectation is refused, never coerced.
      { patch: { maxOrderNotional: 5_000 }, expectedCurrent: { maxOrderNotional: "ten thousand" } },
      { patch: { maxOrderNotional: 5_000 }, expectedCurrent: { shortSellingEnabled: "yes" } },
      { patch: { maxOrderNotional: 5_000 }, expectedCurrent: { strategyAuthority: 3 } },
      // Not an object at all: `asRecord` would quietly turn these into an empty guard.
      { patch: { maxOrderNotional: 5_000 }, expectedCurrent: "decide" },
      { patch: { maxOrderNotional: 5_000 }, expectedCurrent: [{ maxOrderNotional: 10_000 }] }
    ];

    for (const payload of rejected) {
      expect(() => queueMobileCommand({ userId, commandType: "policy.patch", payload })).toThrow(
        MobileCommandValidationError
      );
    }

    const { getPolicy } = await import("../src/lib/db");
    expect(getPolicy(userId).maxOrderNotional).toBe(10_000);
  });
});
