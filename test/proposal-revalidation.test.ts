import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { TradeProposal, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-reval-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_URL;
});

const baseProposal: TradeProposal = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 100,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Momentum breakout on volume.",
  tradeThesisTag: "Momentum-Breakout",
  entryMarketRegime: "Neutral"
};

async function seedPending(account: string, id: string, overrides: Partial<TradeProposal> = {}) {
  const { insertProposal } = await import("../src/lib/db");
  insertProposal({
    id,
    runId: "run-1",
    accountNumber: account,
    proposal: { ...baseProposal, ...overrides },
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
}

describe("decideRevalidationActions", () => {
  it("withdraws only on an explicit verdict and defaults everything else to reaffirm", async () => {
    const { decideRevalidationActions } = await import("../src/lib/proposal-revalidation");
    const actions = decideRevalidationActions(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { proposalId: "a", verdict: "withdraw", note: "played out" },
        { proposalId: "b", verdict: "reaffirm", note: "still valid" },
        { proposalId: "zzz", verdict: "withdraw", note: "unknown id is ignored" }
      ]
    );
    expect(actions).toEqual([
      { id: "a", action: "withdraw", note: "played out", confidence: undefined },
      { id: "b", action: "reaffirm", note: "still valid", confidence: undefined },
      { id: "c", action: "reaffirm", note: undefined, confidence: undefined } // missing assessment → kept
    ]);
  });
});

describe("expireStalePendingProposals", () => {
  it("expires proposals older than the TTL and leaves fresh ones pending", async () => {
    const { setPolicy, listPendingProposals, getProposal } = await import("../src/lib/db");
    const { expireStalePendingProposals } = await import("../src/lib/proposal-revalidation");
    const account = "EXPIRE-TTL";
    const policy: TradingPolicy = { ...DEFAULT_POLICY, accountNumber: account, proposalExpiryMinutes: 60 };
    setPolicy(policy);
    await seedPending(account, "exp-old");

    // now far in the future ⇒ the just-inserted proposal reads as > 60 min old.
    const future = Date.now() + 2 * 60 * 60 * 1000;
    const res = await expireStalePendingProposals({ userId: "local", policy, accountNumber: account, now: future });
    expect(res.expired).toBe(1);
    expect(getProposal("exp-old")?.status).toBe("expired");
    expect(listPendingProposals(account).length).toBe(0);

    // A second, freshly-aged check (now ≈ insertion time) leaves a new proposal alone.
    await seedPending(account, "exp-fresh");
    const res2 = await expireStalePendingProposals({ userId: "local", policy, accountNumber: account, now: Date.now() });
    expect(res2.expired).toBe(0);
    expect(getProposal("exp-fresh")?.status).toBe("proposed");
  });

  it("is a no-op when proposalExpiryMinutes is 0/off", async () => {
    const { setPolicy, getProposal } = await import("../src/lib/db");
    const { expireStalePendingProposals } = await import("../src/lib/proposal-revalidation");
    const account = "EXPIRE-OFF";
    const policy: TradingPolicy = { ...DEFAULT_POLICY, accountNumber: account, proposalExpiryMinutes: 0 };
    setPolicy(policy);
    await seedPending(account, "off-1");
    const res = await expireStalePendingProposals({ userId: "local", policy, accountNumber: account, now: Date.now() + 10 * 24 * 60 * 60 * 1000 });
    expect(res.expired).toBe(0);
    expect(getProposal("off-1")?.status).toBe("proposed");
  });

  it("stops before mutating the next stale row when strategy ownership is lost", async () => {
    const { getProposal } = await import("../src/lib/db");
    const { expireStalePendingProposals } = await import("../src/lib/proposal-revalidation");
    const { StrategyLockOwnershipLostError } = await import("../src/lib/strategy-lock-guard");
    const account = `EXPIRE-LEASE-${randomUUID()}`;
    const policy: TradingPolicy = { ...DEFAULT_POLICY, accountNumber: account, proposalExpiryMinutes: 1 };
    await seedPending(account, `${account}-first`);
    await seedPending(account, `${account}-second`);

    let ownershipChecks = 0;
    const assertOwned = () => {
      ownershipChecks++;
      // first row: before mutation + after notification; fail before row two mutates.
      if (ownershipChecks >= 3) throw new StrategyLockOwnershipLostError();
    };

    await expect(expireStalePendingProposals({
      userId: "local",
      policy,
      accountNumber: account,
      now: Date.now() + 60 * 60 * 1000,
      assertOwned
    })).rejects.toBeInstanceOf(StrategyLockOwnershipLostError);

    expect([
      getProposal(`${account}-first`)?.status,
      getProposal(`${account}-second`)?.status
    ].sort()).toEqual(["expired", "proposed"]);
  });
});

describe("revalidatePendingProposals", () => {
  it("withdraws proposals the LLM no longer advises and stamps the survivors", async () => {
    const { setPolicy, listPendingProposals, getProposal } = await import("../src/lib/db");
    const { revalidatePendingProposals } = await import("../src/lib/proposal-revalidation");
    const account = "REVAL-LLM";
    process.env.OPENROUTER_API_KEY = "test-key";
    const policy: TradingPolicy = { ...DEFAULT_POLICY, accountNumber: account, proposalRevalidateCadenceHours: 0 };
    setPolicy(policy);
    await seedPending(account, "keep-1", { symbol: "MSFT" });
    await seedPending(account, "drop-1", { symbol: "TSLA" });

    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            assessments: [
              { proposalId: "keep-1", verdict: "reaffirm", confidence: 72, note: "Thesis intact." },
              { proposalId: "drop-1", verdict: "withdraw", confidence: 81, note: "Already ran; entry gone." }
            ]
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const future = Date.now() + 3 * 60 * 60 * 1000;
    const res = await revalidatePendingProposals({ userId: "local", policy, accountNumber: account, now: future, marketOpen: true });
    expect(res).toMatchObject({ checked: 2, reaffirmed: 1, withdrawn: 1, skipped: false });

    expect(getProposal("drop-1")?.status).toBe("withdrawn");
    expect(getProposal("keep-1")?.status).toBe("proposed");

    const pending = listPendingProposals(account);
    expect(pending.map((p) => p.id)).toEqual(["keep-1"]);
    expect(pending[0].lastRevalidatedAt).toBeTruthy();
    expect(pending[0].revalidationNote).toBe("Thesis intact.");
  });

  it("skips the LLM pass (and changes nothing) when OpenAI is not configured", async () => {
    const { setPolicy, getProposal } = await import("../src/lib/db");
    const { revalidatePendingProposals } = await import("../src/lib/proposal-revalidation");
    const account = "REVAL-NOKEY";
    delete process.env.OPENROUTER_API_KEY;
    const policy: TradingPolicy = { ...DEFAULT_POLICY, accountNumber: account, proposalRevalidateCadenceHours: 0 };
    setPolicy(policy);
    await seedPending(account, "nokey-1");

    const res = await revalidatePendingProposals({ userId: "local", policy, accountNumber: account, now: Date.now() + 3 * 60 * 60 * 1000, marketOpen: true });
    expect(res.skipped).toBe(true);
    expect(res.withdrawn).toBe(0);
    expect(getProposal("nokey-1")?.status).toBe("proposed");
  });

  it("does not touch proposals younger than the re-check cadence", async () => {
    const { setPolicy, getProposal } = await import("../src/lib/db");
    const { revalidatePendingProposals } = await import("../src/lib/proposal-revalidation");
    const account = "REVAL-YOUNG";
    process.env.OPENROUTER_API_KEY = "test-key";
    const policy: TradingPolicy = { ...DEFAULT_POLICY, accountNumber: account, proposalRevalidateCadenceHours: 24 };
    setPolicy(policy);
    await seedPending(account, "young-1");

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // Just inserted ⇒ ~0 min old, well under the once-per-day cadence ⇒ not due for a re-check.
    const res = await revalidatePendingProposals({ userId: "local", policy, accountNumber: account, now: Date.now(), marketOpen: true });
    expect(res).toMatchObject({ checked: 0, withdrawn: 0, reaffirmed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getProposal("young-1")?.status).toBe("proposed");
  });

  it("skips overnight — no re-check when the market is closed", async () => {
    const { setPolicy, getProposal } = await import("../src/lib/db");
    const { revalidatePendingProposals } = await import("../src/lib/proposal-revalidation");
    const account = "REVAL-CLOSED";
    process.env.OPENROUTER_API_KEY = "test-key";
    const policy: TradingPolicy = { ...DEFAULT_POLICY, accountNumber: account, proposalRevalidateCadenceHours: 0 };
    setPolicy(policy);
    await seedPending(account, "closed-1");

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // Old enough to be due, but the market is closed ⇒ the LLM pass is skipped entirely.
    const res = await revalidatePendingProposals({ userId: "local", policy, accountNumber: account, now: Date.now() + 3 * 60 * 60 * 1000, marketOpen: false });
    expect(res.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getProposal("closed-1")?.status).toBe("proposed");
  });

  it("does not swallow ownership loss after the LLM returns or mutate the pending row", async () => {
    const { getProposal } = await import("../src/lib/db");
    const { revalidatePendingProposals } = await import("../src/lib/proposal-revalidation");
    const { StrategyLockOwnershipLostError } = await import("../src/lib/strategy-lock-guard");
    const account = `REVAL-LEASE-${randomUUID()}`;
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";
    const policy: TradingPolicy = { ...DEFAULT_POLICY, accountNumber: account, proposalRevalidateCadenceHours: 0 };
    const proposalId = `${account}-pending`;
    await seedPending(account, proposalId);

    let ownershipLost = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      ownershipLost = true;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            assessments: [{ proposalId, verdict: "withdraw", confidence: 99, note: "stale" }]
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const assertOwned = () => {
      if (ownershipLost) throw new StrategyLockOwnershipLostError();
    };
    await expect(revalidatePendingProposals({
      userId: "local",
      policy,
      accountNumber: account,
      now: Date.now() + 60 * 60 * 1000,
      marketOpen: true,
      assertOwned
    })).rejects.toBeInstanceOf(StrategyLockOwnershipLostError);

    expect(getProposal(proposalId)?.status).toBe("proposed");
  });
});
