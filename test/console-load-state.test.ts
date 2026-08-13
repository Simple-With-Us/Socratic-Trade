import { describe, expect, it } from "vitest";
import { deriveConsoleLoadState, type ConsoleLoadInput } from "../app/console/lib/console-load-state";

const base: ConsoleLoadInput = { hasSnapshot: false, error: null, fetching: false, slowElapsed: false };
const at = (over: Partial<ConsoleLoadInput>) => deriveConsoleLoadState({ ...base, ...over });

describe("deriveConsoleLoadState", () => {
  it("stays on the load screen while the very first attempt is still in flight", () => {
    expect(at({ fetching: true })).toBe("loading");
  });

  it("treats the pre-mount moment (nothing started yet) as loading, not failure", () => {
    expect(at({})).toBe("loading");
  });

  it("adds the slow notice without leaving the load screen", () => {
    expect(at({ fetching: true, slowElapsed: true })).toBe("slow");
  });

  // The production bug this whole module exists for. A slow-but-healthy first load sets `error`
  // twice over — the 15s first-load timer and the 35s per-attempt deadline, which aborts and
  // retries immediately — and the shell used to render "Couldn't load the autonomy desk" on the
  // strength of `error` alone. The server's own worst case is ~24s, so that fired on routine
  // loads, every time, while the request was still running and about to succeed.
  it("does NOT report failure when an error is set but a fetch is still running", () => {
    expect(at({ error: "The dashboard is taking too long to respond. Retrying…", fetching: true })).toBe("loading");
    expect(at({ error: "The dashboard is taking too long to respond. Retrying…", fetching: true, slowElapsed: true }))
      .toBe("slow");
  });

  it("reports failure only once nothing is in flight to rescue it", () => {
    expect(at({ error: "Could not refresh data.", fetching: false })).toBe("failed");
  });

  it("never reports failure without an error, even when idle", () => {
    expect(at({ error: null, fetching: false })).toBe("loading");
  });

  it("goes ready as soon as a snapshot exists, whatever the refresh state is", () => {
    // Once a snapshot is in hand, refresh errors belong to the freshness strip — they must never
    // take the rendered console away and replace it with a full-screen card.
    expect(at({ hasSnapshot: true })).toBe("ready");
    expect(at({ hasSnapshot: true, error: "Could not refresh data.", fetching: false })).toBe("ready");
    expect(at({ hasSnapshot: true, error: "Could not refresh data.", fetching: true, slowElapsed: true })).toBe("ready");
  });
});
