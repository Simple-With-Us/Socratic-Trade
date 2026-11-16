import { expect, test } from "@playwright/test";

// The framework route rejects the default HeadlessChrome UA, including in local tests.
test.use({ userAgent: "Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36" });

test("framework footer loads the transparent logo without overflow in either theme", async ({ page }) => {
  await page.goto("/framework", { waitUntil: "domcontentloaded" });
  const footer = page.locator("footer");
  await footer.scrollIntoViewIfNeeded();
  for (const isDark of [false, true]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), isDark);
    const logo = footer.locator(`img[src*="swu-wordmark-${isDark ? "dark" : "light"}"]`);
    await expect(logo).toBeVisible();
    await expect(footer.locator("img:visible")).toHaveCount(1);
    await expect.poll(() => logo.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(288);
    const box = await logo.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThanOrEqual(30);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    await expect(logo).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  }
});
