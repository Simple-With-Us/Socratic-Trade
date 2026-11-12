import { describe, expect, it } from "vitest";
import { isMarketOpen, regularSessionCloseUtcMs } from "../src/lib/market-calendar";
import {
  decideDeployFreshnessStaleness,
  decideDeployFreshnessStalenessFromEnv,
  rthDrainUtcMs
} from "../src/lib/deploy-freshness-staleness";

function etDateEdt(isoDate: string, etHour: number, etMinute = 0): Date {
  const utcHour = etHour + 4;
  return new Date(
    `${isoDate}T${String(utcHour).padStart(2, "0")}:${String(etMinute).padStart(2, "0")}:00Z`
  );
}

describe("regularSessionCloseUtcMs", () => {
  it("uses 13:00 ET on NYSE early-close days", () => {
    const blackFriday = new Date("2026-11-27T19:00:00Z");
    expect(isMarketOpen(blackFriday)).toBe(false);
    const fri = new Date("2026-11-27T16:30:00Z");
    expect(isMarketOpen(fri)).toBe(true);
    const closeMs = regularSessionCloseUtcMs(fri);
    expect(closeMs).not.toBeNull();
    const closeDate = new Date(closeMs!);
    expect(closeDate.toISOString()).toBe("2026-11-27T18:00:00.000Z");
  });

  it("returns null on full-close holidays", () => {
    expect(regularSessionCloseUtcMs(new Date("2026-11-26T15:00:00Z"))).toBeNull();
  });
});

describe("decideDeployFreshnessStaleness", () => {
  it("treats weekday RTH merges as in-flight until session close", () => {
    const commitAt = etDateEdt("2026-06-10", 10, 0);
    const now = etDateEdt("2026-06-10", 11, 30);
    const decision = decideDeployFreshnessStaleness({
      now,
      oldestCommitEpochSec: Math.floor(commitAt.getTime() / 1000),
      staleSeconds: 3600
    });
    expect(decision.verdict).toBe("in-flight");
    expect(decision.latchReason).toBe("rth-blocked");
    expect(decision.effectiveAgeSeconds).toBe(0);
    expect(decision.rawCommitAgeSeconds).toBeGreaterThan(3600);
  });

  it("ages from the after-close drain once the latch lifts (Nov 11 false-positive class)", () => {
    const commitAt = new Date("2026-11-11T16:55:32Z");
    const now = new Date("2026-11-11T21:36:20Z");
    expect(isMarketOpen(commitAt)).toBe(true);
    expect(isMarketOpen(now)).toBe(false);
    const decision = decideDeployFreshnessStaleness({
      now,
      oldestCommitEpochSec: Math.floor(commitAt.getTime() / 1000),
      staleSeconds: 3600
    });
    expect(decision.verdict).toBe("in-flight");
    expect(decision.effectiveAgeSeconds).toBeLessThan(3600);
    // EST close is 21:00 UTC; the 21:20 UTC drain is later, so it anchors the grace.
    expect(decision.deployDueAnchorMs).toBe(rthDrainUtcMs(commitAt));
  });

  it("stays in flight between an EDT close and the 21:20 UTC drain", () => {
    const commitAt = etDateEdt("2026-06-10", 10, 0);
    const closeMs = regularSessionCloseUtcMs(commitAt)!;
    // 21:13 UTC: one hour after the 20:00 UTC EDT close, before the drain.
    const now = new Date(closeMs + 3600 * 1000 + 13 * 60 * 1000);
    const decision = decideDeployFreshnessStaleness({
      now,
      oldestCommitEpochSec: Math.floor(commitAt.getTime() / 1000),
      staleSeconds: 3600
    });
    expect(decision.verdict).toBe("in-flight");
    expect(decision.deployDueAnchorMs).toBe(rthDrainUtcMs(commitAt));
  });

  it("alerts when still undeployed after grace from the drain", () => {
    const commitAt = etDateEdt("2026-06-10", 10, 0);
    const now = new Date(rthDrainUtcMs(commitAt) + 4000 * 1000);
    const decision = decideDeployFreshnessStaleness({
      now,
      oldestCommitEpochSec: Math.floor(commitAt.getTime() / 1000),
      staleSeconds: 3600
    });
    expect(decision.verdict).toBe("stale");
    expect(decision.effectiveAgeSeconds).toBeGreaterThanOrEqual(3600);
  });

  it("ages off-hours merges from commit time", () => {
    const commitAt = etDateEdt("2026-06-10", 17, 0);
    const now = new Date(commitAt.getTime() + 5000 * 1000);
    const decision = decideDeployFreshnessStaleness({
      now,
      oldestCommitEpochSec: Math.floor(commitAt.getTime() / 1000),
      staleSeconds: 3600
    });
    expect(decision.latchReason).toBe("non-rth");
    expect(decision.verdict).toBe("stale");
    expect(decision.effectiveAgeSeconds).toBeGreaterThanOrEqual(3600);
  });

  it("does not latch HOTFIX=1 commits", () => {
    const commitAt = etDateEdt("2026-06-10", 10, 0);
    const now = new Date(commitAt.getTime() + 5000 * 1000);
    const decision = decideDeployFreshnessStaleness({
      now,
      oldestCommitEpochSec: Math.floor(commitAt.getTime() / 1000),
      oldestCommitMessage: "HOTFIX=1 prod broker patch",
      staleSeconds: 3600
    });
    expect(decision.verdict).toBe("stale");
    expect(decision.deployDueAnchorMs).toBe(commitAt.getTime());
  });

  it("does not latch when only the expected tip carries HOTFIX=1", () => {
    const commitAt = etDateEdt("2026-06-10", 10, 0);
    const now = new Date(commitAt.getTime() + 5000 * 1000);
    const decision = decideDeployFreshnessStaleness({
      now,
      oldestCommitEpochSec: Math.floor(commitAt.getTime() / 1000),
      oldestCommitMessage: "ordinary change",
      tipCommitMessage: "HOTFIX=1 prod broker patch",
      staleSeconds: 3600
    });
    expect(decision.verdict).toBe("stale");
    expect(decision.deployDueAnchorMs).toBe(commitAt.getTime());
  });

  it("ignores an empty RTH_DEPLOY_LATCH_NOW and keeps the DEPLOY_FRESHNESS_LATCH_NOW pin", () => {
    const commitAt = etDateEdt("2026-06-10", 17, 0);
    const decision = decideDeployFreshnessStalenessFromEnv({
      DEPLOY_FRESHNESS_OLDEST_EPOCH: String(Math.floor(commitAt.getTime() / 1000)),
      DEPLOY_FRESHNESS_STALE_SECONDS: "3600",
      RTH_DEPLOY_LATCH_NOW: "",
      DEPLOY_FRESHNESS_LATCH_NOW: new Date(commitAt.getTime() + 1800 * 1000).toISOString()
    });
    expect(decision.rawCommitAgeSeconds).toBe(1800);
    expect(decision.verdict).toBe("in-flight");
  });
});
