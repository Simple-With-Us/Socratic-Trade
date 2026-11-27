import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fmtExact } from "../app/console/lib/format";
import { Ago, Tooltip } from "../app/console/ui/primitives";

/** ST-4659 web UX smalls + the W23 sonner consolidation: Ago must not flood
 *  the tab order, console toasts are sonner-only, and destructive confirms use
 *  the themed Sheet instead of window.confirm. */

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("Ago tab stops (ST-4659)", () => {
  const iso = "2026-11-22T15:04:05.000Z";

  it("renders the exact time as visually-hidden text with no tab stop", () => {
    const html = renderToStaticMarkup(<Ago iso={iso} />);
    expect(html).toContain(`dateTime="${iso}"`);
    expect(html).not.toContain("aria-label=");
    expect(html).toContain('<span aria-hidden="true">');
    expect(html).toContain(`<span class="sr-only">${fmtExact(iso)}</span>`);
    expect(html).not.toMatch(/tabIndex="0"|tabindex="0"/i);
  });

  it("keeps genuinely explanatory tooltips keyboard-focusable by default", () => {
    const html = renderToStaticMarkup(
      <Tooltip content="Why this is held"><span>Held</span></Tooltip>
    );
    expect(html).toMatch(/tabIndex="0"|tabindex="0"/i);
  });
});

describe("console toasts are sonner-only (W23 / OD-11)", () => {
  it("maps the console's honest kind semantics onto sonner", () => {
    const adapter = read("app/console/lib/sonner-toast.ts");
    expect(adapter).toContain('from "sonner"');
    // neg errors persist until dismissed (the retired stack's untimed rule).
    expect(adapter).toContain("toast.error(title, { ...opts, duration: Infinity, closeButton: true })");
    expect(adapter).toContain("toast.success(title, opts)");
    expect(adapter).toContain("toast.warning(title, opts)");
    expect(adapter).toContain("toast.info(title, opts)");
  });

  it("retired the custom provider stack from the shell", () => {
    const shell = read("app/console/components/shell.tsx");
    expect(shell).not.toContain("<ToastProvider");
    expect(shell).not.toContain('from "../ui/toast"');
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
