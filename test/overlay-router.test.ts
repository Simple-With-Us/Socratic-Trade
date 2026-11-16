import { describe, expect, it } from "vitest";
import { selectActiveOverlays, type StrategyOverlay } from "../src/lib/overlay-router";

const overlay = (partial: Partial<StrategyOverlay> & Pick<StrategyOverlay, "id" | "name" | "instructions">): StrategyOverlay => ({
  marketRegimes: ["any"],
  priority: 100,
  enabled: true,
  ...partial
});

describe("selectActiveOverlays", () => {
  it("matches regime or any, sorts by priority, clamps max", () => {
    const selected = selectActiveOverlays({
      regime: "risk-on",
      maxCount: 2,
      overlays: [
        overlay({ id: "c", name: "Crisis", marketRegimes: ["crisis"], instructions: "crisis only", priority: 1 }),
        overlay({ id: "a", name: "Any late", instructions: "any", priority: 20 }),
        overlay({ id: "b", name: "Risk-on", marketRegimes: ["risk-on"], instructions: "go", priority: 5 }),
        overlay({ id: "off", name: "Off", instructions: "nope", enabled: false, priority: 0 })
      ]
    });
    expect(selected.map((row) => row.id)).toEqual(["b", "a"]);
  });

  it("returns empty when nothing matches", () => {
    expect(
      selectActiveOverlays({
        regime: "crisis",
        overlays: [overlay({ id: "x", name: "On", marketRegimes: ["risk-on"], instructions: "x" })]
      })
    ).toEqual([]);
  });

  it("is a no-op when maxCount is 0", () => {
    expect(
      selectActiveOverlays({
        regime: "any",
        maxCount: 0,
        overlays: [overlay({ id: "x", name: "On", instructions: "x" })]
      })
    ).toEqual([]);
  });

  it("matches persisted determineMarketRegime labels, not only enums", () => {
    const riskOn = overlay({
      id: "ro",
      name: "Trend",
      marketRegimes: ["risk-on"],
      instructions: "leaders",
      priority: 5
    });
    const chop = overlay({
      id: "n",
      name: "Chop",
      marketRegimes: ["neutral"],
      instructions: "fade",
      priority: 10
    });
    expect(
      selectActiveOverlays({
        regime: "Risk-On (Low Volatility)",
        overlays: [riskOn, chop]
      }).map((row) => row.id)
    ).toEqual(["ro"]);
    expect(
      selectActiveOverlays({
        regime: "Neutral (Normal Volatility)",
        overlays: [riskOn, chop]
      }).map((row) => row.id)
    ).toEqual(["n"]);
    expect(
      selectActiveOverlays({
        regime: "risk-on",
        overlays: [riskOn, chop]
      }).map((row) => row.id)
    ).toEqual(["ro"]);
  });
});
