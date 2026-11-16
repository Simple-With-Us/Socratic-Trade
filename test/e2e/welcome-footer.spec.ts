import { expect, test } from "@playwright/test";

/**
 * Regression coverage for the Simple With Us attribution in the welcome-page
 * footer.
 *
 * The footer carries two wordmark images, one per theme branch. Which one is
 * visible is a DOM question, not a pixel question, so these are visibility
 * assertions rather than screenshot comparisons — which also means they need
 * no committed baseline and stay stable across environments.
 *
 * The behaviour being pinned: the first pass at this change used a
 * `prefers-color-scheme` media query, which is the wrong signal here.
 * themeInitScript in app/ui/theme.tsx resolves the theme itself from
 * localStorage and toggles `.dark` on <html>, and the default is `light` —
 * only an explicit dark choice, or `system`, goes dark at all. So a visitor
 * who explicitly chose Light while their OS was dark was getting the dark
 * wordmark on a light footer.
 */

test.describe("welcome footer wordmark", () => {
  test("follows the resolved theme, not the OS", async ({ page }) => {
    // A dark OS with the app left at its default light preference must still
    // show the light wordmark. This is the regression in one assertion.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });

    const light = page.locator('img[src*="swu-wordmark-light"]');
    const dark = page.locator('img[src*="swu-wordmark-dark"]');

    await expect(light, "dark OS must not override the default light app theme").toBeVisible();
    await expect(dark).toBeHidden();

    // Now resolve the theme the way the toggle does.
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(dark, "the .dark class must reveal the dark wordmark").toBeVisible();
    await expect(light).toBeHidden();
  });

  test("ships both variants at the declared intrinsic size", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    // Both files must be reachable at the declared size, or the footer shifts
    // when the theme flips.
    for (const variant of ["light", "dark"]) {
      const response = await page.request.get(`/swu-wordmark-${variant}.webp`);
      expect(response.status(), `swu-wordmark-${variant}.webp must be served`).toBe(200);
    }
    await expect(page.locator('img[src*="swu-wordmark-light"]')).toHaveAttribute("width", "288");
    await expect(page.locator('img[src*="swu-wordmark-light"]')).toHaveAttribute("height", "30");
  });
});
