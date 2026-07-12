import { expect, test } from "@playwright/test";

test("dashboard loads the core trading workspace", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.getByText("Socratic Trade").first()).toBeVisible();
  await expect(page.getByText("Portfolio").first()).toBeVisible();
  await expect(page.getByText("Decision").first()).toBeVisible();
  await expect(page.getByText("Evidence").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Run/i }).first()).toBeVisible();
  // Header kill switch: "Stop" while the system is active, "Start" while halted.
  await expect(page.getByRole("button", { name: /Start|Stop/i }).first()).toBeVisible();
});
