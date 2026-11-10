import { describe, expect, it } from "vitest";
import {
  canArmProtectiveTrail,
  clampHaltedReplacementStop,
  fixedProtectiveStopPrice,
  impliedTrailExtreme,
  positionMarkPrice,
  protectiveExitSide,
  protectiveSideOf,
  trailRatchetTighter,
  trailingTriggerFromExtreme
} from "../src/lib/protective-stop-math";

describe("protective-stop-math", () => {
  it("treats negative quantity as a short and covers with buy-to-cover", () => {
    expect(protectiveSideOf({ quantity: -10 })).toBe("short");
    expect(protectiveExitSide("short")).toBe("cover");
    expect(protectiveExitSide("long")).toBe("sell");
  });

  it("resolves mark from signed Alpaca short rows", () => {
    expect(positionMarkPrice({ quantity: -10, marketValue: -1250 })).toBe(125);
    expect(positionMarkPrice({ quantity: 10, marketValue: 1250 })).toBe(125);
  });

  it("prices a short buy-stop above entry and a long sell-stop below", () => {
    expect(fixedProtectiveStopPrice(100, 8, "short")).toBe(108);
    expect(fixedProtectiveStopPrice(100, 8, "long")).toBe(92);
  });

  it("inverts trail extremes on both sides", () => {
    expect(impliedTrailExtreme(92, 8, "long")).toBeCloseTo(100, 5);
    expect(impliedTrailExtreme(108, 8, "short")).toBeCloseTo(100, 5);
  });

  it("ratchets a short trail downward only", () => {
    expect(trailRatchetTighter(110, 108, "short")).toBe(true);
    expect(trailRatchetTighter(108, 110, "short")).toBe(false);
    expect(trailRatchetTighter(90, 92, "long")).toBe(true);
    expect(trailRatchetTighter(92, 90, "long")).toBe(false);
  });

  it("arms a short native trail only when mark is at/below the low-water mark", () => {
    expect(canArmProtectiveTrail({
      mark: 95, avgCost: 100, trackedExtreme: 94, stopPrice: 101.52, nativeTrailing: true, side: "short"
    })).toBe(false);
    expect(canArmProtectiveTrail({
      mark: 94, avgCost: 100, trackedExtreme: 94, stopPrice: 101.52, nativeTrailing: true, side: "short"
    })).toBe(true);
    expect(canArmProtectiveTrail({
      mark: 106, avgCost: 100, trackedExtreme: 100, stopPrice: 108, nativeTrailing: false, side: "short"
    })).toBe(true);
    expect(canArmProtectiveTrail({
      mark: 109, avgCost: 100, trackedExtreme: 100, stopPrice: 108, nativeTrailing: false, side: "short"
    })).toBe(false);
  });

  it("computes a short trail trigger above the low-water mark", () => {
    expect(trailingTriggerFromExtreme(95, 100, 90, 8, "short")).toBe(97.2);
  });

  it("clamps a halted short replacement so it cannot loosen", () => {
    expect(clampHaltedReplacementStop(110, 108, "short")).toBe(108);
    expect(clampHaltedReplacementStop(106, 108, "short")).toBe(106);
    expect(clampHaltedReplacementStop(90, 92, "long")).toBe(92);
    expect(clampHaltedReplacementStop(94, 92, "long")).toBe(94);
  });
});
