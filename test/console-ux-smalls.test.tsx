import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fmtExact } from "../app/console/lib/format";
import { Ago, Tooltip } from "../app/console/ui/primitives";
import { createToastCountdown } from "../app/console/ui/toast";

/** ST-4659 web UX smalls: Ago must not flood the tab order, timed toasts must
 *  pause while held (WCAG 2.2.1), and destructive confirms use the themed
 *  Sheet instead of window.confirm. */

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("Ago tab stops (ST-4659)", () => {
  const iso = "2026-11-22T15:04:05.000Z";

  it("renders the exact time as the <time> aria-label with no tab stop", () => {
    const html = renderToStaticMarkup(<Ago iso={iso} />);
    expect(html).toContain(`dateTime="${iso}"`);
    expect(html).toContain(`aria-label="${fmtExact(iso)}"`);
    expect(html).not.toMatch(/tabIndex="0"|tabindex="0"/i);
  });

  it("keeps genuinely explanatory tooltips keyboard-focusable by default", () => {
    const html = renderToStaticMarkup(
      <Tooltip content="Why this is held"><span>Held</span></Tooltip>
    );
    expect(html).toMatch(/tabIndex="0"|tabindex="0"/i);
  });
});

describe("toast auto-dismiss countdown (ST-4659)", () => {
  afterEach(() => vi.useRealTimers());

  it("fires once after the full unpaused duration", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    createToastCountdown(6000, onExpire);
    vi.advanceTimersByTime(5999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("pauses while held and resumes with only the remaining time", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const countdown = createToastCountdown(6000, onExpire);
    vi.advanceTimersByTime(2000);
    countdown.pause();
    countdown.pause(); // idempotent
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    countdown.resume();
    countdown.resume(); // idempotent
    vi.advanceTimersByTime(3999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents firing", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const countdown = createToastCountdown(6000, onExpire);
    countdown.cancel();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("wires pointer/focus pause and keeps error toasts untimed", () => {
    const toast = read("app/console/ui/toast.tsx");
    expect(toast).toContain('onPointerEnter={() => pauseFor(t.id, "pointer")}');
    expect(toast).toContain('onPointerLeave={() => resumeFor(t.id, "pointer")}');
    expect(toast).toContain('onFocus={() => pauseFor(t.id, "focus")}');
    expect(toast).toContain('if (kind !== "neg")');
  });
});

describe("Sheet confirms replace window.confirm (ST-4659)", () => {
  it("settings sign-out-everywhere confirms in a Sheet with the same copy intent", () => {
    const page = read("app/console/settings/page.tsx");
    expect(page).not.toContain("window.confirm");
    expect(page).toContain('title="Sign out everywhere?"');
    expect(page).toContain("This ends every active session, including the iOS app.");
    expect(page).toContain('fetch("/api/auth/sessions/revoke-all"');
  });

  it("strategy preset delete confirms in a Sheet with the same copy intent", () => {
    const page = read("app/console/strategy/page.tsx");
    expect(page).not.toContain("window.confirm");
    expect(page).toContain("Delete preset");
    expect(page).toContain("This cannot be undone.");
    expect(page).toContain("onClick={() => setConfirmDelete(profile)}");
  });
});
