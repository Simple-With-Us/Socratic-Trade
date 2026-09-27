/**
 * Controlled-experiment pin on model rotation (review "rank 6", 2026-09-25).
 *
 * The review compared per-model realized performance and found the comparison NOT clean: rotation
 * changed fixed -> round-robin (Jul 8) -> weighted-random (Aug 6), so every model's history is
 * tied to a calendar period; sixteen models were compared at once; and a fifth of the lots carried
 * no model stamp (that half is already fixed and merged — ops-performance now reports an explicit
 * `unattributed` bucket, untouched here).  The review's ask: "Run a controlled model test: fix the
 * rotation weights for a set period, or split models by account.  A reversible down-weight of
 * gpt-5.5 and gpt-5.4-nano is cheap now, but not proven."  And: "Answers whether gpt-5.5 and
 * gpt-5.4-nano are worse, or just unlucky in their calendar period."
 *
 * This file is the pin's contract.  Each test names the failure it exists to prevent:
 *   - a SILENT pin would distort every performance report without anyone knowing (so pinning is
 *     loud: a `model_rotation_pin` audit, a `pinned` flag on the pick audit, a returned report);
 *   - a pin that is not REVERSIBLE-obviously would permanently damage the learned weights (so
 *     removing it restores the learned behavior byte-for-byte, and pinned picks never enter the
 *     representation ledger);
 *   - a TRUSTED pin could starve the model pool (so an unknown model id, an out-of-range weight, a
 *     malformed pin, or an all-zero weight set is ignored WITH A RECEIPT and rotation continues);
 *   - a GLOBAL pin would destroy the per-(user, account, seat) scoping the review's own
 *     "split models by account" alternative depends on.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetDbForTesting } from "../src/lib/db";

beforeAll(() => {
  resetDbForTesting();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-model-rotation-pin-${randomUUID()}.db`)}`;
});

afterEach(() => {
  resetDbForTesting();
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const LLM_ENV = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY"
];

function noEnvKeys() {
  vi.stubEnv("LLM_OPERATOR_FALLBACK", "off");
  for (const k of LLM_ENV) vi.stubEnv(k, "");
}

/** Small deterministic PRNG (mulberry32) so sampling tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Audit payloads of one kind for one user, newest last (direct SQL — no listAuditByKind shape to keep in sync). */
async function auditsOfKind(userId: string, kind: string): Promise<Array<Record<string, unknown>>> {
  const { getDb } = await import("../src/lib/db");
  const rows = getDb()
    .prepare("SELECT payload FROM audit_events WHERE kind = ? AND user_id = ? ORDER BY created_at ASC")
    .all(kind, userId) as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

describe("weightOverrides on weightedRotationPick (the down-weight lever)", () => {
  const pool = ["gpt-5.5", "gpt-5.4-nano", "gpt-6-astra"];

  it("samples a zero-weighted model NEVER, and leaves the other models' relative weights intact", async () => {
    const { weightedRotationPick } = await import("../src/lib/model-rotation");
    const random = mulberry32(0x5eed);
    // Without the pin the down-weighted model is picked on a healthy share of draws — so a
    // "never picked" assertion below is evidence of the pin, not of an unlucky seed.
    const unpinned = new Set<string>();
    for (let i = 0; i < 600; i++) {
      unpinned.add(weightedRotationPick({ pool, counts: new Map(), random })!.model);
    }
    expect(unpinned.has("gpt-5.5")).toBe(true);

    const downweighted = new Set<string>();
    for (let i = 0; i < 600; i++) {
      const pick = weightedRotationPick({
        pool,
        counts: new Map(),
        random,
        weightOverrides: new Map([["gpt-5.5", 0]])
      })!;
      // A zero weight is an EXCLUSION for the experiment window, and the pick receipt says so.
      expect(pick.model).not.toBe("gpt-5.5");
      if (pick.model === "gpt-5.4-nano") expect(pick.weight).toBe(2);
      downweighted.add(pick.model);
    }
    expect([...downweighted].sort()).toEqual(["gpt-5.4-nano", "gpt-6-astra"]);
  });

  it("honors a non-zero override above the learned weight and never serves a zero-weighted LAST member", async () => {
    const { weightedRotationPick } = await import("../src/lib/model-rotation");
    // Learned: m0 is overrepresented (weight 1), the rest weight 2.  The pin boosts m0 to 5 so
    // r = 0 lands in m0's slice — a pin the operator can rely on to bias, not just to exclude.
    const counts = new Map([["m0", 9]]);
    const boosted = weightedRotationPick({ pool: ["m0", "m1"], counts, random: () => 0, weightOverrides: new Map([["m0", 5]]) })!;
    expect(boosted.model).toBe("m0");
    expect(boosted.weight).toBe(5);
    // The floating-point floor at r ~ 1 must not resurrect a zero-weighted tail member.
    for (const r of [0.999999999, 1 - Number.EPSILON, 1]) {
      const pick = weightedRotationPick({
        pool: ["m0", "m1"],
        counts,
        random: () => r,
        weightOverrides: new Map([["m1", 0]])
      })!;
      expect(pick.model).toBe("m0");
    }
  });
});

describe("resolveRotationSeatPin (validation — never trusted, never starves)", () => {
  const pool = ["gpt-6-astra", "gpt-5.5", "gpt-5.4-nano"];
  const known = pool;

  it("forces the pinned seat's model only when it is actually eligible for that seat", async () => {
    const { resolveRotationSeatPin } = await import("../src/lib/model-rotation-pin");
    const applied = resolveRotationSeatPin({
      pin: { green: "gpt-5.4-nano", label: "gpt-5.5-vs-nano" },
      seat: "green",
      pool,
      knownModels: known
    });
    expect(applied.forcedModel).toBe("gpt-5.4-nano");
    expect(applied.ignored).toBeUndefined();
    expect(applied.rejected).toEqual([]);
    expect(applied.label).toBe("gpt-5.5-vs-nano");

    // A pin for the OTHER seat never leaks across: it is not this seat's force, but its weight
    // overrides are seat-agnostic by design (the pool is the same curated catalog).
    const otherSeat = resolveRotationSeatPin({
      pin: { green: "gpt-5.4-nano" },
      seat: "red",
      pool,
      knownModels: known
    });
    expect(otherSeat.forcedModel).toBeUndefined();

    // Ineligible (no credential for that model in this seat's pool) -> ignored with a receipt,
    // NOT served: rotation must never inject a guaranteed-failure run.
    const ineligible = resolveRotationSeatPin({
      pin: { green: "gpt-5.5" },
      seat: "green",
      pool: ["gpt-6-astra"],
      knownModels: known
    });
    expect(ineligible.forcedModel).toBeUndefined();
    expect(ineligible.ignored).toBe("model_not_eligible");
    expect(ineligible.rejected.join(" ")).toContain("gpt-5.5");
  });

  it("rejects an unknown model id and an out-of-range weight with receipts instead of throwing", async () => {
    const { resolveRotationSeatPin, ROTATION_PIN_MAX_WEIGHT } = await import("../src/lib/model-rotation-pin");
    const pool = ["gpt-6-astra", "gpt-5.5", "gpt-5.4-nano", "gemini-flash-latest"];
    // claude-opus-4.6 is in the CATALOG but not in this seat's POOL (no credential here): a
    // different failure from a typo'd id, and both must be receipts rather than silent no-ops.
    const known = [...pool, "claude-opus-4.6"];
    const res = resolveRotationSeatPin({
      pin: {
        green: "gpt-9-imaginary",
        weights: {
          "gpt-9-imaginary": 3,
          "gpt-5.5": -1,
          "gpt-5.4-nano": ROTATION_PIN_MAX_WEIGHT + 1,
          "gpt-6-astra": "2" as unknown as number,
          "claude-opus-4.6": 4,
          "gemini-flash-latest": 3
        }
      },
      seat: "green",
      pool,
      knownModels: known
    });
    expect(res.ignored).toBe("malformed_pin");
    const receipts = res.rejected.join(" | ");
    expect(receipts).toContain("gpt-9-imaginary"); // forced id unknown to the catalog
    expect(receipts).toContain("weights[\"gpt-9-imaginary\"]"); // …and as a weight key
    expect(receipts).toContain("weights[\"gpt-5.5\"]"); // negative weight
    expect(receipts).toContain("weights[\"gpt-5.4-nano\"]"); // above the sane ceiling
    expect(receipts).toContain("weights[\"gpt-6-astra\"]"); // non-numeric weight
    expect(receipts).toContain("claude-opus-4.6"); // known catalog model, not in THIS seat's pool
    // The one valid entry survives the garbage around it, and nothing else did.
    expect([...res.weightOverrides!]).toEqual([["gemini-flash-latest", 3]]);
  });

  it("drops a weight set that would starve the pool, and a malformed or expired pin, with a reason", async () => {
    const { resolveRotationSeatPin } = await import("../src/lib/model-rotation-pin");
    const starved = resolveRotationSeatPin({
      pin: { weights: { "gpt-5.5": 0, "gpt-5.4-nano": 0, "gpt-6-astra": 0 } },
      seat: "green",
      pool,
      knownModels: known
    });
    expect(starved.weightOverrides).toBeUndefined();
    expect(starved.ignored).toBe("would_starve_pool");

    for (const malformed of ["gpt-5.5", 42, [1, 2], { weights: "nope" }, { green: { model: "gpt-5.5" } }] as unknown[]) {
      const res = resolveRotationSeatPin({
        pin: malformed as never,
        seat: "green",
        pool,
        knownModels: known
      });
      expect(res.ignored).toBe("malformed_pin");
      expect(res.weightOverrides).toBeUndefined();
      expect(res.forcedModel).toBeUndefined();
    }

    // The sentinel is not a pinnable model — pinning "__rotate__" would be a self-referential loop.
    const sentinel = resolveRotationSeatPin({
      pin: { green: "__rotate__" },
      seat: "green",
      pool,
      knownModels: known
    });
    expect(sentinel.forcedModel).toBeUndefined();
    expect(sentinel.ignored).toBe("sentinel_not_pinnable");

    // A forgotten experiment must not distort performance reports forever: an elapsed expiry is
    // ignored with a reason, so the learned weights resume on their own.
    const expired = resolveRotationSeatPin({
      pin: { green: "gpt-5.4-nano", expiresAt: "2020-01-01T00:00:00.000Z" },
      seat: "green",
      pool,
      knownModels: known,
      now: Date.parse("2026-09-27T12:00:00.000Z")
    });
    expect(expired.ignored).toBe("expired");
    expect(expired.forcedModel).toBeUndefined();
    // ...and an expiry still in the future is honored.
    const live = resolveRotationSeatPin({
      pin: { green: "gpt-5.4-nano", expiresAt: "2026-10-27T00:00:00.000Z" },
      seat: "green",
      pool,
      knownModels: known,
      now: Date.parse("2026-09-27T12:00:00.000Z")
    });
    expect(live.forcedModel).toBe("gpt-5.4-nano");
  });

  it("keeps the same-model guarantee: a RED pin equal to GREEN's served model is dropped, weights survive", async () => {
    const { resolveRotationSeatPin } = await import("../src/lib/model-rotation-pin");
    const res = resolveRotationSeatPin({
      pin: { red: "gpt-6-astra", weights: { "gpt-5.5": 0 } },
      seat: "red",
      pool: ["gpt-6-astra", "gpt-5.5"],
      knownModels: known,
      excludeModel: "gpt-6-astra" // green is serving this model this run
    });
    expect(res.forcedModel).toBeUndefined();
    expect(res.rejected.join(" ")).toContain("collides_with_other_seat");
    // The down-weight half of the pin is independent of the force half and still applies.
    expect(res.weightOverrides?.get("gpt-5.5")).toBe(0);
  });
});

describe("resolveModelRotationForRun with a pin (loud, scoped, reversible)", () => {
  it("serves the pinned model every run and stamps the pin on the pick audit + a pin audit", async () => {
    noEnvKeys();
    const userId = `pin-forced-${randomUUID()}`;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { resolveModelRotationForRun, eligibleRotationPool, LLM_MODEL_ROTATION_SENTINEL } = await import(
      "../src/lib/model-rotation"
    );
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const { pool } = await eligibleRotationPool(userId);
    const target = pool.includes("gpt-5.4-nano") ? "gpt-5.4-nano" : pool[0]!;
    const random = mulberry32(7);
    for (let i = 0; i < 8; i++) {
      const out = await resolveModelRotationForRun({
        userId,
        accountId: "acct-pin",
        runId: randomUUID(),
        policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL, rotationPin: { green: target, label: "rank6-controlled" } },
        random
      });
      expect(out.llmModel).toBe(target);
      // Loud: the caller can see the pin in the resolve result without reading the audit table.
      expect(out.rotationPin).toMatchObject({ applied: true, label: "rank6-controlled", green: target });
      out.commit();
    }
    const picks = await auditsOfKind(userId, "model_rotation_pick");
    expect(picks.length).toBe(8);
    for (const pick of picks) {
      expect(pick.pinned).toBe(true);
      expect(pick.pinLabel).toBe("rank6-controlled");
      expect(pick.forced).toBe(true);
      expect(pick.model).toBe(target);
    }
    // ...and a dedicated pin audit so an operator can list every run an experiment touched.
    const pinAudits = await auditsOfKind(userId, "model_rotation_pin");
    expect(pinAudits.length).toBe(8);
    expect(pinAudits[0]).toMatchObject({ applied: true, label: "rank6-controlled", green: target });
    expect(pinAudits[0]?.ignored).toBeUndefined(); // nothing was refused
    // Loud in the log surface too, not only in the audit table.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await resolveModelRotationForRun({
      userId,
      accountId: "acct-pin",
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL, rotationPin: { green: target, label: "logged" } },
      random: () => 0
    });
    expect(warn.mock.calls.some((call) => String(call[0]).includes("rank6") || String(call[0]).includes("logged"))).toBe(
      true
    );
    warn.mockRestore();
  });

  it("is reversible-obviously: removing the pin restores the learned pick EXACTLY and never skews the ledger", async () => {
    noEnvKeys();
    const userId = `pin-reversible-${randomUUID()}`;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { resolveModelRotationForRun, eligibleRotationPool, LLM_MODEL_ROTATION_SENTINEL } = await import(
      "../src/lib/model-rotation"
    );
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const { pool } = await eligibleRotationPool(userId);
    const target = pool[0]!;
    // Baseline: the very first pick on an empty ledger, no pin anywhere in the policy.
    const baseline = await resolveModelRotationForRun({
      userId,
      accountId: "acct-rev",
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL },
      random: () => 0
    });
    expect(baseline.rotationPin).toBeUndefined();

    // A whole pinned experiment window on a DIFFERENT account of the same user, so the clean
    // account's ledger stays empty and the post-experiment comparison is like-for-like.
    for (let i = 0; i < 5; i++) {
      const out = await resolveModelRotationForRun({
        userId,
        accountId: "acct-experiment",
        runId: randomUUID(),
        policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL, rotationPin: { green: target, label: "window" } },
        random: () => 0
      });
      expect(out.llmModel).toBe(target);
      out.commit();
    }
    // The window really happened and really was marked as pinned — otherwise "the ledger is
    // unchanged" below would be vacuous.
    const windowPicks = (await auditsOfKind(userId, "model_rotation_pick")).filter(
      (pick) => pick.model === target
    );
    expect(windowPicks.length).toBe(5);
    expect(windowPicks.every((pick) => pick.pinned === true)).toBe(true);
    // The pin is gone; the learned weights must be exactly what they were before the experiment.
    // A pinned pick entering the representation ledger would show up here as a shifted pick.
    const afterPin = await resolveModelRotationForRun({
      userId,
      accountId: "acct-experiment",
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL },
      random: () => 0
    });
    expect(afterPin.llmModel).toBe(baseline.llmModel);
    expect(afterPin.rotationPin).toBeUndefined();
    // Same for the never-pinned account: the other account's experiment leaked nothing.
    const clean = await resolveModelRotationForRun({
      userId,
      accountId: "acct-rev",
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL },
      random: () => 0
    });
    expect(clean.llmModel).toBe(baseline.llmModel);
  });

  it("down-weights a model to zero for the window and serves it again the moment the pin is removed", async () => {
    noEnvKeys();
    const userId = `pin-downweight-${randomUUID()}`;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { resolveModelRotationForRun, eligibleRotationPool, LLM_MODEL_ROTATION_SENTINEL } = await import(
      "../src/lib/model-rotation"
    );
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const { pool } = await eligibleRotationPool(userId);
    const target = pool[pool.length - 1]!;
    const pin = { weights: { [target]: 0 }, label: "gpt-downweight" };
    const during = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const out = await resolveModelRotationForRun({
        userId,
        accountId: "acct-dw",
        runId: randomUUID(),
        policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL, rotationPin: pin },
        random: mulberry32(1000 + i)
      });
      expect(out.llmModel).toBeTruthy();
      expect(out.llmModel).not.toBe(target);
      // Weight 0 means "this model does not serve this seat", which includes the implicit failover
      // chain built from the returned pool — not merely "not first".
      expect(out.greenRotationPool).not.toContain(target);
      during.add(out.llmModel!);
      out.commit();
    }
    expect(during.size).toBeGreaterThan(1); // the rest of the pool kept rotating
    // Pin removed: the model is back in the pool and served again on its own turn.  This is the
    // review's "reversible down-weight … cheap now, but not proven" — the un-proving must be cheap.
    const after = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const out = await resolveModelRotationForRun({
        userId,
        accountId: "acct-dw",
        runId: randomUUID(),
        policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL },
        random: mulberry32(1000 + i)
      });
      expect(out.greenRotationPool).toContain(target);
      after.add(out.llmModel!);
    }
    expect(after.has(target)).toBe(true);
  });

  it("keeps the pin per (user, account, seat): acct-A's pin never reaches acct-B's run or ledger", async () => {
    noEnvKeys();
    const userId = `pin-scoped-${randomUUID()}`;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { resolveModelRotationForRun, eligibleRotationPool, LLM_MODEL_ROTATION_SENTINEL } = await import(
      "../src/lib/model-rotation"
    );
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const { pool } = await eligibleRotationPool(userId);
    expect(pool.length).toBeGreaterThan(1);
    const first = pool[0]!;
    // The rng is pinned to the LAST slice on BOTH accounts, so the only thing that can move acct-A
    // off the last model is the pin — and the only reason acct-B moves there is its own ledger.
    const r = 0.999999;
    const pinned = await resolveModelRotationForRun({
      userId,
      accountId: "acct-A",
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL, rotationPin: { green: first, label: "acct-A-only" } },
      random: () => r
    });
    expect(pinned.llmModel).toBe(first);
    pinned.commit();
    const unpinned = await resolveModelRotationForRun({
      userId,
      accountId: "acct-B",
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL },
      random: () => r
    });
    expect(unpinned.llmModel).toBe(pool[pool.length - 1]);
    expect(unpinned.llmModel).not.toBe(first);
    expect(unpinned.rotationPin).toBeUndefined();
    // acct-B has no pin audit at all — the pin is per-policy, never process-global.
    expect(await auditsOfKind(userId, "model_rotation_pin")).toHaveLength(1);
    // The pin audit carries the account it was applied to, so a scoped experiment is separable
    // in any later per-model report.
    const pinAudits = await auditsOfKind(userId, "model_rotation_pin");
    expect(pinAudits[0]?.connectedAccountId).toBe("acct-A");
  });

  it("never lets a bad pin starve or fail a run: garbage in, a real concrete model out, with a receipt", async () => {
    noEnvKeys();
    const userId = `pin-garbage-${randomUUID()}`;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { resolveModelRotationForRun, eligibleRotationPool, LLM_MODEL_ROTATION_SENTINEL } = await import(
      "../src/lib/model-rotation"
    );
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const { pool } = await eligibleRotationPool(userId);
    const out = await resolveModelRotationForRun({
      userId,
      accountId: "acct-garbage",
      runId: randomUUID(),
      policy: {
        llmModel: LLM_MODEL_ROTATION_SENTINEL,
        rotationPin: { green: "not-a-model", weights: { "not-a-model": 0 } } as never
      },
      random: () => 0
    });
    expect(out.llmModel).toBeTruthy();
    expect(out.llmModel).not.toBe(LLM_MODEL_ROTATION_SENTINEL);
    expect(pool).toContain(out.llmModel!);
    expect(out.emptyReason).toBeUndefined();
    // Ignored WITH a receipt, not trusted and not fatal: the run still rotates on learned weights.
    expect(out.rotationPin).toMatchObject({ applied: false, ignored: "malformed_pin" });
    expect(out.rotationPin?.rejected.length).toBeGreaterThan(0);
    out.commit();
    const pinAudits = await auditsOfKind(userId, "model_rotation_pin");
    expect(pinAudits[0]?.rejected).toBeTruthy();
  });

  it("drops a RED force that equals GREEN's served model but keeps RED rotating (same-model guarantee)", async () => {
    noEnvKeys();
    const userId = `pin-same-${randomUUID()}`;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { resolveModelRotationForRun, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const { pool } = await (await import("../src/lib/model-rotation")).eligibleRotationPool(userId);
    const target = pool[0]!;
    const out = await resolveModelRotationForRun({
      userId,
      accountId: "acct-same",
      runId: randomUUID(),
      policy: {
        llmModel: LLM_MODEL_ROTATION_SENTINEL,
        redTeamLlmModel: LLM_MODEL_ROTATION_SENTINEL,
        rotationPin: { green: target, red: target, label: "both" }
      },
      random: () => 0
    });
    expect(out.llmModel).toBe(target);
    expect(out.redTeamLlmModel).toBeTruthy();
    expect(out.redTeamLlmModel).not.toBe(target);
    // Red's candidate pool is built WITHOUT green's model, so the colliding force is refused at
    // the pool gate before it can serve (the pure resolver's own `collides_with_other_seat`
    // branch is covered in the resolveRotationSeatPin suite above).
    expect(out.rotationPin?.ignored).toBe("model_not_eligible");
    expect(out.rotationPin?.rejected.join(" ")).toContain("not in this seat's eligible pool");
  });
});
