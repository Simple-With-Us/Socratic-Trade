import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
const SCAN_TABLE = read("app/console/scan/scan-table.tsx");
const CHROME = read("app/console/components/chrome.tsx");
const WATCHLIST = read("app/console/watchlist/page.tsx");
const APP_ERROR = read("app/error.tsx");
const GLOBAL_ERROR = read("app/global-error.tsx");
function slice(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`could not slice ${startMarker} .. ${endMarker}`);
  return src.slice(start, end);
}
describe("ScanCard WatchButton keyboard isolation (ST-4650 A2.1)", () => {
  it("stops keydown propagation so Enter/Space on the star does not open the drawer", () => {
    const watchButton = slice(SCAN_TABLE, "function WatchButton", "function ScanCard");
    expect(watchButton).toMatch(/onKeyDown=\{[\s\S]*?stopPropagation\(\)/);
    const card = slice(SCAN_TABLE, "function ScanCard", "function ScanColumnsMenu");
    expect(card).toContain('event.key === "Enter"');
  });
});
describe("ScopeSelector environment chip on every row (ST-4650 A2.2)", () => {
  it("renders PAPER and LIVE chips instead of omitting the chip for live accounts", () => {
    const row = slice(CHROME, "const renderRow", "relative wrapper");
    expect(row).not.toContain('r.tone !== "live" &&');
    expect(row).toContain('"PAPER"');
    expect(row).toContain('"LIVE"');
    expect(row).toMatch(/<Chip tone=\{r\.tone\}>/);
  });
});
describe("StateChip accessible name at dot-only widths (ST-4650 A2.3)", () => {
  it("carries an aria-label with the state wording and keeps the title", () => {
    const chip = slice(CHROME, "export function StateChip", "export function RunStateButton");
    expect(chip).toMatch(/aria-label=\{[^}]*info\.label[^}]*\}/);
    expect(chip).toContain("title={info.cause");
  });
});
describe("Watchlist first-load failure (ST-4650 A2.4)", () => {
  it("shows the error with a Retry wired to refresh() instead of endless Loading", () => {
    expect(WATCHLIST).toMatch(/loadError\s*!==\s*null\s*&&\s*data\s*===\s*null\s*&&\s*alerts\s*===\s*null/);
    expect(WATCHLIST).toContain("Retry");
    expect(WATCHLIST).toMatch(/onClick=\{\(\) => void refresh\(\)\}/);
    expect(WATCHLIST).toContain("refresh failing");
    expect(WATCHLIST).toContain("!firstLoadFailed");
  });
});
describe("Icon-only watchlist actions have accessible names (ST-4650 A2.5)", () => {
  it("names the remove-symbol and delete-alert trash buttons", () => {
    const rowActions = WATCHLIST.slice(WATCHLIST.indexOf("function WatchlistRowActions"));
    expect(rowActions).toMatch(/aria-label=\{`[^`]*\$\{symbol\}[^`]*`\}/);
    expect(WATCHLIST).toMatch(/aria-label=\{`Delete alert for \$\{alert\.symbol\}/);
  });
});
describe("Root error screens (ST-4650 A2.6)", () => {
  it("app/error uses fixed copy, keeps the digest, and links back to the console", () => {
    expect(APP_ERROR).not.toContain("error.message");
    expect(APP_ERROR).toContain("error.digest");
    expect(APP_ERROR).toContain("Back to console");
    expect(APP_ERROR).toContain('href="/console"');
    expect(APP_ERROR).toContain("Try again");
  });
  it("app/global-error uses fixed copy, keeps the digest, and links back to the console", () => {
    expect(GLOBAL_ERROR).not.toContain("error.message");
    expect(GLOBAL_ERROR).toContain("error.digest");
    expect(GLOBAL_ERROR).toContain("Back to console");
    expect(GLOBAL_ERROR).toContain('href="/console"');
    expect(GLOBAL_ERROR).toContain("Try again");
  });
});
