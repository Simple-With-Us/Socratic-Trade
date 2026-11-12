import { expect, test } from "@playwright/test";

/**
 * `.dark` and `data-theme` stay paired for light, dark, and system.
 * The welcome page is public and runs themeInitScript before paint.
 * Screenshot baselines live in visual.spec.ts; this check is DOM-only.
 */

test.describe("theme signals stay paired", () => {
  test("light, dark, and system resolve to one pair", async ({ page }) => {
    async function expectResolved(resolved: "light" | "dark") {
      const state = await page.evaluate(() => ({
        darkClass: document.documentElement.classList.contains("dark"),
        dataTheme: document.documentElement.dataset.theme ?? null,
        consoleThemes: [...document.querySelectorAll(".console-root")].map((node) => node.getAttribute("data-theme"))
      }));
      expect(state.darkClass, "html .dark class").toBe(resolved === "dark");
      expect(state.dataTheme, "html data-theme").toBe(resolved);
      for (const value of state.consoleThemes) {
        expect(value, "console-root data-theme").toBe(resolved);
      }
    }

    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.setItem("theme", "light"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectResolved("light");

    await page.evaluate(() => localStorage.setItem("theme", "dark"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectResolved("dark");

    await page.evaluate(() => localStorage.setItem("theme", "system"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectResolved("dark");

    await page.emulateMedia({ colorScheme: "light" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectResolved("light");
  });
});
