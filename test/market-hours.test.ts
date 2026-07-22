import { describe, expect, it } from "vitest";
import {
  currentMarketSession,
  isRunAllowedNow,
  isTradingDay,
  nextMarketOpenHint,
  nextTradingDayStart,
  previousTradingDayStart
} from "../src/lib/market-hours";

// Helper: build a UTC Date that lands at a specific ET wall-clock time.
// EDT (summer, UTC-4): utcHour = etHour + 4
// EST (winter, UTC-5): utcHour = etHour + 5
// These tests use dates in June (EDT, UTC-4) unless noted.

function etDate(isoDate: string, etHour: number, etMinute = 0): Date {
  // June is always EDT (UTC-4)
  const utcHour = etHour + 4;
  const paddedDate = isoDate; // "YYYY-MM-DD"
  // Build ISO UTC string; if utcHour >= 24 we'd need to bump the day, but test cases avoid that
  return new Date(`${paddedDate}T${String(utcHour).padStart(2, "0")}:${String(etMinute).padStart(2, "0")}:00Z`);
}

describe("currentMarketSession", () => {
  it("Wednesday 10:00 ET → regular", () => {
    // 2026-06-10 is a Wednesday
    const d = etDate("2026-06-10", 10, 0);
    expect(currentMarketSession(d)).toBe("regular");
  });

  it("Wednesday 08:00 ET → pre", () => {
    const d = etDate("2026-06-10", 8, 0);
    expect(currentMarketSession(d)).toBe("pre");
  });

  it("Wednesday 18:00 ET → post", () => {
    const d = etDate("2026-06-10", 18, 0);
    expect(currentMarketSession(d)).toBe("post");
  });

  it("Wednesday 09:30 ET (exactly open) → regular", () => {
    const d = etDate("2026-06-10", 9, 30);
    expect(currentMarketSession(d)).toBe("regular");
  });

  it("Wednesday 16:00 ET (exactly close) → post", () => {
    const d = etDate("2026-06-10", 16, 0);
    expect(currentMarketSession(d)).toBe("post");
  });

  it("Wednesday 20:00 ET (post-market close) → closed", () => {
    const d = etDate("2026-06-10", 20, 0);
    expect(currentMarketSession(d)).toBe("closed");
  });

  it("Wednesday 03:00 ET (before pre-market) → closed", () => {
    const d = etDate("2026-06-10", 3, 0);
    expect(currentMarketSession(d)).toBe("closed");
  });

  it("Saturday → closed", () => {
    // 2026-06-13 is a Saturday
    const d = etDate("2026-06-13", 10, 0);
    expect(currentMarketSession(d)).toBe("closed");
  });

  it("Sunday → closed", () => {
    // 2026-06-14 is a Sunday
    const d = etDate("2026-06-14", 10, 0);
    expect(currentMarketSession(d)).toBe("closed");
  });

  it("Thanksgiving 2026 (Thursday) → closed", () => {
    // Nov is EST (UTC-5): 10:00 ET = 15:00 UTC
    const d = new Date("2026-11-26T15:00:00Z");
    expect(currentMarketSession(d)).toBe("closed");
  });

  it("Christmas 2026 (Friday) → closed", () => {
    // Dec is EST (UTC-5): 10:00 ET = 15:00 UTC
    const d = new Date("2026-12-25T15:00:00Z");
    expect(currentMarketSession(d)).toBe("closed");
  });
});

describe("isRunAllowedNow", () => {
  it("regular session → true regardless of extended-hours flag", () => {
    const d = etDate("2026-06-10", 10, 0);
    expect(isRunAllowedNow(false, d)).toBe(true);
    expect(isRunAllowedNow(true, d)).toBe(true);
  });

  it("pre-market, extended=false → false", () => {
    const d = etDate("2026-06-10", 8, 0);
    expect(isRunAllowedNow(false, d)).toBe(false);
  });

  it("pre-market, extended=true → true", () => {
    const d = etDate("2026-06-10", 8, 0);
    expect(isRunAllowedNow(true, d)).toBe(true);
  });

  it("post-market, extended=false → false", () => {
    const d = etDate("2026-06-10", 18, 0);
    expect(isRunAllowedNow(false, d)).toBe(false);
  });

  it("post-market, extended=true → true", () => {
    const d = etDate("2026-06-10", 18, 0);
    expect(isRunAllowedNow(true, d)).toBe(true);
  });

  it("closed (Saturday) → false regardless of extended-hours", () => {
    const d = etDate("2026-06-13", 12, 0);
    expect(isRunAllowedNow(false, d)).toBe(false);
    expect(isRunAllowedNow(true, d)).toBe(false);
  });
});

// Trading-day calendar helpers (item 23 stale-baseline detection + item 29 run-state display).
// These compare by LOCAL calendar day (not ET wall-clock — see the doc comment in
// src/lib/market-hours.ts), so tests anchor at UTC noon: that instant falls on the same calendar
// date in every timezone a real CI runner or dev machine actually uses.
describe("isTradingDay", () => {
  it("a plain weekday is a trading day", () => {
    expect(isTradingDay(new Date("2026-06-10T12:00:00Z"))).toBe(true); // Wednesday
  });

  it("weekends are not trading days", () => {
    expect(isTradingDay(new Date("2026-06-13T12:00:00Z"))).toBe(false); // Saturday
    expect(isTradingDay(new Date("2026-06-14T12:00:00Z"))).toBe(false); // Sunday
  });

  it("a market holiday landing on a weekday is not a trading day", () => {
    expect(isTradingDay(new Date("2026-12-25T12:00:00Z"))).toBe(false); // Christmas, a Friday in 2026
  });
});

describe("previousTradingDayStart (item 23: detect a stale day-P&L baseline)", () => {
  it("steps back exactly one day across a normal weekday gap", () => {
    const prev = previousTradingDayStart(new Date("2026-06-11T12:00:00Z")); // Thursday
    expect([prev.getFullYear(), prev.getMonth(), prev.getDate()]).toEqual([2026, 5, 10]); // Wed Jun 10
  });

  it("skips back over a weekend to the prior Friday", () => {
    const prev = previousTradingDayStart(new Date("2026-06-15T12:00:00Z")); // Monday
    expect([prev.getMonth(), prev.getDate()]).toEqual([5, 12]); // Fri Jun 12
  });

  it("skips a weekday holiday plus the surrounding weekend", () => {
    const prev = previousTradingDayStart(new Date("2026-12-28T12:00:00Z")); // Monday after Christmas
    expect([prev.getMonth(), prev.getDate()]).toEqual([11, 24]); // Thu Dec 24 (skips Fri Dec 25 holiday + weekend)
  });
});

describe("nextTradingDayStart", () => {
  it("steps forward exactly one day across a normal weekday gap", () => {
    const next = nextTradingDayStart(new Date("2026-06-10T12:00:00Z")); // Wednesday
    expect([next.getMonth(), next.getDate()]).toEqual([5, 11]); // Thu Jun 11
  });

  it("skips forward over a weekend to the following Monday", () => {
    const next = nextTradingDayStart(new Date("2026-06-12T12:00:00Z")); // Friday
    expect([next.getMonth(), next.getDate()]).toEqual([5, 15]); // Mon Jun 15
  });
});

describe("nextMarketOpenHint (item 29: cheap next-open hint for the paused/market-closed display)", () => {
  it("says 'today' when the pre-market window is already underway", () => {
    expect(nextMarketOpenHint(etDate("2026-06-10", 8, 0), false)).toBe("today, 9:30 AM ET");
  });

  it("reflects the extended-hours open clock when the policy allows it", () => {
    expect(nextMarketOpenHint(etDate("2026-06-10", 8, 0), true)).toBe("today, 4:00 AM ET (extended hours)");
  });

  it("names the next trading day once today's session has already ended", () => {
    // 18:00 ET Wed is post-market; the next open (non-extended) is Thursday's regular session.
    expect(nextMarketOpenHint(etDate("2026-06-10", 18, 0), false)).toBe("Thu, Jun 11, 9:30 AM ET");
  });

  it("skips the weekend for a Friday-evening check", () => {
    expect(nextMarketOpenHint(etDate("2026-06-12", 18, 0), false)).toBe("Mon, Jun 15, 9:30 AM ET");
  });
});
