import { expect, test } from "@playwright/test";

test("console has a skip link and main landmark", async ({ page }) => {
  await page.goto("/console", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Socratic Trade").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#console-main");
  await expect(page.locator("#console-main")).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
});

test("login has a main landmark", async ({ page }) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("main")).toBeVisible();
});
