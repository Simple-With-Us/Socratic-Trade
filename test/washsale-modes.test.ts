/**
 * Wash-sale handling modes (taxSettings.washSaleHandling: block | ask | auto) + the Decide-mode
 * escalation framework — gate-level, end-to-end through evaluateTradeProposal, plus the strategy
 * helpers that route escalations (shouldEscalateDecision / approvedEscalationsFromDecision).
 *
 * Safety contract under test (owner-locked spec, updated 2026-07-03 — defaults now non-blocking):
 *   - DEFAULT is "auto" (taxable) + "disregard" (IRA) — the gate is advisory, not a hard block,
 *     unless an operator explicitly opts into "block" or "ask";
 *   - "block" (explicit opt-in) refuses the buy outright — the original hard-stop behavior;
 *   - "ask" refuses at the gate but marks the failure escalatable with the PRICED tax cost
 *     (disallowed loss × shortTermRatePct) — approvable later only via a server-stored token;
 *   - "auto" ALWAYS proceeds — the priced tax cost/expected-edge math rides decision.washSale as
 *     receipt telemetry (never silent) instead of gating; the old edge-vs-cost veto was removed
 *     because it re-arithmetized the LLM's own outputs rather than adding independent judgment;
 *   - IRA replacement purchases are hard-blocked ONLY when iraWashSaleHandling is explicitly
 *     "block". Optional washSaleMinLossUsd (blank = every loss) can exempt smaller losses.
 *     "auto" proceeds with receipt telemetry. The default ("disregard" / Ignore) proceeds
 *     annotated + audited and does not steer Green;
 *   - the override token never weakens an explicit "block" (ignored when handling is "block")
 *     and never bypasses OTHER gates at approval time;
 *   - only the closed escalation allowlist (ask-mode wash sale + time-context gates) can ever
 *     escalate; per-order caps / blocklist / shorting-disabled failures never do.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  evaluateTradeProposal,
  iraWashSaleMinLossUsd,
  washSaleExpectedEdgeUsd,
  washSaleOverrideCostTolerance,
  IRA_WASH_SALE_DISREGARD_NOTE,
  WASH_SALE_AUTO_EDGE_MULTIPLE
} from "../src/lib/policy";
import type { WashSaleLockMap } from "../src/lib/tax";
import type {
  AccountCapabilities,
  EquityPosition,
  PolicyDecision,
  Portfolio,
  TaxSettings,
  TradeProposal,
  TradingPolicy
} from "../src/lib/types";
import { approvedEscalationsFromDecision, shouldEscalateDecision } from "../src/lib/strategy-risk";

// Mock the tax module so the gate tests don't need a DB (the gate's fallback resolver is
// exercised by policy.test.ts; here every test passes washSaleLocks/washSaleLockedSymbols).
vi.mock("../src/lib/tax", () => ({
  getUserWashSaleLockedSymbols: vi.fn(() => new Set<string>()),
  getUserWashSaleLockProvenance: vi.fn(() => new Map())
}));

const portfolio: Portfolio = {
  accountNumber: "A1",
  totalMarketValue: 100_000,
  buyingPower: 50_000,
  equityMarketValue: 50_000,
  optionMarketValue: 0,
  cash: 50_000
};

const positions: EquityPosition[] = [];

const CLEAR_DATE = new Date("2026-07-20T00:00:00.000Z");

/** TSLA locked by a $500 loss in taxable account ACC1 → at 24% short-term rate the priced
 *  forfeited deduction is $120; the 3× auto guard therefore requires $360 of expected edge. */
function locks(lossUsd = 500): WashSaleLockMap {
  return new Map([["TSLA", { account: "ACC1", clearDate: CLEAR_DATE, lossUsd }]]);
}

function taxSettings(overrides: Partial<TaxSettings> = {}): TaxSettings {
  return { washSaleGuard: true, shortTermRatePct: 24, longTermRatePct: 15, ...overrides };
}

function policyWith(overrides: Partial<TradingPolicy> = {}): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    systemState: "active",
    strategyAuthority: "decide",
    accountNumber: "A1",
    includedIndices: [],
    additionalSymbols: ["TSLA", "AAPL"],
    maxOrderNotional: 50_000,
    maxOrderPctOfNav: undefined,
    maxDailyNotional: 50_000,
    maxDailyPctOfNav: undefined,
    taxSettings: taxSettings(),
    // Staleness gate pinned off (defaults to 120s since 2026-07-28): these wash-sale tests exercise
    // the tax gates without fresh quote timestamps; tests about the gate itself override below.
    maxQuoteAgeSec: 0,
    ...overrides
  };
}

const buy: TradeProposal = {
  symbol: "TSLA",
  side: "buy",
  type: "market",
  dollarAmount: 3000,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "test",
  tradeThesisTag: "Momentum-Breakout",
  entryMarketRegime: "Neutral",
  confidenceScore: 80
};

function ctx(policy: TradingPolicy, extra: Record<string, unknown> = {}) {
  return {
    policy,
    portfolio,
    positions,
    dailyNotionalUsed: 0,
    dailyOrderCount: 0,
    estimatedNotional: 3000,
    washSaleLocks: locks(),
    ...extra
  };
}

const iraCapable: AccountCapabilities = {
  equityTrading: true,
  shortSelling: false,
  optionsTrading: false,
  futuresTrading: false,
  cryptoTrading: false,
  marginEnabled: false,
  accountType: "roth_ira"
};

describe("wash-sale handling — default (unset taxSettings.washSaleHandling)", () => {
  it("owner decision 2026-07-03: an unset washSaleHandling now defaults to 'auto', not 'block'", () => {
    // "auto" always proceeds; the priced tax cost still rides the receipt (never silent).
    const decision = evaluateTradeProposal(buy, ctx(policyWith()));
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("auto_proceeded");
    expect(decision.washSale?.handling).toBe("auto");
  });

  it("a policy with NO taxSettings at all still gets auto + disregard defaults (DEFAULT_TAX_SETTINGS)", () => {
    const bare = policyWith({ taxSettings: undefined });
    const decision = evaluateTradeProposal(buy, ctx(bare));
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("auto_proceeded");
    expect(decision.washSale?.handling).toBe("auto");
  });
});

describe("wash-sale handling — mode 'block' (explicit, stricter opt-in)", () => {
  it("blocks a locked rebuy when washSaleHandling is explicitly 'block'", () => {
    const decision = evaluateTradeProposal(buy, ctx(policyWith({ taxSettings: taxSettings({ washSaleHandling: "block" }) })));
    expect(decision.approved).toBe(false);
    expect(decision.reasons.some((r) => r.includes("wash-sale lockout"))).toBe(true);
    // Not escalatable: block mode produces no escalation entry.
    expect(decision.escalations ?? []).toHaveLength(0);
    expect(decision.washSale?.outcome).toBe("blocked");
    expect(decision.washSale?.handling).toBe("block");
  });

  it("prices the forfeited deduction and names the provenance in the block reason", () => {
    const decision = evaluateTradeProposal(buy, ctx(policyWith({ taxSettings: taxSettings({ washSaleHandling: "block" }) })));
    const reason = decision.reasons.join(" ");
    expect(reason).toContain("loss in ACC1");
    expect(reason).toContain("$120.00"); // 500 × 24%
    expect(decision.washSale?.disallowedLossUsd).toBe(500);
    expect(decision.washSale?.estimatedTaxCostUsd).toBe(120);
  });

  it("an override token can NEVER weaken the default block", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ taxSettings: taxSettings({ washSaleHandling: "block" }) }), {
        approvedEscalations: [{ kind: "wash_sale_ask", symbol: "TSLA", token: "tok-1" }]
      })
    );
    expect(decision.approved).toBe(false);
    expect(decision.washSale?.outcome).toBe("blocked");
  });
});

describe("wash-sale handling — mode 'ask'", () => {
  const askPolicy = policyWith({ taxSettings: taxSettings({ washSaleHandling: "ask" }) });

  it("refuses the buy but marks it escalatable with the priced cost and 'Your call.' copy", () => {
    const decision = evaluateTradeProposal(buy, ctx(askPolicy));
    expect(decision.approved).toBe(false);
    const reason = decision.reasons.find((r) => r.includes("Your call."));
    expect(reason).toBeDefined();
    expect(reason).toContain("Rebuying TSLA now forfeits ~$120.00 of tax deduction");
    expect(reason).toContain("loss in ACC1");
    expect(reason).toContain("clears 2026-07-20");
    const escalation = (decision.escalations ?? []).find((e) => e.kind === "wash_sale_ask");
    expect(escalation).toBeDefined();
    expect(escalation?.symbol).toBe("TSLA");
    expect(escalation?.reason).toBe(reason);
    expect(escalation?.washSale?.disallowedLossUsd).toBe(500);
    expect(escalation?.washSale?.estimatedTaxCostUsd).toBe(120);
    // Tokens are minted by the strategy loop at persist time, never by the pure gate.
    expect(escalation?.token).toBeUndefined();
    expect(decision.washSale?.outcome).toBe("ask_escalated");
  });

  it("still escalates (cost unpriced) when only the legacy Set is available", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(askPolicy, { washSaleLocks: undefined, washSaleLockedSymbols: new Set(["TSLA"]) })
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("an unpriced amount");
    expect((decision.escalations ?? []).some((e) => e.kind === "wash_sale_ask")).toBe(true);
  });

  it("honors a matching server-stored override token (approved, audited) — the ask/auto approval path", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(askPolicy, { approvedEscalations: [{ kind: "wash_sale_ask", symbol: "TSLA", token: "tok-abc", approvedCostUsd: 120 }] })
    );
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("approved_via_override");
    expect(decision.washSale?.overrideToken).toBe("tok-abc");
    expect(decision.washSale?.estimatedTaxCostUsd).toBe(120);
  });

  // Codex review finding 2: stale-priced override tokens. The user approved a card priced at
  // approvedCostUsd; if provenance changed and the recomputed cost moved past tolerance, the
  // stale token must be refused and the failure re-escalated at the CURRENT price.
  describe("override stale-price guard", () => {
    const override = (approvedCostUsd?: number) => ({
      approvedEscalations: [{ kind: "wash_sale_ask" as const, symbol: "TSLA", token: "tok-abc", ...(approvedCostUsd != null ? { approvedCostUsd } : {}) }]
    });

    it("tolerance = max($1, 1% of the approved cost)", () => {
      expect(washSaleOverrideCostTolerance(120)).toBe(1.2);
      expect(washSaleOverrideCostTolerance(10)).toBe(1); // floor
    });

    it("honors when the cost is unchanged", () => {
      const decision = evaluateTradeProposal(buy, ctx(askPolicy, override(120))); // current cost $120
      expect(decision.approved).toBe(true);
      expect(decision.washSale?.outcome).toBe("approved_via_override");
    });

    it("honors when the cost DECREASED since approval (strictly better for the user)", () => {
      const decision = evaluateTradeProposal(buy, ctx(askPolicy, { ...override(500), washSaleLocks: locks(500) })); // approved $500, now $120
      expect(decision.approved).toBe(true);
      expect(decision.washSale?.outcome).toBe("approved_via_override");
    });

    it("honors a small increase within tolerance", () => {
      // Approved at $119.00; current $120.00; tolerance max($1, 1%*119=$1.19) => $120.19 >= $120.
      const decision = evaluateTradeProposal(buy, ctx(askPolicy, override(119)));
      expect(decision.approved).toBe(true);
      expect(decision.washSale?.outcome).toBe("approved_via_override");
    });

    it("refuses and RE-ESCALATES at the current price when the cost increased beyond tolerance", () => {
      // Approved at $120 but another $4,500 of losses posted: lossUsd 5000 -> current cost $1,200.
      const decision = evaluateTradeProposal(buy, ctx(askPolicy, { ...override(120), washSaleLocks: locks(5000) }));
      expect(decision.approved).toBe(false);
      const reason = decision.reasons.join(" ");
      expect(reason).toContain("changed since you approved");
      expect(reason).toContain("$120.00");
      expect(reason).toContain("$1200.00");
      expect(decision.washSale?.outcome).toBe("reescalated_cost_changed");
      // A FRESH escalatable entry carries the CURRENT cost so the re-approval prices honestly.
      const entry = (decision.escalations ?? []).find((e) => e.kind === "wash_sale_ask");
      expect(entry?.washSale?.estimatedTaxCostUsd).toBe(1200);
      // ...and it routes back to a pending card in either authority.
      expect(shouldEscalateDecision(decision, askPolicy)).toBe(true);
    });

    it("re-escalates when the approved card was unpriced but the cost is now priceable", () => {
      const decision = evaluateTradeProposal(buy, ctx(askPolicy, override(undefined))); // approved unpriced; now $120
      expect(decision.approved).toBe(false);
      expect(decision.washSale?.outcome).toBe("reescalated_cost_changed");
      expect(decision.reasons.join(" ")).toContain("unpriced -> ~$120.00");
    });

    it("approvedEscalationsFromDecision carries the card's priced cost into the override handle", () => {
      const stored: PolicyDecision = {
        approved: false,
        reasons: ["r"],
        escalations: [
          { kind: "wash_sale_ask", reason: "r", symbol: "TSLA", token: "tok-9", washSale: { estimatedTaxCostUsd: 120, disallowedLossUsd: 500 } }
        ]
      };
      expect(approvedEscalationsFromDecision(stored)).toEqual([
        { kind: "wash_sale_ask", symbol: "TSLA", token: "tok-9", approvedCostUsd: 120 }
      ]);
    });
  });

  it("ignores an override for a different symbol", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(askPolicy, { approvedEscalations: [{ kind: "wash_sale_ask", symbol: "AAPL", token: "tok-abc" }] })
    );
    expect(decision.approved).toBe(false);
    expect(decision.washSale?.outcome).toBe("ask_escalated");
  });

  it("an override never bypasses OTHER gates — the full gate re-runs at approval time", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(askPolicy, {
        approvedEscalations: [{ kind: "wash_sale_ask", symbol: "TSLA", token: "tok-abc", approvedCostUsd: 120 }],
        dailyNotionalUsed: 49_500 // 49,500 + 3,000 > 50,000 daily cap
      })
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain("Daily notional limit would be exceeded.");
    // The wash-sale gate itself was satisfied by the override…
    expect(decision.washSale?.outcome).toBe("approved_via_override");
    // …but the still-binding daily cap keeps the decision refused.
  });
});

describe("wash-sale handling — mode 'auto' (always proceeds; priced cost is receipt telemetry, not a veto)", () => {
  const autoPolicy = policyWith({ taxSettings: taxSettings({ washSaleHandling: "auto" }) });

  it("proceeds and records the priced expected-edge math on the receipt (never silent)", () => {
    // edge = 3000 × 20% take-profit × 80% confidence = $480. Recorded, not compared to a threshold.
    const decision = evaluateTradeProposal(buy, ctx(autoPolicy));
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("auto_proceeded");
    expect(decision.washSale?.expectedEdgeUsd).toBe(480);
    expect(decision.washSale?.estimatedTaxCostUsd).toBe(120);
    expect(decision.washSale?.edgeMultiple).toBe(WASH_SALE_AUTO_EDGE_MULTIPLE);
  });

  it("still proceeds when the expected edge is small — owner decision 2026-07-03 removed the threshold veto", () => {
    // Confidence 40 → edge = 3000 × 0.2 × 0.4 = $240, well under the old 3x-cost threshold — but
    // "auto" no longer vetoes on this math, so the buy proceeds anyway.
    const decision = evaluateTradeProposal({ ...buy, confidenceScore: 40 }, ctx(autoPolicy));
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("auto_proceeded");
    expect(decision.washSale?.expectedEdgeUsd).toBe(240);
    expect(decision.reasons).toHaveLength(0);
  });

  it("proceeds even when the cost cannot be priced (legacy Set, no provenance)", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(autoPolicy, { washSaleLocks: undefined, washSaleLockedSymbols: new Set(["TSLA"]) })
    );
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("auto_proceeded");
    expect(decision.washSale?.estimatedTaxCostUsd).toBeUndefined();
  });

  it("proceeds even with missing conviction (expected edge prices at $0 on the receipt, still not a veto)", () => {
    const decision = evaluateTradeProposal({ ...buy, confidenceScore: undefined }, ctx(autoPolicy));
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("auto_proceeded");
    expect(decision.washSale?.expectedEdgeUsd).toBe(0);
  });
});

describe("washSaleExpectedEdgeUsd — receipt telemetry math (not a gate — owner decision 2026-07-03)", () => {
  const policy = policyWith();

  it("= notional × takeProfitPct × confidence", () => {
    expect(washSaleExpectedEdgeUsd(buy, policy, 3000)).toBe(480); // 3000 × 0.20 × 0.80
  });

  it("prefers the proposal's own bracketTakeProfit over the policy percentage", () => {
    const withBracket = { ...buy, referencePrice: 100, bracketTakeProfit: 110 }; // 10% target
    expect(washSaleExpectedEdgeUsd(withBracket, policy, 3000)).toBe(240); // 3000 × 0.10 × 0.80
  });

  it("degrades to $0 (an honest 'unpriced' receipt value) without conviction or a positive target", () => {
    expect(washSaleExpectedEdgeUsd({ ...buy, confidenceScore: undefined }, policy, 3000)).toBe(0);
    const noTarget = policyWith({ riskRules: { ...policy.riskRules, takeProfitPct: 0 } });
    expect(washSaleExpectedEdgeUsd(buy, noTarget, 3000)).toBe(0);
    expect(washSaleExpectedEdgeUsd(buy, policy, 0)).toBe(0);
  });
});

describe("IRA-replacement default disregard — every taxable wash-sale mode", () => {
  for (const handling of ["block", "ask", "auto"] as const) {
    it(`allows and annotates an IRA rebuy of a taxable-loss-locked symbol in mode '${handling}'`, () => {
      const decision = evaluateTradeProposal(
        { ...buy, confidenceScore: 100 },
        ctx(policyWith({ taxSettings: taxSettings({ washSaleHandling: handling, taxationType: "roth_ira" }) }))
      );
      expect(decision.approved).toBe(true);
      expect(decision.reasons).toHaveLength(0);
      expect(decision.washSale?.outcome).toBe("ira_disregarded");
      expect(decision.washSale?.note).toBe(IRA_WASH_SALE_DISREGARD_NOTE);
      // Never escalatable.
      expect(decision.escalations ?? []).toHaveLength(0);
    });
  }

  it("detects the IRA via broker-reported accountCapabilities.accountType too", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ taxSettings: taxSettings({ washSaleHandling: "ask" }) }), { accountCapabilities: iraCapable })
    );
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("ira_disregarded");
  });

  // Codex review finding 1: the ConnectedAccount row's taxationType is the SOURCE OF TRUTH.
  // A legacy/manual IRA can have capabilities absent (or reporting "brokerage") AND a policy
  // taxSettings without taxationType — the IRA disregard path must still fire in ask AND auto modes.
  for (const handling of ["ask", "auto"] as const) {
    it(`disregards in mode '${handling}' when ONLY ConnectedAccount.taxationType marks the buyer as an IRA (no capabilities)`, () => {
      const decision = evaluateTradeProposal(
        { ...buy, confidenceScore: 100 },
        ctx(policyWith({ taxSettings: taxSettings({ washSaleHandling: handling }) }), {
          accountTaxationType: "roth_ira"
          // capabilities intentionally absent; taxSettings carries no taxationType
        })
      );
      expect(decision.approved).toBe(true);
      expect(decision.washSale?.outcome).toBe("ira_disregarded");
      expect(decision.escalations ?? []).toHaveLength(0);
    });

    it(`disregards in mode '${handling}' when capabilities say "brokerage" but the ConnectedAccount is a traditional IRA`, () => {
      const brokerageCaps: AccountCapabilities = { ...iraCapable, accountType: "brokerage" };
      const decision = evaluateTradeProposal(
        { ...buy, confidenceScore: 100 },
        ctx(policyWith({ taxSettings: taxSettings({ washSaleHandling: handling }) }), {
          accountTaxationType: "traditional_ira",
          accountCapabilities: brokerageCaps
        })
      );
      expect(decision.approved).toBe(true);
      expect(decision.washSale?.outcome).toBe("ira_disregarded");
    });
  }

  // Codex review finding (round 2): the row is a SOURCE OF TRUTH, meaning PRECEDENCE — when the
  // ConnectedAccount states "taxable", a stale IRA value left behind in policy taxSettings must
  // not reclassify the buyer and apply the Rev. Rul. 2008-5 hard block to a taxable rebuy.
  it("row-level 'taxable' overrides a stale IRA value in policy taxSettings — ask mode escalates instead of hard-blocking", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ taxSettings: taxSettings({ washSaleHandling: "ask", taxationType: "roth_ira" }) }), {
        accountTaxationType: "taxable"
      })
    );
    expect(decision.approved).toBe(false); // the symbol is still locked — but approvable
    expect(decision.washSale?.outcome).toBe("ask_escalated");
    expect((decision.escalations ?? []).some((entry) => entry.kind === "wash_sale_ask")).toBe(true);
  });

  it("row-level 'taxable' + stale policy IRA value + guard off: the taxable rebuy proceeds", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ taxSettings: taxSettings({ washSaleGuard: false, taxationType: "traditional_ira" }) }), {
        accountTaxationType: "taxable"
      })
    );
    expect(decision.approved).toBe(true);
    expect(decision.washSale).toBeUndefined();
  });

  it("override tokens are irrelevant — default IRA disregard proceeds as annotation, not approval override", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ taxSettings: taxSettings({ washSaleHandling: "ask", taxationType: "traditional_ira" }) }), {
        approvedEscalations: [{ kind: "wash_sale_ask", symbol: "TSLA", token: "tok-abc" }]
      })
    );
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("ira_disregarded");
    expect(decision.washSale?.overrideToken).toBeUndefined();
  });

  it("default disregard applies even when the per-account washSaleGuard flag is off (resolveTaxSettings disables it for IRAs)", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ taxSettings: taxSettings({ washSaleGuard: false, taxationType: "roth_ira" }) }))
    );
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("ira_disregarded");
  });

  it("taxable buyer with washSaleGuard off is still allowed (pre-existing behavior unchanged)", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ taxSettings: taxSettings({ washSaleGuard: false }) }))
    );
    expect(decision.approved).toBe(true);
    expect(decision.washSale).toBeUndefined();
  });

  it("explicit iraWashSaleHandling 'block' is the stricter opt-in and hard-blocks", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ taxSettings: taxSettings({ taxationType: "roth_ira", iraWashSaleHandling: "block" }) }))
    );
    expect(decision.approved).toBe(false);
    expect(decision.washSale?.outcome).toBe("blocked_ira");
  });

  it("IRA Auto proceeds with auto_proceeded receipt telemetry", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ taxSettings: taxSettings({ taxationType: "roth_ira", iraWashSaleHandling: "auto" }) }))
    );
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("auto_proceeded");
    expect(decision.reasons).toHaveLength(0);
  });

  it("optional min-loss: IRA Block does not lock a $10 loss when the floor is $50", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(
        policyWith({
          taxSettings: taxSettings({ taxationType: "roth_ira", iraWashSaleHandling: "block", washSaleMinLossUsd: 50 })
        }),
        { washSaleLocks: locks(10) }
      )
    );
    expect(decision.approved).toBe(true);
    expect(decision.washSale).toBeUndefined();
    expect(decision.reasons).toHaveLength(0);
  });

  it("optional min-loss: blank floor means every loss is in play", () => {
    expect(iraWashSaleMinLossUsd(undefined)).toBeUndefined();
    expect(iraWashSaleMinLossUsd({})).toBeUndefined();
    expect(iraWashSaleMinLossUsd({ washSaleMinLossUsd: 0 })).toBeUndefined();
    expect(iraWashSaleMinLossUsd({ washSaleMinLossUsd: 25 })).toBe(25);
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ taxSettings: taxSettings({ taxationType: "roth_ira", iraWashSaleHandling: "block" }) }), {
        washSaleLocks: locks(10)
      })
    );
    expect(decision.approved).toBe(false);
    expect(decision.washSale?.outcome).toBe("blocked_ira");
  });
});


describe("IRA wash-sale disregard (taxSettings.iraWashSaleHandling = 'disregard')", () => {
  const iraDisregard = (handling: "block" | "ask" | "auto") =>
    policyWith({
      taxSettings: taxSettings({ washSaleHandling: handling, taxationType: "roth_ira", iraWashSaleHandling: "disregard" })
    });

  for (const handling of ["block", "ask", "auto"] as const) {
    it(`proceeds with outcome 'ira_disregarded' + the verbatim note in washSaleHandling mode '${handling}'`, () => {
      const decision = evaluateTradeProposal(buy, ctx(iraDisregard(handling)));
      expect(decision.approved).toBe(true);
      expect(decision.washSale?.outcome).toBe("ira_disregarded");
      // VERBATIM owner-approved annotation.
      expect(decision.washSale?.note).toBe("Wash Sale (Technically, but IRA purchase unreported to IRS)");
      expect(decision.washSale?.note).toBe(IRA_WASH_SALE_DISREGARD_NOTE);
      // Priced provenance still rides the audit record.
      expect(decision.washSale?.account).toBe("ACC1");
      expect(decision.washSale?.disallowedLossUsd).toBe(500);
      expect(decision.washSale?.estimatedTaxCostUsd).toBe(120);
      // Nothing was escalated and no reason was pushed — the normal authority flow decides.
      expect(decision.reasons).toHaveLength(0);
      expect(decision.escalations ?? []).toHaveLength(0);
    });
  }

  it("still respects every OTHER gate — a binding daily cap refuses the buy, annotation intact", () => {
    const decision = evaluateTradeProposal(buy, ctx(iraDisregard("block"), { dailyNotionalUsed: 49_500 }));
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain("Daily notional limit would be exceeded.");
    // The wash-sale gate itself disregarded (annotated) — the refusal is purely the cap.
    expect(decision.washSale?.outcome).toBe("ira_disregarded");
  });

  it("override tokens stay irrelevant to IRA outcomes — disregard proceeds AS a disregard, not as an override", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(iraDisregard("ask"), { approvedEscalations: [{ kind: "wash_sale_ask", symbol: "TSLA", token: "tok-abc", approvedCostUsd: 120 }] })
    );
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("ira_disregarded");
    expect(decision.washSale?.overrideToken).toBeUndefined();
  });

  it("detected via the ConnectedAccount row alone (source of truth), disregard still applies", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ taxSettings: taxSettings({ iraWashSaleHandling: "disregard" }) }), { accountTaxationType: "roth_ira" })
    );
    expect(decision.approved).toBe(true);
    expect(decision.washSale?.outcome).toBe("ira_disregarded");
  });

  it("taxable buyers are untouched by the IRA setting — ask machinery unchanged", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ taxSettings: taxSettings({ washSaleHandling: "ask", iraWashSaleHandling: "disregard" }) }))
    );
    expect(decision.approved).toBe(false);
    expect(decision.washSale?.outcome).toBe("ask_escalated");
  });
});

describe("time-context gate escalations (closed allowlist)", () => {
  const cleanLocks = { washSaleLocks: new Map() as WashSaleLockMap };

  it("daily notional cap failure is escalatable", () => {
    const decision = evaluateTradeProposal(buy, ctx(policyWith(), { ...cleanLocks, dailyNotionalUsed: 49_500 }));
    expect(decision.approved).toBe(false);
    expect(decision.escalations?.map((e) => e.kind)).toContain("daily_notional_cap");
  });

  it("hourly notional cap failure is escalatable", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ maxHourlyNotional: 1000 }), { ...cleanLocks, hourlyNotionalUsed: 900 })
    );
    expect(decision.escalations?.map((e) => e.kind)).toContain("hourly_notional_cap");
  });

  it("daily opening-order cap failure is escalatable", () => {
    const decision = evaluateTradeProposal(buy, ctx(policyWith(), { ...cleanLocks, dailyOrderCount: DEFAULT_POLICY.maxDailyOrders }));
    expect(decision.escalations?.map((e) => e.kind)).toContain("daily_order_cap");
  });

  it("fundamentals/scan-age staleness is NOT escalatable (owner: never block on staleness)", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ maxFundamentalsAgeSec: 60 }), {
        ...cleanLocks,
        now: new Date("2026-07-02T15:00:00.000Z"),
        marketScan: {
          source: "test",
          generatedAt: "2026-07-02T14:00:00.000Z",
          scannedSymbols: 1,
          returnedQuotes: 1,
          topCandidates: [],
          sectorBySymbol: {},
          quotesBySymbol: { TSLA: { symbol: "TSLA", price: 100, volume: 1, intradayChangePct: 0, positionMarketValue: 0, score: 1, asOf: "2026-07-02T15:00:00.000Z" } },
          warnings: []
        }
      })
    );
    // Annotate only — no reasons, no escalations, still approved.
    expect(decision.approved).toBe(true);
    expect(decision.escalations?.map((e) => e.kind) ?? []).not.toContain("quote_staleness");
    expect(decision.reasons.every((r) => !r.includes("staleness_gate"))).toBe(true);
  });

  it("PER-ORDER caps are never escalatable (hard class)", () => {
    // Daily budget has plenty of room — ONLY the per-order cap trips.
    const decision = evaluateTradeProposal(
      { ...buy, dollarAmount: 60_000 },
      ctx(policyWith({ maxDailyNotional: 100_000 }), {
        ...cleanLocks,
        estimatedNotional: 60_000,
        // Keep the daily budget above the test order so this assertion remains
        // about the hard per-order cap only.
        portfolio: { ...portfolio, buyingPower: 100_000 }
      })
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("exceeds the maximum order limit");
    expect((decision.escalations ?? []).map((e) => e.kind)).toHaveLength(0);
    // The per-order failure contributed no escalation entry, so the decision can never
    // satisfy shouldEscalateDecision's every-reason-covered rule.
    expect(shouldEscalateDecision(decision, policyWith())).toBe(false);
  });

  it("blocklisted symbols are never escalatable (hard class)", () => {
    const decision = evaluateTradeProposal(
      buy,
      ctx(policyWith({ blocklist: ["TSLA"] }), cleanLocks)
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("not in the allowed universe");
    expect(shouldEscalateDecision(decision, policyWith())).toBe(false);
  });
});

describe("shouldEscalateDecision — escalation routing rules", () => {
  const askDecision: PolicyDecision = {
    approved: false,
    reasons: ["Rebuying TSLA now forfeits ~$120.00 of tax deduction (wash sale — loss in ACC1, clears 2026-07-20). Your call."],
    escalations: [
      {
        kind: "wash_sale_ask",
        reason: "Rebuying TSLA now forfeits ~$120.00 of tax deduction (wash sale — loss in ACC1, clears 2026-07-20). Your call.",
        symbol: "TSLA"
      }
    ]
  };
  const capDecision: PolicyDecision = {
    approved: false,
    reasons: ["Daily notional limit would be exceeded."],
    escalations: [{ kind: "daily_notional_cap", reason: "Daily notional limit would be exceeded.", symbol: "TSLA" }]
  };

  it("ask-mode wash sales escalate under BOTH authorities", () => {
    expect(shouldEscalateDecision(askDecision, policyWith({ strategyAuthority: "propose" }))).toBe(true);
    expect(shouldEscalateDecision(askDecision, policyWith({ strategyAuthority: "decide" }))).toBe(true);
  });

  it("time-context gates escalate ONLY under decide authority", () => {
    expect(shouldEscalateDecision(capDecision, policyWith({ strategyAuthority: "decide" }))).toBe(true);
    expect(shouldEscalateDecision(capDecision, policyWith({ strategyAuthority: "propose" }))).toBe(false);
  });

  it("a single uncovered reason keeps the whole proposal blocked", () => {
    const mixed: PolicyDecision = {
      ...askDecision,
      reasons: [...askDecision.reasons, "Order of $60000.00 exceeds the maximum order limit of $50000.00"]
    };
    expect(shouldEscalateDecision(mixed, policyWith({ strategyAuthority: "decide" }))).toBe(false);
  });

  it("approved or reason-less decisions never escalate", () => {
    expect(shouldEscalateDecision({ approved: true, reasons: [] }, policyWith())).toBe(false);
    expect(shouldEscalateDecision({ approved: false, reasons: ["x"] }, policyWith())).toBe(false);
  });
});

describe("approvedEscalationsFromDecision — server-stored override extraction", () => {
  it("yields only tokenized wash_sale_ask handles (time-context entries just re-gate)", () => {
    const stored: PolicyDecision = {
      approved: false,
      reasons: ["a", "b", "c"],
      escalations: [
        { kind: "wash_sale_ask", reason: "a", symbol: "TSLA", token: "tok-1" },
        { kind: "daily_notional_cap", reason: "b", symbol: "TSLA", token: "tok-2" },
        { kind: "wash_sale_ask", reason: "c", symbol: "AAPL" } // token-less: never minted → no handle
      ]
    };
    expect(approvedEscalationsFromDecision(stored)).toEqual([{ kind: "wash_sale_ask", symbol: "TSLA", token: "tok-1" }]);
    expect(approvedEscalationsFromDecision(undefined)).toEqual([]);
    expect(approvedEscalationsFromDecision({ approved: true, reasons: [] })).toEqual([]);
  });

  it("round-trip: a stored escalated card re-gates to approved via its token — and only then", () => {
    const askPolicy = policyWith({ taxSettings: taxSettings({ washSaleHandling: "ask" }) });
    // 1. Gate refuses and marks escalatable (run loop would persist this with a minted token).
    const gateDecision = evaluateTradeProposal(buy, ctx(askPolicy));
    expect(gateDecision.approved).toBe(false);
    const persisted: PolicyDecision = {
      ...gateDecision,
      escalations: (gateDecision.escalations ?? []).map((e) => ({ ...e, token: "srv-tok" }))
    };
    // 2. Approval path derives override handles from the STORED row only — including the cost
    //    priced on the approved card (the stale-price guard's baseline).
    const overrides = approvedEscalationsFromDecision(persisted);
    expect(overrides).toEqual([{ kind: "wash_sale_ask", symbol: "TSLA", token: "srv-tok", approvedCostUsd: 120 }]);
    // 3. Full re-gate with the override → approved, audited.
    const regate = evaluateTradeProposal(buy, ctx(askPolicy, { approvedEscalations: overrides }));
    expect(regate.approved).toBe(true);
    expect(regate.washSale?.outcome).toBe("approved_via_override");
    // 4. Without the stored token the same approval attempt still blocks.
    const noToken = evaluateTradeProposal(buy, ctx(askPolicy));
    expect(noToken.approved).toBe(false);
  });
});
