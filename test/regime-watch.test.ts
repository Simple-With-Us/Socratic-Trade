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
      fetchMacroData: vi.fn().mockResolvedValue({ ...BASE_MACRO, vix: "26.00" }), // Risk-Off
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValue({ ...BASE_MACRO, vix: "26.00" }), // Risk-Off
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

describe("checkRegimeFlip — regimeSeverityScoring flag gating (Lane 5)", () => {
  async function lastRegimeFlipPayload(userId: string): Promise<Record<string, unknown>> {
    const { getDb } = await import("../src/lib/db");
    const row = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'regime_flip' AND user_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(userId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : {};
  }

  it("policy.tuning.regimeSeverityScoring default OFF: no severityMacroOnly key on the regime_flip audit payload (byte-identical default)", async () => {
    vi.doMock("../src/lib/triggers", () => ({ submitMaterialEvent: vi.fn() }));
    vi.doMock("../src/lib/events", () => ({ emitDashboardEvent: vi.fn() }));
    vi.doMock("../src/lib/macro", () => ({
      fetchMacroData: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "16.00" }),
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "16.00" }),
      determineMarketRegime: (m: { vix: string }) => (parseFloat(m.vix) >= 22 ? "Risk-Off (High Volatility)" : "Neutral (Moderate)"),
    }));

    const { checkRegimeFlip } = await import("../src/lib/regime-watch");
    await checkRegimeFlip("user-d"); // seed — no flip, no audit yet

    vi.resetModules();
    vi.doMock("../src/lib/triggers", () => ({ submitMaterialEvent: vi.fn() }));
    vi.doMock("../src/lib/events", () => ({ emitDashboardEvent: vi.fn() }));
    vi.doMock("../src/lib/macro", () => ({
      fetchMacroData: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "26.00" }),
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "26.00" }),
      determineMarketRegime: (m: { vix: string }) => (parseFloat(m.vix) >= 22 ? "Risk-Off (High Volatility)" : "Neutral (Moderate)"),
    }));

    const { checkRegimeFlip: checkRegimeFlip2 } = await import("../src/lib/regime-watch");
    await checkRegimeFlip2("user-d"); // flip -> audit recorded

    const payload = await lastRegimeFlipPayload("user-d");
    expect(payload.from).toBeDefined();
    expect(payload).not.toHaveProperty("severityMacroOnly");
  });

  it("policy.tuning.regimeSeverityScoring ON: severityMacroOnly is present on the regime_flip audit payload", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    setPolicy({ ...DEFAULT_POLICY, tuning: { ...DEFAULT_POLICY.tuning, regimeSeverityScoring: true } });

    vi.doMock("../src/lib/triggers", () => ({ submitMaterialEvent: vi.fn() }));
    vi.doMock("../src/lib/events", () => ({ emitDashboardEvent: vi.fn() }));
    vi.doMock("../src/lib/macro", () => ({
      fetchMacroData: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "16.00" }),
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "16.00" }),
      determineMarketRegime: (m: { vix: string }) => (parseFloat(m.vix) >= 22 ? "Risk-Off (High Volatility)" : "Neutral (Moderate)"),
    }));

    const { checkRegimeFlip } = await import("../src/lib/regime-watch");
    await checkRegimeFlip("local"); // seed — matches getPolicy's default userId

    vi.resetModules();
    vi.doMock("../src/lib/triggers", () => ({ submitMaterialEvent: vi.fn() }));
    vi.doMock("../src/lib/events", () => ({ emitDashboardEvent: vi.fn() }));
    vi.doMock("../src/lib/macro", () => ({
      fetchMacroData: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "26.00" }),
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValueOnce({ ...BASE_MACRO, vix: "26.00" }),
      determineMarketRegime: (m: { vix: string }) => (parseFloat(m.vix) >= 22 ? "Risk-Off (High Volatility)" : "Neutral (Moderate)"),
    }));

    const { checkRegimeFlip: checkRegimeFlip2 } = await import("../src/lib/regime-watch");
    await checkRegimeFlip2("local");

    const payload = await lastRegimeFlipPayload("local");
    expect(typeof payload.severityMacroOnly).toBe("number");
  });
});

describe("checkRegimeFlip — Unknown-side outage suppression", () => {
  const UNKNOWN = "Unknown (no macro feed)";

  // determineMarketRegime mock honoring the asOf === "unavailable" contract the real classifier has.
  const regimeOf = () => (m: { vix: string; asOf?: string }) => {
    if (m.asOf === "unavailable") return UNKNOWN;
    const v = parseFloat(m.vix);
    if (v >= 30) return "Crisis (Extreme Volatility)";
    if (v >= 22) return "Risk-Off (High Volatility)";
    return "Neutral (Moderate)";
  };

  function mockMacro(macro: Record<string, unknown>) {
    vi.doMock("../src/lib/macro", () => ({
      fetchMacroData: vi.fn().mockResolvedValue(macro),
      fetchMacroDataWithLiveVix: vi.fn().mockResolvedValue(macro),
      determineMarketRegime: regimeOf(),
    }));
  }

  function mockSideEffects(submit: ReturnType<typeof vi.fn>, emit: ReturnType<typeof vi.fn>) {
    vi.doMock("../src/lib/triggers", () => ({ submitMaterialEvent: submit }));
    vi.doMock("../src/lib/events", () => ({ emitDashboardEvent: emit }));
  }

  async function auditRows(kind: string, userId: string): Promise<Array<Record<string, unknown>>> {
    const { getDb } = await import("../src/lib/db");
    const rows = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = ? AND user_id = ? ORDER BY created_at ASC")
      .all(kind, userId) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload));
  }

  async function storedRegime(userId: string): Promise<string | null> {
    const { getInternalSetting } = await import("../src/lib/db");
    return (await getInternalSetting<string>(`regime:current:${userId}`)) ?? null;
  }

  it("an outage tick holds the last-known label: no regime_flip audit, no dirty event, no material event, stored label unchanged", async () => {
    const submit = vi.fn();
    const emit = vi.fn();
    mockSideEffects(submit, emit);
    mockMacro({ ...BASE_MACRO, vix: "16.00" }); // Neutral

    const { checkRegimeFlip } = await import("../src/lib/regime-watch");
    await checkRegimeFlip("user-outage"); // seed Neutral

    vi.resetModules();
    submit.mockClear();
    emit.mockClear();
    mockSideEffects(submit, emit);
    mockMacro({ ...BASE_MACRO, vix: "", asOf: "unavailable", vixAsOf: null }); // feed down

    const { checkRegimeFlip: tick2 } = await import("../src/lib/regime-watch");
    await tick2("user-outage");

    expect(await storedRegime("user-outage")).toBe("Neutral (Moderate)");
    expect(await auditRows("regime_flip", "user-outage")).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();

    // The outage IS observable: exactly one throttled diagnostic with sourcing evidence.
    const diagnostics = await auditRows("macro_feed_unavailable", "user-outage");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].asOf).toBe("unavailable");
    expect(diagnostics[0].heldRegime).toBe("Neutral (Moderate)");
  });

  it("throttles the macro_feed_unavailable diagnostic to one row per hour across repeated outage ticks", async () => {
    mockSideEffects(vi.fn(), vi.fn());
    mockMacro({ ...BASE_MACRO, vix: "16.00" });
    const { checkRegimeFlip } = await import("../src/lib/regime-watch");
    await checkRegimeFlip("user-throttle"); // seed

    for (let i = 0; i < 3; i++) {
      vi.resetModules();
      mockSideEffects(vi.fn(), vi.fn());
      mockMacro({ ...BASE_MACRO, vix: "", asOf: "unavailable" });
      const { checkRegimeFlip: tick } = await import("../src/lib/regime-watch");
      await tick("user-throttle");
    }

    expect(await auditRows("macro_feed_unavailable", "user-throttle")).toHaveLength(1);
    expect(await auditRows("regime_flip", "user-throttle")).toHaveLength(0);
  });

  it("recovery into a different REAL escalation regime announces exactly one flip (from last-known) and submits one material event", async () => {
    const submit = vi.fn();
    const emit = vi.fn();
    mockSideEffects(submit, emit);
    mockMacro({ ...BASE_MACRO, vix: "16.00" }); // Neutral seed
    const { checkRegimeFlip } = await import("../src/lib/regime-watch");
    await checkRegimeFlip("user-recover");

    // Outage window — held, no flip.
    vi.resetModules();
    mockSideEffects(submit, emit);
    mockMacro({ ...BASE_MACRO, vix: "", asOf: "unavailable" });
    const { checkRegimeFlip: tick2 } = await import("../src/lib/regime-watch");
    await tick2("user-recover");

    // Feed recovers; the regime REALLY changed during the outage (VIX 26 -> Risk-Off).
    vi.resetModules();
    submit.mockClear();
    emit.mockClear();
    mockSideEffects(submit, emit);
    mockMacro({ ...BASE_MACRO, vix: "26.00" });
    const { checkRegimeFlip: tick3 } = await import("../src/lib/regime-watch");
    await tick3("user-recover");

    const flips = await auditRows("regime_flip", "user-recover");
    expect(flips).toHaveLength(1);
    expect(flips[0].from).toBe("Neutral (Moderate)");
    expect(flips[0].to).toBe("Risk-Off (High Volatility)");
    // Escalation into Risk-Off after recovery still submits the material event, user-scoped.
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith("user-recover", expect.objectContaining({ type: "regime" }));
    expect(emit).toHaveBeenCalledOnce();
  });

  it("a first-ever tick on an outage does NOT seed the key with the Unknown label", async () => {
    const submit = vi.fn();
    mockSideEffects(submit, vi.fn());
    mockMacro({ ...BASE_MACRO, vix: "", asOf: "unavailable" });
    const { checkRegimeFlip } = await import("../src/lib/regime-watch");
    await checkRegimeFlip("user-first-outage");

    expect(await storedRegime("user-first-outage")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(await auditRows("macro_feed_unavailable", "user-first-outage")).toHaveLength(1);

    // The first KNOWN tick then seeds silently — still no flip.
    vi.resetModules();
    submit.mockClear();
    mockSideEffects(submit, vi.fn());
    mockMacro({ ...BASE_MACRO, vix: "16.00" });
    const { checkRegimeFlip: tick2 } = await import("../src/lib/regime-watch");
    await tick2("user-first-outage");

    expect(await storedRegime("user-first-outage")).toBe("Neutral (Moderate)");
    expect(await auditRows("regime_flip", "user-first-outage")).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it("repairs a legacy stored Unknown label silently (no fake 'Unknown -> X' flip) on the first known tick", async () => {
    // Pre-gate deploys could persist the Unknown label itself. Seed that state directly.
    const { setInternalSetting } = await import("../src/lib/db");
    setInternalSetting("regime:current:user-legacy-unknown", UNKNOWN);

    const submit = vi.fn();
    const emit = vi.fn();
    mockSideEffects(submit, emit);
    mockMacro({ ...BASE_MACRO, vix: "26.00" }); // recovered, Risk-Off
    const { checkRegimeFlip } = await import("../src/lib/regime-watch");
    await checkRegimeFlip("user-legacy-unknown");

    expect(await storedRegime("user-legacy-unknown")).toBe("Risk-Off (High Volatility)");
    expect(await auditRows("regime_flip", "user-legacy-unknown")).toHaveLength(0);
    // Treated as a silent reseed — no material event either.
    expect(submit).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
