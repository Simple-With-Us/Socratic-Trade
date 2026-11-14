import { expect, test } from "@playwright/test";

/**
 * `.dark` and `data-theme` stay paired for light, dark, and system.
 * The welcome page is public and runs themeInitScript before paint.
 * Screenshot baselines live in visual.spec.ts; this check is DOM-only.
 */

test.describe("theme signals stay paired", () => {
  test("light, dark, and system resolve to one pair", async ({ page }) => {
    // Web-first assertions retry until the boot script / provider settles.
    // /welcome is public and has no .console-root, so console-root pairing is
    // covered by the console test below.
    async function expectResolved(resolved: "light" | "dark") {
      const html = page.locator("html");
      await expect(html, "html data-theme").toHaveAttribute("data-theme", resolved);
      if (resolved === "dark") {
        await expect(html, "html .dark class").toHaveClass(/(^|\s)dark(\s|$)/);
      } else {
        await expect(html, "html .dark class").not.toHaveClass(/(^|\s)dark(\s|$)/);
      }
      await expect(page.locator('meta[name="theme-color"]').first(), "public theme-color").toHaveAttribute(
        "content",
        resolved === "dark" ? "#0a0a0a" : "#ffffff"
      );
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

  test("console roots follow the resolved theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.setItem("theme", "dark"));
    await page.goto("/console", { waitUntil: "domcontentloaded" });

    const roots = page.locator(".console-root");
    // Control: the console must actually render a root, or the check below is vacuous.
    await expect.poll(() => roots.count(), { message: "console-root count" }).toBeGreaterThan(0);
    await expect
      .poll(() => roots.evaluateAll((nodes) => nodes.every((node) => node.getAttribute("data-theme") === "dark")))
      .toBe(true);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute("content", "#0a0a0a");
  });
});
