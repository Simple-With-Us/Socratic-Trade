import { describe, expect, it } from "vitest";
import { stopFlowModel } from "../app/console/guardrails/stop-flow";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { TradingPolicy } from "../src/lib/types";

const policy = (over: Partial<TradingPolicy> = {}): TradingPolicy => ({ ...DEFAULT_POLICY, ...over });

const lane = (p: TradingPolicy, key: string) => stopFlowModel(p).find((l) => l.key === key)!;
const node = (p: TradingPolicy, laneKey: string, nodeKey: string) =>
  lane(p, laneKey).nodes.find((n) => n.key === nodeKey)!;

describe("stopFlowModel — the guardrails stop diagram tells the truth about the policy", () => {
  it("default policy: ATR + beta + flat base all active, trailing off, app monitor always on", () => {
    const p = policy();
    expect(node(p, "distance", "atr").active).toBe(true);
    expect(node(p, "distance", "beta").active).toBe(true);
    expect(node(p, "distance", "fixed")).toMatchObject({ active: true, value: "−8%" });
    expect(node(p, "trailing", "trail").active).toBe(false);
    expect(node(p, "enforcement", "app").active).toBe(true);
  });

  it("clearing the base stop % deactivates the WHOLE distance lane (ATR/beta size nothing without it)", () => {
    const p = policy({ riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 0 } });
    expect(node(p, "distance", "atr").active).toBe(false);
    expect(node(p, "distance", "beta").active).toBe(false);
    expect(node(p, "distance", "fixed").active).toBe(false);
    expect(lane(p, "distance").note).toMatch(/no per-position stop/i);
  });

  it("broker-held enforcement reflects the account's broker: Alpaca brackets vs Robinhood opt-in vs none", () => {
    // No broker connected → nothing broker-held; the app monitor is the only enforcement.
    expect(node(policy(), "enforcement", "broker").active).toBe(false);
    // Alpaca with default brackets → broker-held active.
    const alpaca = policy({ activeBroker: "alpaca" });
    expect(node(alpaca, "enforcement", "broker")).toMatchObject({ active: true, value: expect.stringContaining("bracket") });
    // Robinhood without the opt-in → not broker-held; with it → broker-held.
    expect(node(policy({ activeBroker: "robinhood" }), "enforcement", "broker").active).toBe(false);
    expect(node(policy({ activeBroker: "robinhood", robinhoodBrokerStops: true }), "enforcement", "broker").active).toBe(true);
  });

  it("a configured trailing % lights the trailing lane and adds broker-held trailing where supported", () => {
    const trail = { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5 };
    const alpaca = policy({ activeBroker: "alpaca", riskRules: trail });
    expect(node(alpaca, "trailing", "trail")).toMatchObject({ active: true, value: "−5% from peak" });
    expect(node(alpaca, "enforcement", "broker").value).toMatch(/native trailing/);
    // Robinhood: broker-held trailing requires the resting-stops opt-in.
    const rhNoOptIn = policy({ activeBroker: "robinhood", riskRules: trail });
    expect(node(rhNoOptIn, "enforcement", "broker").value).not.toMatch(/trailing/);
    const rhOptIn = policy({ activeBroker: "robinhood", robinhoodBrokerStops: true, riskRules: trail });
    expect(node(rhOptIn, "enforcement", "broker").value).toMatch(/ratcheted trailing/);
    // The owner's off-switch keeps trailing app-managed only.
    const optOut = policy({ activeBroker: "alpaca", brokerTrailingStops: false, riskRules: trail });
    expect(node(optOut, "enforcement", "broker").value).not.toMatch(/trailing/);
  });

  it("qualifies broker-held trailing as long-only when short selling is enabled (Alpaca shorts stay on the app monitor)", () => {
    const trail = { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5 };
    const shortEnabled = policy({ activeBroker: "alpaca", riskRules: trail, shortSellingEnabled: true });
    expect(node(shortEnabled, "enforcement", "broker").detail).toMatch(/long positions only/i);
    // No caveat needed when shorting isn't enabled — nothing to qualify.
    const longOnly = policy({ activeBroker: "alpaca", riskRules: trail, shortSellingEnabled: false });
    expect(node(longOnly, "enforcement", "broker").detail).not.toMatch(/long positions only/i);
  });

  describe("per-position override lane — always available, independent of account config", () => {
    it("all four per-position styles are present and active regardless of account-wide stop/trailing config", () => {
      // Universal availability: even an account with NO stop-loss and NO trailing % configured at
      // all must still show every style as genuinely selectable (backed by STOP_PLAN_FALLBACK_STOP_PCT).
      const bare = policy({ riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 0, trailingStopPct: 0 } });
      const laneNodes = lane(bare, "perPosition").nodes;
      expect(laneNodes.map((n) => n.key)).toEqual(["plan-fixed", "plan-atr", "plan-trailing", "plan-none"]);
      expect(laneNodes.every((n) => n.active)).toBe(true);
    });

    it("the fixed/trailing detail text names the account's own %, or the 8% fallback when unconfigured", () => {
      const configured = policy({ riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 12, trailingStopPct: 6 } });
      expect(node(configured, "perPosition", "plan-fixed").detail).toMatch(/12%/);
      expect(node(configured, "perPosition", "plan-trailing").detail).toMatch(/6%/);
      const bare = policy({ riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 0, trailingStopPct: 0 } });
      expect(node(bare, "perPosition", "plan-fixed").detail).toMatch(/8% fallback/);
      expect(node(bare, "perPosition", "plan-trailing").detail).toMatch(/8% fallback/);
    });

    it("'none' is never silent — its detail requires a rationale and says where it's surfaced", () => {
      const p = policy();
      expect(node(p, "perPosition", "plan-none").detail).toMatch(/rationale/i);
      expect(node(p, "perPosition", "plan-none").detail).toMatch(/never hard-blocked/i);
    });

    it("the lane note explains the absent/default case and when a plan is set", () => {
      const p = policy();
      expect(lane(p, "perPosition").note).toMatch(/account's own precedence/i);
      expect(lane(p, "perPosition").note).toMatch(/opening buy\/short/i);
    });

    it("contains the RTH-only broker stop warning in the broker-held detail string", () => {
      const p = policy();
      expect(node(p, "enforcement", "broker").detail).toMatch(/Regular Trading Hours/);
    });

    it("displays the propose-authority blind spot warning on the app-managed node only under propose mode", () => {
      const proposeMode = policy({ strategyAuthority: "propose" });
      expect(node(proposeMode, "enforcement", "app").detail).toMatch(/blind spot/i);

      const decideMode = policy({ strategyAuthority: "decide" });
      expect(node(decideMode, "enforcement", "app").detail).not.toMatch(/blind spot/i);
    });
  });
});
