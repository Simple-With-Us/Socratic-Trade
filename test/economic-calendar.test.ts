/**
 * Handoff 3.5 — forward economic-event awareness (src/lib/economic-calendar.ts).
 *
 * Covers: fixture-payload ingest (high-impact US filtering + row normalization), the
 * once-per-UTC-day persisted watermark (no double-fetch), fail-open ingest failure
 * (no throw, watermark NOT consumed), and the prompt read path returning [] when the
 * cache is empty (so the prompt block is omitted entirely).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EconomicCalendar } from "../src/lib/economic-calendar";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-econ-calendar-${randomUUID()}.db`)}`;
});

// Fixed clock so fixture dates are deterministic relative to "today".
const NOW = new Date("2026-07-15T12:00:00.000Z");
const NEXT_DAY = new Date("2026-07-16T12:00:00.000Z");

function fixturePayload(): EconomicCalendar[] {
  return [
    { date: "2026-07-16 08:30:00", country: "US", event: "CPI (YoY)", currency: "USD", previous: 3.1, estimate: 3.0, actual: null, change: null, impact: "High" },
    { date: "2026-07-17 14:00:00", country: "US", event: "FOMC Interest Rate Decision", currency: "USD", previous: 5.25, estimate: 5.25, actual: null, change: null, impact: "High" },
    // Filtered out: low/medium impact, non-US, missing event name.
    { date: "2026-07-16 10:00:00", country: "US", event: "Wholesale Inventories", currency: "USD", previous: 0.2, estimate: 0.1, actual: null, change: null, impact: "Medium" },
    { date: "2026-07-16 09:00:00", country: "DE", event: "ZEW Sentiment", currency: "EUR", previous: 10, estimate: 12, actual: null, change: null, impact: "High" },
    { date: "2026-07-18 08:30:00", country: "US", event: "", currency: "USD", previous: null, estimate: null, actual: null, change: null, impact: "High" }
  ];
}

beforeEach(async () => {
  const { __resetEconomicCalendarStateForTests } = await import("../src/lib/economic-calendar");
  __resetEconomicCalendarStateForTests();
});

describe("economic-calendar ingest (handoff 3.5)", () => {
  it("ingests a fixture payload keeping only high-impact US events, readable in date order", async () => {
    const { refreshEconomicCalendarIfStale, getUpcomingEconomicEvents } = await import("../src/lib/economic-calendar");
    const fetcher = vi.fn(async () => fixturePayload());

    const refreshed = await refreshEconomicCalendarIfStale(NOW, "local", fetcher);
    expect(refreshed).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Fetch window: today .. today + 5 calendar days.
    expect(fetcher).toHaveBeenCalledWith("2026-07-15", "2026-07-20");

    const events = getUpcomingEconomicEvents(NOW);
    expect(events.map((event) => event.event)).toEqual(["CPI (YoY)", "FOMC Interest Rate Decision"]);
    expect(events[0]).toMatchObject({ date: "2026-07-16 08:30:00", impact: "High", estimate: 3.0, previous: 3.1 });
  });

  it("respects the daily watermark: a second refresh the same UTC day does not fetch again", async () => {
    const { refreshEconomicCalendarIfStale } = await import("../src/lib/economic-calendar");
    const fetcher = vi.fn(async () => fixturePayload());

    const refreshed = await refreshEconomicCalendarIfStale(NOW, "local", fetcher);
    expect(refreshed).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches again on a NEW UTC day and prunes past events", async () => {
    const { refreshEconomicCalendarIfStale, getUpcomingEconomicEvents } = await import("../src/lib/economic-calendar");
    const fetcher = vi.fn(async () => fixturePayload().slice(1, 2)); // FOMC only

    const refreshed = await refreshEconomicCalendarIfStale(NEXT_DAY, "local", fetcher);
    expect(refreshed).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const events = getUpcomingEconomicEvents(NEXT_DAY);
    // Prune removes rows strictly before 2026-07-16, so the CPI row at "2026-07-16 08:30:00"
    // survives in the CACHE — but at 12:00Z it printed 3.5h ago (past the release grace window),
    // so the read must NOT present it as upcoming. Only FOMC remains.
    expect(events.map((event) => event.event)).toEqual(["FOMC Interest Rate Decision"]);
  });

  it("fail-open: a throwing fetcher returns false without throwing and does NOT consume the watermark", async () => {
    const { refreshEconomicCalendarIfStale, __resetEconomicCalendarStateForTests } = await import("../src/lib/economic-calendar");
    const later = new Date("2026-07-17T12:00:00.000Z");
    const failing = vi.fn(async () => {
      throw new Error("upstream unavailable");
    });

    await expect(refreshEconomicCalendarIfStale(later, "local", failing)).resolves.toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);

    // The failure set only the in-process cool-off, not the persisted day watermark: after the
    // cool-off clears, the same day CAN retry (and succeed).
    __resetEconomicCalendarStateForTests();
    const working = vi.fn(async () => fixturePayload().slice(0, 1));
    await expect(refreshEconomicCalendarIfStale(later, "local", working)).resolves.toBe(true);
    expect(working).toHaveBeenCalledTimes(1);
  });

  it("prompt read path: returns [] when the cache has nothing in the horizon (block omitted)", async () => {
    const { getUpcomingEconomicEventsForPrompt } = await import("../src/lib/economic-calendar");
    // Far future: nothing ingested for this window, no fetcher => no fetch, empty read.
    const events = await getUpcomingEconomicEventsForPrompt("local", new Date("2027-01-04T12:00:00.000Z"));
    expect(events).toEqual([]);
  });
});

// A same-day event that already happened (the 08:30 CPI print seen at 15:00) must never be
// injected as an "upcoming" catalyst: timestamped rows past the grace window are excluded,
// just-released rows are kept but LABELED released, and date-only rows for today carry a
// "may have already printed" annotation because the stored data genuinely has no intraday time.
describe("same-day release honesty (getUpcomingEconomicEvents)", () => {
  // "Today" for these reads: 2026-08-10 (dates disjoint from the ingest fixtures above so the
  // watermark/prune churn of the earlier tests can't interfere).
  const CPI_MS = Date.parse("2026-08-10T08:30:00.000Z");

  beforeEach(async () => {
    const { upsertEconomicEvents } = await import("../src/lib/db");
    upsertEconomicEvents([
      { id: "2026-08-10 08:30:00|cpi (yoy)", event: "CPI (YoY)", eventDate: "2026-08-10 08:30:00", country: "US", impact: "High", estimate: 3.0, previous: 3.1 },
      { id: "2026-08-10 14:00:00|retail sales", event: "Retail Sales", eventDate: "2026-08-10 14:00:00", country: "US", impact: "High", estimate: null, previous: null },
      { id: "2026-08-10|nonfarm payrolls", event: "Nonfarm Payrolls", eventDate: "2026-08-10", country: "US", impact: "High", estimate: null, previous: null },
      { id: "2026-08-11 14:00:00|fomc interest rate decision", event: "FOMC Interest Rate Decision", eventDate: "2026-08-11 14:00:00", country: "US", impact: "High", estimate: null, previous: null },
      { id: "2026-08-12|jobless claims", event: "Jobless Claims", eventDate: "2026-08-12", country: "US", impact: "High", estimate: null, previous: null }
    ]);
  });

  it("at 15:00Z: the 08:30 print is EXCLUDED, the 14:00 print is labeled released, date-only today is annotated, future days stay clean", async () => {
    const { getUpcomingEconomicEvents } = await import("../src/lib/economic-calendar");
    const events = getUpcomingEconomicEvents(new Date("2026-08-10T15:00:00.000Z"));
    // CPI (08:30Z, printed 6.5h ago) is gone entirely — never "upcoming" all day.
    expect(events.map((event) => event.event)).toEqual([
      "Nonfarm Payrolls",
      "Retail Sales",
      "FOMC Interest Rate Decision",
      "Jobless Claims"
    ]);
    // Retail Sales (14:00Z, 1h ago) is inside the grace window: present but labeled released.
    const retail = events.find((event) => event.event === "Retail Sales");
    expect(retail?.timingNote).toContain("released earlier today");
    expect(retail?.timingNote).toContain("NOT an upcoming catalyst");
    // Date-only row for TODAY: honest ambiguity annotation.
    expect(events.find((event) => event.event === "Nonfarm Payrolls")?.timingNote).toContain("may have already printed");
    // Genuinely upcoming events (timestamped tomorrow, date-only later) carry no note.
    expect(events.find((event) => event.event === "FOMC Interest Rate Decision")?.timingNote).toBeUndefined();
    expect(events.find((event) => event.event === "Jobless Claims")?.timingNote).toBeUndefined();
  });

  it("grace-window boundary: kept+labeled just inside, dropped just past; not-yet-released same-day rows stay unlabeled", async () => {
    const { getUpcomingEconomicEvents, ECONOMIC_EVENT_RELEASED_GRACE_MS } = await import("../src/lib/economic-calendar");
    const inside = getUpcomingEconomicEvents(new Date(CPI_MS + ECONOMIC_EVENT_RELEASED_GRACE_MS - 60_000));
    expect(inside.find((event) => event.event === "CPI (YoY)")?.timingNote).toContain("released earlier today");
    // Retail Sales (14:00Z) has not printed yet at ~10:29Z — plainly upcoming, no note.
    expect(inside.find((event) => event.event === "Retail Sales")?.timingNote).toBeUndefined();

    const past = getUpcomingEconomicEvents(new Date(CPI_MS + ECONOMIC_EVENT_RELEASED_GRACE_MS + 60_000));
    expect(past.some((event) => event.event === "CPI (YoY)")).toBe(false);
  });
});
