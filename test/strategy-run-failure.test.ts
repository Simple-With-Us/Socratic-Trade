import { describe, expect, it } from "vitest";
import {
  humanizeFailureText,
  notificationFailureDetail,
  plainEnglishRunFailure
} from "../src/lib/strategy-run-failure";

describe("plain-English strategy-run failure copy", () => {
  it("maps known gather / budget / broker reasons and never dumps JSON", () => {
    expect(humanizeFailureText("strategy gather timeout")).toMatch(/gathering market data took too long/);
    expect(humanizeFailureText("credits exhausted")).toMatch(/out of credits/);
    expect(humanizeFailureText("usage budget exceeded")).toMatch(/budget was exhausted/);
    expect(humanizeFailureText("market is closed")).toMatch(/market was closed/);
    expect(humanizeFailureText("broker unhealthy")).toMatch(/broker connection was unhealthy/);
    expect(humanizeFailureText('{"error":"boom"}')).toBeNull();
    expect(humanizeFailureText("")).toBeNull();
  });

  it("uses the payload summary for a failed run and a generic line when nothing is stored", () => {
    expect(
      plainEnglishRunFailure({ status: "failed", summary: "strategy gather timeout" })
    ).toMatch(/gathering market data took too long/);
    expect(plainEnglishRunFailure({ status: "failed" })).toMatch(/Open Run Details/);
    expect(plainEnglishRunFailure({ status: "completed", summary: "ok" })).toBe("ok");
  });

  it("prefers the event reason over the delivery chip, and leaves empty payloads to delivery copy", () => {
    expect(
      notificationFailureDetail({
        type: "run_failed",
        title: "Strategy Run Failed",
        payload: { summary: "strategy gather timeout" }
      })
    ).toMatch(/gathering market data took too long/);
    expect(
      notificationFailureDetail({
        type: "run_failed",
        title: "Strategy Run Failed",
        payload: {}
      })
    ).toBeNull();
  });
});
