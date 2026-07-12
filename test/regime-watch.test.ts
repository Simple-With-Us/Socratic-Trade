import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stable macro data shared across tests.
const BASE_MACRO = {
  fedFundsRate: "5.25%",
  dgs3moTreasury: "5.10%",
  dgs2Treasury: "4.60%",
  dgs10Treasury: "4.20%",
  inflationExpectation10y: "2.30%",
  cpiInflation: "3.10%",
  corePCE: "2.80%",
  realGDPGrowth: "2.00%",
  unemploymentRate: "3.90%",
  initialClaims: "220K",
  m2MoneySupply: "20.8T",
  m2GrowthYoY: "2.50%",
  hyCreditSpread: "3.20%",
  usdIndex: "121.00",
  wtiOil: "$75.00",
  housingStarts: "1.3M",
  consumerSentiment: "75.0",
  vix: "15.00",
  vix3m: "17.00",
  asOf: "2026-06-21",
};

// Each test gets a fresh in-memory DB to avoid state bleed.
beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-regime-watch-${randomUUID()}.db`)}`;
});

describe("checkRegimeFlip — material-event gating", () => {
  it("submits a material event to the flipping user when flipping INTO an escalation regime (Risk-Off)", async () => {
    const submit = vi.fn();
    vi.doMock("../src/lib/triggers", () => ({ submitMaterialEvent: submit }));
    vi.doMock("../src/lib/events", () => ({ emitDashboardEvent: vi.fn() }));

    // First call seeds the stored regime as Neutral.
    vi.doMock("../src/lib/macro", () => ({
      fetchMacroData: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "16.00" }), // Neutral
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "16.00" }), // Neutral
      determineMarketRegime: (m: { vix: string }) => {
        const v = parseFloat(m.vix);
        if (v >= 30) return "Crisis (Extreme Volatility)";
        if (v >= 22) return "Risk-Off (High Volatility)";
        return "Neutral (Moderate)";
      },
    }));

    const { checkRegimeFlip } = await import("../src/lib/regime-watch");

    // Seed run — stores Neutral, no broadcast.
    await checkRegimeFlip("user-a");
    expect(submit).not.toHaveBeenCalled();

    // Reset modules so the mock can return a different macro value.
    vi.resetModules();
    submit.mockClear();
    vi.doMock("../src/lib/triggers", () => ({ submitMaterialEvent: submit }));
    vi.doMock("../src/lib/events", () => ({ emitDashboardEvent: vi.fn() }));
    vi.doMock("../src/lib/macro", () => ({
      fetchMacroData: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "26.00" }), // Risk-Off
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "26.00" }), // Risk-Off
      determineMarketRegime: (m: { vix: string }) => {
        const v = parseFloat(m.vix);
        if (v >= 30) return "Crisis (Extreme Volatility)";
        if (v >= 22) return "Risk-Off (High Volatility)";
        return "Neutral (Moderate)";
      },
    }));

    const { checkRegimeFlip: checkRegimeFlip2 } = await import("../src/lib/regime-watch");
    await checkRegimeFlip2("user-a");

    // Flipped into Risk-Off — IS an escalation regime — should submit the event to THIS user only
    // (scoped, not broadcast to every active user).
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(
      "user-a",
      expect.objectContaining({ type: "regime" })
    );
  });

  it("does NOT broadcast when flipping back from an escalation regime to a calm regime", async () => {
    const submit = vi.fn();
    vi.doMock("../src/lib/triggers", () => ({ submitMaterialEvent: submit }));
    vi.doMock("../src/lib/events", () => ({ emitDashboardEvent: vi.fn() }));

    // Seed with a Crisis regime as the stored current value.
    vi.doMock("../src/lib/macro", () => ({
      fetchMacroData: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "35.00" }), // Crisis
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "35.00" }), // Crisis
      determineMarketRegime: (m: { vix: string }) => {
        const v = parseFloat(m.vix);
        if (v >= 30) return "Crisis (Extreme Volatility)";
        if (v >= 22) return "Risk-Off (High Volatility)";
        return "Neutral (Moderate)";
      },
    }));

    const { checkRegimeFlip } = await import("../src/lib/regime-watch");
    // First call seeds the stored regime as Crisis (no flip yet, so no broadcast).
    await checkRegimeFlip("user-b");
    expect(submit).not.toHaveBeenCalled();

    // Second call — also Crisis — no flip, no broadcast.
    vi.resetModules();
    submit.mockClear();
    vi.doMock("../src/lib/triggers", () => ({ submitMaterialEvent: submit }));
    vi.doMock("../src/lib/events", () => ({ emitDashboardEvent: vi.fn() }));
    vi.doMock("../src/lib/macro", () => ({
      fetchMacroData: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "35.00" }), // same Crisis
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "35.00" }), // same Crisis
      determineMarketRegime: (m: { vix: string }) => {
        const v = parseFloat(m.vix);
        if (v >= 30) return "Crisis (Extreme Volatility)";
        if (v >= 22) return "Risk-Off (High Volatility)";
        return "Neutral (Moderate)";
      },
    }));

    const { checkRegimeFlip: checkRegimeFlip2 } = await import("../src/lib/regime-watch");
    await checkRegimeFlip2("user-b");
    expect(submit).not.toHaveBeenCalled();

    // Third call — VIX drops to calm (Neutral). This IS a flip but NOT into an escalation regime.
    vi.resetModules();
    submit.mockClear();
    vi.doMock("../src/lib/triggers", () => ({ submitMaterialEvent: submit }));
    vi.doMock("../src/lib/events", () => ({ emitDashboardEvent: vi.fn() }));
    vi.doMock("../src/lib/macro", () => ({
      fetchMacroData: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "14.00" }), // Neutral
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "14.00" }), // Neutral
      determineMarketRegime: (m: { vix: string }) => {
        const v = parseFloat(m.vix);
        if (v >= 30) return "Crisis (Extreme Volatility)";
        if (v >= 22) return "Risk-Off (High Volatility)";
        return "Neutral (Moderate)";
      },
    }));

    const { checkRegimeFlip: checkRegimeFlip3 } = await import("../src/lib/regime-watch");
    await checkRegimeFlip3("user-b");

    // Flipped from Crisis -> Neutral — de-escalation — should NOT broadcast.
    expect(submit).not.toHaveBeenCalled();
  });

  it("still records an audit entry for all flips, including de-escalations", async () => {
    const submit = vi.fn();
    vi.doMock("../src/lib/triggers", () => ({ submitMaterialEvent: submit }));
    vi.doMock("../src/lib/events", () => ({ emitDashboardEvent: vi.fn() }));

    // Seed with Risk-Off as the stored current.
    vi.doMock("../src/lib/macro", () => ({
      fetchMacroData: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "25.00" }), // Risk-Off
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "25.00" }), // Risk-Off
      determineMarketRegime: (m: { vix: string }) => {
        const v = parseFloat(m.vix);
        if (v >= 30) return "Crisis (Extreme Volatility)";
        if (v >= 22) return "Risk-Off (High Volatility)";
        return "Neutral (Moderate)";
      },
    }));

    const { checkRegimeFlip } = await import("../src/lib/regime-watch");
    await checkRegimeFlip("user-c");

    // Now flip back to Neutral (de-escalation).
    vi.resetModules();
    submit.mockClear();
    const emitDashboard = vi.fn();
    vi.doMock("../src/lib/triggers", () => ({ submitMaterialEvent: submit }));
    vi.doMock("../src/lib/events", () => ({ emitDashboardEvent: emitDashboard }));
    vi.doMock("../src/lib/macro", () => ({
      fetchMacroData: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "14.00" }), // Neutral
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "14.00" }), // Neutral
      determineMarketRegime: (m: { vix: string }) => {
        const v = parseFloat(m.vix);
        if (v >= 30) return "Crisis (Extreme Volatility)";
        if (v >= 22) return "Risk-Off (High Volatility)";
        return "Neutral (Moderate)";
      },
    }));

    const { checkRegimeFlip: checkRegimeFlip2 } = await import("../src/lib/regime-watch");
    await checkRegimeFlip2("user-c");

    // No broadcast (de-escalation), but dashboard event was still emitted (audit path).
    expect(submit).not.toHaveBeenCalled();
    expect(emitDashboard).toHaveBeenCalledOnce();
    expect(emitDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ type: "dirty" })
    );
  });
});
