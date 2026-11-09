import { describe, expect, it } from "vitest";
import {
  buildRedTeamModelRows,
  RED_TEAM_EFFICACY_MIN_RESOLVED,
  RED_TEAM_EFFICACY_SOLID_RESOLVED,
  RED_TEAM_UNATTRIBUTED_MODEL,
  redTeamAttributionLabel,
  redTeamReturnTone,
  redTeamSampleGate,
  redTeamSampleTier
} from "../app/console/lib/red-team-efficacy";
import type { RedTeamEfficacy } from "../src/lib/performance";

describe("buildRedTeamModelRows", () => {
  it("uses the full-history byModel rows, including persisted unattributed buckets", () => {
    const efficacy: RedTeamEfficacy = {
      totalVetoes: 4,
      maturedVetoes: 4,
      unresolvableVetoes: 0,
      maturedCoveragePct: 100,
      coverage: "4/4 vetoes resolved (100%)",
      vetoValueAddRate: 50,
      survivorRiskHitRate: 50,
      avgReturnPct: -1.25,
      byModel: [
        { model: "gpt-5.4-mini", maturedVetoes: 2, vetoValueAddRate: 50, survivorRiskHitRate: 50, avgReturnPct: -2.5 },
        { model: RED_TEAM_UNATTRIBUTED_MODEL, maturedVetoes: 2, vetoValueAddRate: 50, survivorRiskHitRate: 50, avgReturnPct: 0 }
      ],
      records: [
        { runId: "1", symbol: "AAPL", returnPct: -10, model: "gpt-5.4-mini" },
        { runId: "2", symbol: "MSFT", returnPct: 5, model: "gpt-5.4-mini" },
        { runId: "3", symbol: "NVDA", returnPct: -4 },
        { runId: "4", symbol: "TSLA", returnPct: 4 }
      ]
    };

    const rows = buildRedTeamModelRows(efficacy);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ model: "gpt-5.4-mini", maturedVetoes: 2 });
    expect(rows[1]).toMatchObject({
      model: RED_TEAM_UNATTRIBUTED_MODEL,
      maturedVetoes: 2,
      vetoValueAddRate: 50,
      survivorRiskHitRate: 50,
      avgReturnPct: 0
    });
  });

  it("returns empty for missing efficacy data", () => {
    expect(buildRedTeamModelRows(undefined)).toEqual([]);
    expect(buildRedTeamModelRows(null)).toEqual([]);
  });
});

describe("sample gating + labels", () => {
  it("matches the #1115-style thresholds", () => {
    expect(redTeamSampleTier(RED_TEAM_EFFICACY_MIN_RESOLVED - 1)).toBe("hidden");
    expect(redTeamSampleTier(RED_TEAM_EFFICACY_MIN_RESOLVED)).toBe("caution");
    expect(redTeamSampleTier(RED_TEAM_EFFICACY_SOLID_RESOLVED - 1)).toBe("caution");
    expect(redTeamSampleTier(RED_TEAM_EFFICACY_SOLID_RESOLVED)).toBe("ready");
  });

  it("renders attribution and return tone without fabricating missing models", () => {
    expect(redTeamAttributionLabel(undefined)).toBe(RED_TEAM_UNATTRIBUTED_MODEL);
    expect(redTeamAttributionLabel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
    expect(redTeamReturnTone(-1)).toBe("pos");
    expect(redTeamReturnTone(1)).toBe("neg");
    expect(redTeamReturnTone(0)).toBe("muted");
    expect(redTeamSampleGate(5)).toContain("needs >=");
  });
});
